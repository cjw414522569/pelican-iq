"use strict";

require("dotenv").config();

const path = require("node:path");
const express = require("express");

const store = require("./db");
const auth = require("./auth");
const scheduler = require("./scheduler");
const genLog = require("./gen-log");
const { withPreviewCsp } = require("./extract");
const { listModels, testModel } = require("./llm-client");

const PROTOCOLS = new Set(["openai-chat", "openai-responses", "anthropic"]);

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// ---------- 公开 API ----------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    database: true,
    schemaReady: true,
    adminConfigured: auth.isAdminConfigured(),
    models: store.listModels().length,
  });
});

// 画廊：按名称分组（同名模型归为一行，行内可按模型切换；公开接口不含 baseUrl / Key 信息）
app.get("/api/gallery", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 6) || 6, 1), 20);
  const models = store.listModels();

  // 按名称分组（listModels 已按 sort_order 排序，Map 保持组间顺序）
  const groupMap = new Map();
  for (const row of models) {
    if (!groupMap.has(row.name)) groupMap.set(row.name, []);
    groupMap.get(row.name).push(row);
  }

  const groups = [...groupMap.entries()].map(([name, rows]) => {
    const ids = rows.map((row) => row.id);
    const idToModelId = new Map(rows.map((row) => [row.id, row.model_id]));
    const results = store.recentResultsForModels(ids, limit);
    return {
      name,
      total: store.resultCountForModels(ids),
      models: rows.map((row) => ({
        id: row.id,
        modelId: row.model_id,
        protocol: row.protocol,
        thinkingLevel: row.thinking_level,
        intervalMinutes: row.interval_minutes,
        enabled: Boolean(row.enabled),
        nextRunAt: row.next_run_at,
        generating: scheduler.isRunning(row.id),
      })),
      results: results.map((item) => ({
        ...item,
        html: undefined, // 列表不带 html，详情接口按需获取
        modelLabel: idToModelId.get(item.modelConfigId) ?? item.modelName,
        previewUrl: `/api/results/${item.id}/preview`,
      })),
    };
  });

  res.json({ serverTime: new Date().toISOString(), groups });
});

app.get("/api/results/:id", (req, res) => {
  const row = store.getResult(req.params.id);
  if (!row) return res.status(404).json({ error: "样本不存在" });
  res.json(store.publicResult(row));
});

// 人工判断 checklist（公开，勾选即保存）
app.post("/api/results/:id/checklist", (req, res) => {
  const row = store.getResult(req.params.id);
  if (!row) return res.status(404).json({ error: "样本不存在" });
  const checklist = req.body?.checklist;
  if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) {
    return res.status(400).json({ error: "checklist 格式不合法" });
  }
  const saved = store.saveChecklist(req.params.id, checklist);
  res.json({ checklist: saved });
});

// 沙箱预览：注入 CSP 禁外链
app.get("/api/results/:id/preview", (req, res) => {
  const row = store.getResult(req.params.id);
  if (!row || !row.html) {
    return res.status(404).type("text/html").send("<!DOCTYPE html><html><body style=\"font-family:sans-serif;color:#888;display:grid;place-items:center;height:100vh;margin:0\">该样本没有可预览的动画</body></html>");
  }
  res.status(200).type("html").send(withPreviewCsp(row.html));
});

// 当前正在生成的实时内容（公开：提示词为固定标准题，内容为模型输出，不含任何密钥/地址）
app.get("/api/live", (req, res) => {
  const live = genLog.list().filter((entry) => entry.status === "running");
  res.json({ live });
});

// ---------- 管理端 API ----------

app.post("/api/admin/login", (req, res) => {
  if (!auth.isAdminConfigured()) {
    return res.status(500).json({ error: "未配置 ADMIN_PASSWORD 环境变量，无法登录管理后台" });
  }
  if (!auth.checkPassword(req.body?.password)) {
    return res.status(401).json({ error: "口令错误" });
  }
  store.logAdmin("login", "管理登录成功");
  res.setHeader("Set-Cookie", auth.sessionCookie(auth.createToken()));
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", auth.clearCookie());
  res.json({ ok: true });
});

app.get("/api/admin/session", (req, res) => {
  res.json({ authenticated: auth.isAuthenticated(req), adminConfigured: auth.isAdminConfigured() });
});

app.get("/api/admin/models", auth.requireAdmin, (req, res) => {
  res.json({ models: store.listModels().map(store.publicModel) });
});

// 从上游拉取可用模型列表（新增/编辑模型时自动填充，无需手填）。
// 编辑时 apiKey 留空 + 传 id：自动使用该模型已保存的 Key（Key 仍不出服务端）。
app.post("/api/admin/fetch-models", auth.requireAdmin, async (req, res) => {
  let baseUrl = String(req.body?.baseUrl ?? "").trim();
  let apiKey = String(req.body?.apiKey ?? "").trim();
  let protocol = String(req.body?.protocol ?? "").trim();
  const configId = Number(req.body?.id);
  if (!apiKey && Number.isFinite(configId)) {
    const model = store.getModel(configId);
    if (model) {
      apiKey = model.api_key;
      if (!baseUrl) baseUrl = model.base_url;
      if (!protocol || !PROTOCOLS.has(protocol)) protocol = model.protocol;
    }
  }
  if (!PROTOCOLS.has(protocol)) return res.status(400).json({ error: "协议不合法" });
  if (!apiKey) return res.status(400).json({ error: "请先填写 API Key（该模型尚未保存过 Key）" });
  try {
    const { models } = await listModels({ baseUrl, apiKey, protocol });
    store.logAdmin("fetch_models", `拉取模型列表成功（${models.length} 个）`);
    res.json({ models });
  } catch (error) {
    res.status(502).json({ error: error?.message ?? "获取模型列表失败" });
  }
});

// 模型连通性测试：发送一句话，有文本回复即成功（不写入数据库）。
// 编辑时 apiKey 留空 + 传 id：自动使用该模型已保存的 Key。
app.post("/api/admin/test-model", auth.requireAdmin, async (req, res) => {
  let baseUrl = String(req.body?.baseUrl ?? "").trim();
  let apiKey = String(req.body?.apiKey ?? "").trim();
  let protocol = String(req.body?.protocol ?? "").trim();
  let modelId = String(req.body?.modelId ?? "").trim();
  const configId = Number(req.body?.id);
  if (!apiKey && Number.isFinite(configId)) {
    const model = store.getModel(configId);
    if (model) {
      apiKey = model.api_key;
      if (!baseUrl) baseUrl = model.base_url;
      if (!protocol || !PROTOCOLS.has(protocol)) protocol = model.protocol;
      if (!modelId) modelId = model.model_id;
    }
  }
  if (!PROTOCOLS.has(protocol)) return res.status(400).json({ error: "协议不合法" });
  if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: "Base URL 必须以 http(s):// 开头" });
  if (!modelId) return res.status(400).json({ error: "模型 ID 不能为空" });
  if (!apiKey) return res.status(400).json({ error: "请先填写 API Key（该模型尚未保存过 Key）" });
  try {
    const result = await testModel({ baseUrl, apiKey, protocol, model: modelId });
    store.logAdmin("test_model", `测试 ${modelId} -> ${result.ok ? "成功" : `失败：${result.error}`}`);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error?.message ?? "测试失败" });
  }
});

// Base URL 历史（新增模型时下拉选取）
app.get("/api/admin/base-url-history", auth.requireAdmin, (req, res) => {
  res.json({ urls: store.listBaseUrlHistory() });
});

app.delete("/api/admin/base-url-history", auth.requireAdmin, (req, res) => {
  store.deleteBaseUrl(String(req.body?.url ?? ""));
  res.json({ urls: store.listBaseUrlHistory() });
});

// 批量创建：一次提交多个模型 ID（同名归为画廊一组），每个模型独立设置
app.post("/api/admin/models-bulk", auth.requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const items = Array.isArray(req.body?.models) ? req.body.models : [];
  if (!name) return res.status(400).json({ error: "名称（分组）不能为空" });
  if (!items.length) return res.status(400).json({ error: "请至少选择一个模型" });
  // 记录 Base URL 历史，方便下次下拉选取
  store.saveBaseUrl(req.body?.baseUrl);

  const created = [];
  const errors = [];
  for (const item of items) {
    const { errors: itemErrors, value } = store.validateModelInput({
      name,
      protocol: req.body?.protocol,
      baseUrl: req.body?.baseUrl,
      apiKey: req.body?.apiKey,
      modelId: item.modelId,
      promptId: req.body?.promptId,
      thinkingLevel: item.thinkingLevel,
      intervalMinutes: item.intervalMinutes,
      retention: item.retention,
      sortOrder: item.sortOrder,
      enabled: item.enabled,
    });
    if (itemErrors.length) {
      errors.push(`${item.modelId ?? "（空模型 ID）"}：${itemErrors.join("；")}`);
      continue;
    }
    const row = store.createModel(value);
    created.push(store.publicModel(row));
  }
  store.logAdmin("model_bulk_create", `批量新增 ${created.length} 个模型到分组「${name}」${errors.length ? `，${errors.length} 个失败` : ""}`);
  if (!created.length) return res.status(400).json({ error: errors.join("；") });
  res.status(201).json({ created, errors: errors.length ? errors : undefined });
});

app.post("/api/admin/models", auth.requireAdmin, (req, res) => {
  const { errors, value } = store.validateModelInput(req.body ?? {});
  if (errors.length) return res.status(400).json({ error: errors.join("；") });
  store.saveBaseUrl(value.baseUrl); // 记录 Base URL 历史
  const row = store.createModel(value);
  store.logAdmin("model_create", `新增模型 ${row.name}`);
  res.status(201).json({ model: store.publicModel(row) });
});

app.put("/api/admin/models/:id", auth.requireAdmin, (req, res) => {
  const existing = store.getModel(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "模型不存在" });
  const { errors, value } = store.validateModelInput({ ...req.body, apiKey: req.body?.apiKey ?? "" });
  if (errors.length) return res.status(400).json({ error: errors.join("；") });
  // apiKey 为空时保留原 Key
  const row = store.updateModel(existing.id, value, { keepApiKey: !value.apiKey });
  store.logAdmin("model_update", `更新模型 ${row.name}`);
  res.json({ model: store.publicModel(row) });
});

app.delete("/api/admin/models/:id", auth.requireAdmin, (req, res) => {
  const existing = store.getModel(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "模型不存在" });
  store.deleteModel(existing.id);
  store.logAdmin("model_delete", `删除模型 ${existing.name}`);
  res.json({ ok: true });
});

app.post("/api/admin/models/:id/run", auth.requireAdmin, (req, res) => {
  const existing = store.getModel(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "模型不存在" });
  if (scheduler.isRunning(existing.id)) {
    return res.status(409).json({ error: "该模型正在生成中，请稍候" });
  }
  store.logAdmin("model_run", `手动触发 ${existing.name}`);
  // 异步执行，立即返回
  void scheduler.runModel(existing).then((outcome) => {
    const summary = outcome.skipped ? "跳过（运行中）" : outcome.ok ? "成功" : `失败：${outcome.error ?? "未知错误"}`;
    console.log(`[manual] ${existing.name} -> ${summary}`);
  }).catch((error) => {
    console.error(`[manual] ${existing.name} 异常:`, error?.message ?? error);
  });
  res.status(202).json({ ok: true, message: "已触发生成，稍后刷新查看结果" });
});

// 生成日志（内存环形缓冲，最新 50 条，含实时流式内容）
app.get("/api/admin/gen-logs", auth.requireAdmin, (req, res) => {
  res.json({ logs: genLog.list() });
});

// 提示词管理（CRUD）
app.get("/api/admin/prompts", auth.requireAdmin, (req, res) => {
  res.json({ prompts: store.listPrompts() });
});

app.post("/api/admin/prompts", auth.requireAdmin, (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const content = String(req.body?.content ?? "").trim();
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  if (!content) return res.status(400).json({ error: "提示词内容不能为空" });
  if (name.length > 64) return res.status(400).json({ error: "名称最长 64 字符" });
  if (content.length > 5000) return res.status(400).json({ error: "内容最长 5000 字符" });
  const row = store.createPrompt({ name, content, isDefault: req.body?.isDefault === true });
  store.logAdmin("prompt_create", `新增提示词「${name}」`);
  res.status(201).json({ prompt: { id: row.id, name: row.name, content: row.content, isDefault: Boolean(row.is_default) } });
});

app.put("/api/admin/prompts/:id", auth.requireAdmin, (req, res) => {
  const existing = store.getPrompt(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "提示词不存在" });
  const name = String(req.body?.name ?? existing.name).trim();
  const content = String(req.body?.content ?? existing.content).trim();
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  if (!content) return res.status(400).json({ error: "提示词内容不能为空" });
  const row = store.updatePrompt(existing.id, { name, content, isDefault: req.body?.isDefault === true });
  store.logAdmin("prompt_update", `更新提示词「${name}」`);
  res.json({ prompt: { id: row.id, name: row.name, content: row.content, isDefault: Boolean(row.is_default) } });
});

app.delete("/api/admin/prompts/:id", auth.requireAdmin, (req, res) => {
  const existing = store.getPrompt(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "提示词不存在" });
  if (existing.is_default) return res.status(400).json({ error: "不能删除默认提示词" });
  store.deletePrompt(existing.id);
  store.logAdmin("prompt_delete", `删除提示词「${existing.name}」`);
  res.json({ ok: true });
});

// 批量更新分组：设置组下所有模型的思考强度/间隔/保留 + 组的排序
app.put("/api/admin/models-group", auth.requireAdmin, (req, res) => {
  const groupName = String(req.body?.groupName ?? "").trim();
  if (!groupName) return res.status(400).json({ error: "分组名不能为空" });
  const models = store.listModels().filter((m) => m.name === groupName);
  if (!models.length) return res.status(404).json({ error: "分组不存在" });

  const thinkingLevel = req.body?.thinkingLevel;
  const intervalMinutes = Number(req.body?.intervalMinutes);
  const retention = Number(req.body?.retention);
  const sortOrder = Number(req.body?.sortOrder);
  const enabled = req.body?.enabled;

  const errors = [];
  if (thinkingLevel !== undefined && thinkingLevel !== "" && !["off", "low", "medium", "high", "max"].includes(thinkingLevel)) {
    errors.push("思考强度不合法");
  }
  if (intervalMinutes !== undefined && !Number.isNaN(intervalMinutes) && (intervalMinutes < 1 || intervalMinutes > 10080)) {
    errors.push("生成间隔需为 1–10080 分钟");
  }
  if (retention !== undefined && !Number.isNaN(retention) && (retention < 1 || retention > 500)) {
    errors.push("保留样本数需为 1–500");
  }
  if (errors.length) return res.status(400).json({ error: errors.join("；") });

  let updated = 0;
  for (const model of models) {
    const value = {
      name: model.name,
      protocol: model.protocol,
      baseUrl: model.base_url,
      apiKey: model.api_key,
      modelId: model.model_id,
      thinkingLevel: thinkingLevel !== undefined && thinkingLevel !== "" ? thinkingLevel : model.thinking_level,
      intervalMinutes: !Number.isNaN(intervalMinutes) && intervalMinutes > 0 ? Math.round(intervalMinutes) : model.interval_minutes,
      retention: !Number.isNaN(retention) && retention > 0 ? Math.round(retention) : (model.retention ?? 10),
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : model.enabled,
      sortOrder: !Number.isNaN(sortOrder) ? sortOrder : model.sort_order,
    };
    store.updateModel(model.id, value, { keepApiKey: true });
    updated += 1;
  }
  store.logAdmin("model_group_update", `批量更新分组「${groupName}」的 ${updated} 个模型`);
  res.json({ updated, models: models.map((m) => store.publicModel(store.getModel(m.id))) });
});

app.get("/api/admin/overview", auth.requireAdmin, (req, res) => {
  const stats = store.statsByModel().map((row) => ({
    id: row.id,
    name: row.name,
    modelId: row.model_id,
    samples: row.samples,
    successCount: row.success_count ?? 0,
    failedCount: row.failed_count ?? 0,
    avgDurationMs: row.avg_duration_ms != null ? Math.round(row.avg_duration_ms) : null,
    avgTotalTokens: row.avg_total_tokens != null ? Math.round(row.avg_total_tokens) : null,
  }));
  res.json({ stats });
});

// ---------- 静态文件 ----------

app.use(express.static(path.join(__dirname, "..", "public")));

// 兜底：SPA 路径
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error("[server]", error?.message ?? error);
  res.status(500).json({ error: "服务器内部错误" });
});

app.listen(PORT, () => {
  console.log(`[server] 模型鹈鹕智商对比平台已启动: http://localhost:${PORT}`);
  console.log(`[server] 管理后台: http://localhost:${PORT}/admin`);
  scheduler.start();
});
