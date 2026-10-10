"use strict";

// 移植自 PelicanBench src/lib/llm-client.ts，改为 Node.js 服务端直连（无浏览器中转）。

const { STANDARD_PROMPT } = require("./prompt");
const { extractHtml, findExternalRefs } = require("./extract");

const PROTOCOL_PATHS = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  anthropic: "/v1/messages",
};

function buildEndpoint(baseUrl, protocol) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Base URL 不是合法地址" };
  }
  let path = PROTOCOL_PATHS[protocol];
  if (protocol === "anthropic") {
    // anthropic 默认 base 形如 https://api.anthropic.com，路径含 /v1
    if (/\/v\d+\/?$/.test(trimmed)) path = "/messages";
  } else if (/\/v\d+\/?$/.test(trimmed)) {
    path = path; // base 已含版本号
  }
  // 若 baseUrl 已带完整路径（如 .../chat/completions），直接使用
  if (new RegExp(`${path.replace(/\//g, "\\/")}$`).test(trimmed)) {
    return { href: trimmed };
  }
  return { href: trimmed + path };
}

function buildAuthHeaders(protocol, apiKey) {
  if (protocol === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

function buildPayload(protocol, model, thinking, options = {}) {
  // 思考型模型（如 GLM）的推理 token 计入 max_tokens，上限需覆盖「思考 + 正文」
  const outputCap = options.outputCap ?? 32000;
  if (protocol === "openai-chat") {
    const body = {
      model,
      messages: [{ role: "user", content: STANDARD_PROMPT }],
      [options.tokenField ?? "max_tokens"]: outputCap,
    };
    if (thinking !== "off") body.reasoning_effort = thinking === "max" ? "max" : thinking;
    return body;
  }
  if (protocol === "openai-responses") {
    const body = { model, input: STANDARD_PROMPT, max_output_tokens: outputCap };
    if (options.includeStore !== false) body.store = false;
    if (thinking !== "off") body.reasoning = { effort: thinking === "max" ? "max" : thinking };
    return body;
  }
  const budget = thinking === "low" ? 1024 : thinking === "medium" ? 4096 : thinking === "high" ? 12000 : thinking === "max" ? 32000 : 0;
  const body = {
    model,
    max_tokens: thinking === "off" ? 16000 : Math.min(64000, budget + 16000),
    temperature: 1,
    messages: [{ role: "user", content: STANDARD_PROMPT }],
  };
  if (thinking !== "off") body.thinking = { type: "enabled", budget_tokens: budget };
  return body;
}

function redact(text, apiKey) {
  if (!apiKey) return String(text ?? "");
  return String(text ?? "").split(apiKey).join("***");
}

function errorMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  const record = data;
  const nested = record.error;
  if (typeof nested === "string" && nested.trim()) return nested;
  if (nested && typeof nested === "object") {
    const message = nested.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  return fallback;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageFrom(data, protocol) {
  const empty = { inputTokens: null, outputTokens: null, totalTokens: null };
  if (!data || typeof data !== "object") return empty;
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return empty;
  if (protocol === "anthropic") {
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    return { inputTokens: input, outputTokens: output, totalTokens: input != null && output != null ? input + output : null };
  }
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens);
  return { inputTokens: input, outputTokens: output, totalTokens: num(usage.total_tokens) ?? (input != null && output != null ? input + output : null) };
}

function textFrom(data, protocol) {
  const thinking = [];
  const parts = [];
  if (!data || typeof data !== "object") return { text: "", thinking: null };
  const record = data;
  if (protocol === "openai-responses") {
    if (typeof record.output_text === "string") parts.push(record.output_text);
    const output = Array.isArray(record.output) ? record.output : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") parts.push(block.text);
      }
    }
  } else if (protocol === "anthropic") {
    const content = Array.isArray(record.content) ? record.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  } else {
    const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const message = choice && typeof choice === "object" ? choice.message : undefined;
    const content = message?.content;
    if (typeof content === "string") parts.push(content);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") parts.push(block);
        else if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
      }
    }
    if (message && typeof message.reasoning_content === "string") thinking.push(message.reasoning_content);
  }
  return { text: parts.join("\n").trim(), thinking: thinking.join("\n").trim() || null };
}

function shouldRetry(message, protocol, attempt) {
  const lower = message.toLowerCase();
  if (protocol === "openai-chat" && attempt.tokenField === "max_tokens" && (lower.includes("max_completion_tokens") || (lower.includes("max_tokens") && lower.includes("not supported")) || lower.includes("unsupported parameter"))) {
    return { tokenField: "max_completion_tokens", includeStore: attempt.includeStore };
  }
  if (protocol === "openai-responses" && attempt.includeStore && lower.includes("store")) {
    return { tokenField: attempt.tokenField, includeStore: false };
  }
  return null;
}

// ---------- SSE 流式支持 ----------
// 流式响应中数据持续流动，可绕过网关（nginx）对长时间无数据连接的空闲超时（502/503/504）。

const preferStream = new Map(); // "endpoint|model" -> true：该模型曾通过流式成功，后续直接走流式
const noStream = new Map(); // "endpoint|model" -> true：该网关不支持流式，退回非流式

function createStreamCollector(protocol, onDelta) {
  const textParts = [];
  const thinkingParts = [];
  let usage = null;
  const handlePayload = (payload) => {
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (!chunk || typeof chunk !== "object") return;
    let deltaText = "";
    let deltaThinking = "";
    if (protocol === "openai-chat") {
      // 兼容两种流式块格式：标准 delta 增量，以及部分网关整段下发的 message
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      const delta = choice?.delta;
      const message = choice?.message;
      if (typeof delta?.content === "string") { textParts.push(delta.content); deltaText += delta.content; }
      if (typeof delta?.reasoning_content === "string") { thinkingParts.push(delta.reasoning_content); deltaThinking += delta.reasoning_content; }
      if (typeof message?.content === "string" && message.content) { textParts.push(message.content); deltaText += message.content; }
      if (typeof message?.reasoning_content === "string" && message.reasoning_content) { thinkingParts.push(message.reasoning_content); deltaThinking += message.reasoning_content; }
      if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    } else if (protocol === "anthropic") {
      if (chunk.type === "content_block_delta") {
        if (chunk.delta?.type === "text_delta" && typeof chunk.delta.text === "string") { textParts.push(chunk.delta.text); deltaText += chunk.delta.text; }
        if (chunk.delta?.type === "thinking_delta" && typeof chunk.delta.thinking === "string") { thinkingParts.push(chunk.delta.thinking); deltaThinking += chunk.delta.thinking; }
      } else if (chunk.type === "message_start" && chunk.message?.usage) {
        usage = { ...chunk.message.usage };
      } else if (chunk.type === "message_delta" && chunk.usage) {
        usage = { ...(usage ?? {}), output_tokens: chunk.usage.output_tokens ?? usage?.output_tokens };
      }
    } else { // openai-responses
      if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") { textParts.push(chunk.delta); deltaText += chunk.delta; }
      if (chunk.type === "response.completed" && chunk.response?.usage) usage = chunk.response.usage;
    }
    if (onDelta && (deltaText || deltaThinking)) onDelta({ text: deltaText || undefined, thinking: deltaThinking || undefined });
  };
  return {
    handleLine(line) {
      const trimmed = String(line ?? "").replace(/\r$/, "");
      if (!trimmed.startsWith("data:")) return;
      handlePayload(trimmed.slice(5).trim());
    },
    result() {
      // 注意：思考增量与正文增量一样是连续文本，必须用空串拼接（用换行拼接会把每个 token 断开）
      return { text: textParts.join(""), thinking: thinkingParts.join(""), usage };
    },
  };
}

async function readStream(response, protocol, onDelta) {
  const collector = createStreamCollector(protocol, onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      collector.handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer) collector.handleLine(buffer);
  return collector.result();
}

function parseSseText(text, protocol, onDelta) {
  const collector = createStreamCollector(protocol, onDelta);
  for (const line of String(text).split("\n")) collector.handleLine(line);
  return collector.result();
}

// 组装失败排查用的内容节选：思考 + 正文（截断）
function buildRawExcerpt(streamResult) {
  const parts = [];
  if (streamResult.thinking) parts.push(`【思考 ${streamResult.thinking.length} 字符】\n${streamResult.thinking.slice(0, 1500)}`);
  if (streamResult.text) parts.push(`【正文 ${streamResult.text.length} 字符】\n${streamResult.text.slice(0, 2000)}`);
  return parts.join("\n\n") || "（流式未收到任何文本）";
}

// 把流式收集结果重组为非流式响应结构，复用 textFrom / usageFrom 解析
function rebuildParsed(streamResult, protocol) {
  if (protocol === "anthropic") {
    const content = [];
    if (streamResult.thinking) content.push({ type: "thinking", thinking: streamResult.thinking });
    if (streamResult.text) content.push({ type: "text", text: streamResult.text });
    return { content, usage: streamResult.usage ?? undefined };
  }
  if (protocol === "openai-responses") {
    return {
      output_text: streamResult.text,
      output: streamResult.text ? [{ content: [{ text: streamResult.text }] }] : [],
      usage: streamResult.usage ?? undefined,
    };
  }
  const message = { content: streamResult.text };
  if (streamResult.thinking) message.reasoning_content = streamResult.thinking;
  return { choices: [{ message }], usage: streamResult.usage ?? undefined };
}

/**
 * 执行一次生成挑战。
 * @param {{baseUrl:string, apiKey:string, protocol:string, model:string, thinking:string, timeoutMs?:number}} options
 */
async function runBench(options) {
  const started = Date.now();
  const base = {
    ok: false, html: null, raw: "", thinkingText: null, fromFence: false,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    durationMs: 0, endpoint: "", externalRefs: [], viaStream: false,
  };
  const endpoint = buildEndpoint(options.baseUrl, options.protocol);
  if ("error" in endpoint) return { ...base, error: endpoint.error };
  if (!options.apiKey.trim()) return { ...base, error: "该模型未配置 API Key" };
  if (!options.model.trim()) return { ...base, error: "该模型未配置模型 ID" };

  let attempt = { tokenField: "max_tokens", includeStore: true };
  let lastText = "";
  let lastStatus = 0;
  // 总超时：思考型模型可能先推理数分钟再输出，默认 10 分钟，可用 GENERATION_TIMEOUT_MS 调整
  const envTimeout = Number(process.env.GENERATION_TIMEOUT_MS);
  const timeout = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout >= 10000 ? envTimeout : 600000);
  const timeoutHint = `生成超时（${Math.round(timeout / 1000)}s，可通过环境变量 GENERATION_TIMEOUT_MS 调整）`;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeout);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
  };
  const streamKey = `${endpoint.href}|${options.model.trim()}`;
  // openai-chat 默认直接走流式（绕过网关空闲超时）；已知不支持的网关退回非流式。
  // anthropic / openai-responses 保持智能切换：非流式优先，遇 502/503/504 再切流式。
  let useStream = preferStream.get(streamKey) === true
    || (options.protocol === "openai-chat" && !noStream.has(streamKey));
  let streamOptions = true; // openai-chat: stream_options.include_usage

  try {
    let paramRetried = false;
    let capRetried = false; // max_tokens 超限已降档
    let gatewaySwitched = false; // 已因网关超时切换到流式
    let streamFellBack = false; // 流式不被支持，已退回非流式
    for (let i = 0; i < 6; i += 1) {
      const payload = buildPayload(options.protocol, options.model.trim(), options.thinking, attempt);
      if (useStream) {
        payload.stream = true;
        if (options.protocol === "openai-chat" && streamOptions) payload.stream_options = { include_usage: true };
      }
      let response;
      try {
        response = await fetch(endpoint.href, {
          method: "POST",
          headers: buildAuthHeaders(options.protocol, options.apiKey.trim()),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        return {
          ...base,
          durationMs: Date.now() - started,
          error: aborted ? timeoutHint : redact(error?.message ?? "网络请求失败", options.apiKey),
        };
      }
      lastStatus = response.status;
      const contentType = response.headers.get("content-type") || "";

      let parsed = null;
      let viaStream = false;
      if (response.ok && useStream && contentType.includes("text/event-stream")) {
        // 真·SSE 流：逐块读取（数据持续流动，网关不会空闲超时）
        try {
          const streamResult = await readStream(response, options.protocol, options.onDelta);
          // 超时中断可能表现为流被截断而非读取异常
          if (controller.signal.aborted) {
            return { ...base, durationMs: Date.now() - started, error: timeoutHint };
          }
          parsed = rebuildParsed(streamResult, options.protocol);
          viaStream = true;
          preferStream.set(streamKey, true);
          noStream.delete(streamKey);
          // 保存实际收到的内容（节选），失败时可查看
          lastText = buildRawExcerpt(streamResult);
        } catch (error) {
          const aborted = controller.signal.aborted;
          return {
            ...base,
            durationMs: Date.now() - started,
            error: aborted ? timeoutHint : redact(error?.message ?? "流式读取失败", options.apiKey),
          };
        }
      } else {
        lastText = await response.text();
        if (controller.signal.aborted) {
          return { ...base, durationMs: Date.now() - started, error: timeoutHint };
        }
        if (response.ok && useStream && /^data:/m.test(lastText)) {
          // 网关返回了 SSE 但 Content-Type 不标准：按 SSE 文本解析
          const streamResult = parseSseText(lastText, options.protocol, options.onDelta);
          parsed = rebuildParsed(streamResult, options.protocol);
          viaStream = true;
          preferStream.set(streamKey, true);
          noStream.delete(streamKey);
        } else {
          try { parsed = JSON.parse(lastText); } catch { /* 部分网关直接返回 HTML */ }
        }
      }

      if (response.status >= 400) {
        // 优先取 JSON 错误信息；HTML 错误页（如 nginx 504）只提取标题，避免整页 HTML 进库
        let message = "";
        if (parsed) message = errorMessage(parsed, "");
        if (!message) {
          const title = lastText.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
          message = title ? `上游网关错误 ${response.status}（${title}）` : `上游返回 ${response.status}`;
        }
        message = redact(message, options.apiKey);
        // 参数不兼容重试（仅第一轮非流式）
        const next = shouldRetry(message, options.protocol, attempt);
        if (next && !paramRetried && !useStream) { paramRetried = true; attempt = next; continue; }
        // 网关超时（502/503/504）：切换流式重试——流式可绕过网关空闲超时；
        // 重置计时器，让流式拿到完整的超时时间窗（非流式等待已消耗的部分不再计入）
        if ((response.status === 502 || response.status === 503 || response.status === 504) && !useStream && !gatewaySwitched) {
          gatewaySwitched = true;
          useStream = true;
          resetTimer();
          continue;
        }
        // stream_options 参数不被支持：去掉后重试
        if (response.status === 400 && useStream && streamOptions && /stream_options/i.test(message)) {
          streamOptions = false;
          continue;
        }
        // max_tokens 超出模型上限：降档到 16000 重试一次
        if (response.status === 400 && !capRetried && /max_tokens|max_completion_tokens/i.test(message)
            && /exceed|limit|too large|maximum|greater|invalid|range/i.test(message)) {
          capRetried = true;
          attempt = { ...attempt, outputCap: 16000 };
          continue;
        }
        // 流式整体不被支持：退回非流式并记住该网关（后续不再默认流式）
        if (response.status === 400 && useStream && !streamFellBack && /stream/i.test(message)) {
          streamFellBack = true;
          useStream = false;
          preferStream.delete(streamKey);
          noStream.set(streamKey, true);
          continue;
        }
        return {
          ...base, raw: redact(lastText.slice(0, 2000), options.apiKey), usage: usageFrom(parsed, options.protocol),
          durationMs: Date.now() - started, endpoint: endpoint.href, status: response.status, error: message,
        };
      }

      const { text, thinking } = textFrom(parsed, options.protocol);
      // 非流式路径：一次性把全文交给回调（流式路径已在 readStream 中逐块回调）
      if (options.onDelta && !viaStream && (text || thinking)) {
        options.onDelta({ text: text || undefined, thinking: thinking || undefined });
      }
      // 提取 HTML：优先正文；正文没有时尝试思考内容（部分思考型模型把答案放进 reasoning）
      let extracted = extractHtml(text || lastText);
      if (!extracted.html && thinking) extracted = extractHtml(thinking);
      // 失败时给出可诊断的错误信息
      const noHtmlError = extracted.html ? undefined : (() => {
        const parts = [extracted.reason];
        parts.push(`收到正文 ${text.length} 字符`);
        if (thinking) parts.push(`思考 ${thinking.length} 字符`);
        if (viaStream) parts.push("（流式）");
        return parts.join("，");
      })();
      return {
        ...base,
        ok: Boolean(extracted.html),
        html: extracted.html,
        raw: redact(lastText, options.apiKey),
        thinkingText: thinking,
        fromFence: extracted.fromFence,
        usage: usageFrom(parsed, options.protocol),
        durationMs: Date.now() - started,
        endpoint: endpoint.href,
        status: response.status,
        viaStream,
        error: noHtmlError,
        externalRefs: extracted.html ? findExternalRefs(extracted.html) : [],
      };
    }
    return { ...base, raw: redact(lastText, options.apiKey), durationMs: Date.now() - started, endpoint: endpoint.href, status: lastStatus, error: "请求失败" };
  } catch (error) {
    // 兜底：读取响应体等阶段被超时中断（AbortError）或其他异常
    const aborted = controller.signal.aborted || error?.name === "AbortError";
    return {
      ...base,
      durationMs: Date.now() - started,
      error: aborted ? timeoutHint : redact(error?.message ?? "请求失败", options.apiKey),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelIds(data) {
  const ids = new Set();
  const push = (value) => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
    if (value && typeof value === "object" && typeof value.id === "string") ids.add(value.id);
  };
  if (Array.isArray(data)) data.forEach(push);
  if (data && typeof data === "object") {
    if (Array.isArray(data.data)) data.data.forEach(push);
    if (Array.isArray(data.models)) data.models.forEach(push);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * 拉取上游模型列表（GET {base}/models）。
 * @param {{baseUrl:string, apiKey:string, protocol:string, timeoutMs?:number}} options
 */
async function listModels(options) {
  const trimmed = String(options.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("Base URL 必须以 http(s):// 开头");
  if (!options.apiKey.trim()) throw new Error("请先填写 API Key");
  // /models 端点对三种协议通用；Anthropic 官方路径为 /v1/models（base 未带版本号时补 /v1）
  let url;
  if (/\/models$/i.test(trimmed)) {
    url = trimmed;
  } else if (options.protocol === "anthropic" && !/\/v\d+$/i.test(trimmed)) {
    url = `${trimmed}/v1/models`;
  } else {
    url = `${trimmed}/models`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildAuthHeaders(options.protocol, options.apiKey.trim()),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 下方统一报错 */ }
    if (response.status >= 400) {
      throw new Error(redact(errorMessage(parsed, text.slice(0, 400) || `模型列表返回 ${response.status}`), options.apiKey));
    }
    const models = parseModelIds(parsed);
    if (!models.length) throw new Error("接口没有返回可用的模型 id");
    return { models, endpoint: url };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("获取模型列表超时");
    throw new Error(redact(error?.message ?? "网络请求失败", options.apiKey));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连通性测试：向模型发送一句话，有文本回复即成功（不写入数据库）。
 * @param {{baseUrl:string, apiKey:string, protocol:string, model:string, timeoutMs?:number}} options
 */
async function testModel(options) {
  const started = Date.now();
  const result = (extra) => ({ ok: false, reply: null, durationMs: Date.now() - started, ...extra });
  const endpoint = buildEndpoint(options.baseUrl, options.protocol);
  if ("error" in endpoint) return result({ error: endpoint.error });
  if (!options.apiKey.trim()) return result({ error: "该模型未配置 API Key" });
  if (!options.model.trim()) return result({ error: "该模型未配置模型 ID" });

  const message = "连接测试：请回复「收到」两个字。";
  let body;
  if (options.protocol === "openai-chat") {
    body = { model: options.model.trim(), messages: [{ role: "user", content: message }], max_tokens: 32 };
  } else if (options.protocol === "openai-responses") {
    body = { model: options.model.trim(), input: message, max_output_tokens: 32 };
  } else {
    body = { model: options.model.trim(), max_tokens: 32, messages: [{ role: "user", content: message }] };
  }

  const timeout = options.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(endpoint.href, {
      method: "POST",
      headers: buildAuthHeaders(options.protocol, options.apiKey.trim()),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 网关可能返回 HTML */ }
    if (response.status >= 400) {
      let message = "";
      if (parsed) message = errorMessage(parsed, "");
      if (!message) {
        const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
        message = title ? `上游网关错误 ${response.status}（${title}）` : `上游返回 ${response.status}`;
      }
      return result({ error: redact(message, options.apiKey), status: response.status });
    }
    const { text: reply, thinking: replyThinking } = textFrom(parsed, options.protocol);
    // 思考型模型可能 content 为空而 reasoning_content 有内容
    const content = (reply || "").trim();
    const thinkingText = (replyThinking || "").trim();
    if (content) {
      return { ok: true, reply: content.slice(0, 200), durationMs: Date.now() - started, status: response.status };
    }
    if (thinkingText) {
      return { ok: true, reply: `（思考型回复，节选）${thinkingText.slice(0, 120)}`, durationMs: Date.now() - started, status: response.status };
    }
    if (parsed) {
      return { ok: true, reply: "（接口连通正常，模型返回了空回复）", durationMs: Date.now() - started, status: response.status };
    }
    return result({ error: "接口返回了响应但没有文本内容", status: response.status });
  } catch (error) {
    if (controller.signal.aborted) return result({ error: `测试超时（${Math.round(timeout / 1000)}s）` });
    return result({ error: redact(error?.message ?? "网络请求失败", options.apiKey) });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runBench, listModels, testModel, buildPayload, buildEndpoint, buildAuthHeaders, usageFrom, textFrom, extractHtml, findExternalRefs, redact };
