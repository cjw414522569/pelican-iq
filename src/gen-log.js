"use strict";

/**
 * 生成日志（内存环形缓冲，只保留最新 50 条，重启后清空）。
 * 每条日志对应一次生成：记录提示词、流式累积的生成内容（正文 + 思考）、结果状态。
 * 供后台「生成日志」视图实时展示。
 */

const MAX_ENTRIES = 50;
const MAX_CONTENT_CHARS = 20000; // 单条内容上限，防内存膨胀

const entries = [];
let seqCounter = 0;

function find(id) {
  return entries.find((entry) => entry.id === id);
}

/** 一次生成开始：返回日志 id。 */
function start({ model, protocol, prompt, modelConfigId }) {
  seqCounter += 1;
  const entry = {
    id: `gen-${seqCounter}`,
    seq: seqCounter,
    startedAt: new Date().toISOString(),
    model,
    protocol,
    modelConfigId: modelConfigId ?? null,
    prompt: String(prompt ?? ""),
    status: "running",
    content: "",
    thinking: "",
    error: null,
    durationMs: null,
    tokens: null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return entry.id;
}

/** 流式增量：追加正文 / 思考内容。 */
function append(id, delta) {
  const entry = find(id);
  if (!entry || !delta) return;
  if (delta.text) entry.content = (entry.content + delta.text).slice(-MAX_CONTENT_CHARS);
  if (delta.thinking) entry.thinking = (entry.thinking + delta.thinking).slice(-MAX_CONTENT_CHARS);
}

/** 一次生成结束。 */
function finish(id, { ok, error, durationMs, tokens }) {
  const entry = find(id);
  if (!entry) return;
  entry.status = ok ? "success" : "failed";
  entry.error = error ?? null;
  entry.durationMs = durationMs ?? null;
  entry.tokens = tokens ?? null;
}

/** 序列化（内容只带尾部节选，控制轮询体积）。 */
function serialize(entry) {
  return {
    id: entry.id,
    seq: entry.seq,
    startedAt: entry.startedAt,
    model: entry.model,
    protocol: entry.protocol,
    modelConfigId: entry.modelConfigId,
    status: entry.status,
    error: entry.error,
    durationMs: entry.durationMs,
    tokens: entry.tokens,
    prompt: entry.prompt,
    contentTail: entry.content.slice(-1500),
    contentLength: entry.content.length,
    thinkingTail: entry.thinking.slice(-800),
    thinkingLength: entry.thinking.length,
  };
}

/** 最新在前。 */
function list() {
  return [...entries].reverse().map(serialize);
}

module.exports = { start, append, finish, list };
