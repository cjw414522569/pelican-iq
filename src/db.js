"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "pelican-iq.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL DEFAULT 'off',
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  retention INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);
CREATE INDEX IF NOT EXISTS idx_models_next_run ON models(next_run_at);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  model_config_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  prompt TEXT NOT NULL,
  html TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success',
  error TEXT,
  external_refs TEXT,
  raw_excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_results_model ON results(model_config_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '匿名',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_result ON comments(result_id, created_at ASC);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS base_url_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- helpers ----------

// 迁移：为旧库补充 retention 列（每模型保留样本数，默认 10）
{
  const columns = db.prepare("PRAGMA table_info(models)").all().map((col) => col.name);
  if (!columns.includes("retention")) {
    db.exec("ALTER TABLE models ADD COLUMN retention INTEGER NOT NULL DEFAULT 10");
  }
}
// 迁移：为旧库补充 raw_excerpt 列（失败时保存收到内容的节选，便于排查）
{
  const columns = db.prepare("PRAGMA table_info(results)").all().map((col) => col.name);
  if (!columns.includes("raw_excerpt")) {
    db.exec("ALTER TABLE results ADD COLUMN raw_excerpt TEXT");
  }
}
// 迁移：为旧库补充 checklist 列（人工判断，JSON：{itemId: true/false}）
{
  const columns = db.prepare("PRAGMA table_info(results)").all().map((col) => col.name);
  if (!columns.includes("checklist")) {
    db.exec("ALTER TABLE results ADD COLUMN checklist TEXT");
  }
}
// 迁移：为旧库补充 prompt_id 列（模型使用的自定义提示词）
{
  const columns = db.prepare("PRAGMA table_info(models)").all().map((col) => col.name);
  if (!columns.includes("prompt_id")) {
    db.exec("ALTER TABLE models ADD COLUMN prompt_id INTEGER REFERENCES prompts(id) ON DELETE SET NULL");
  }
}
// 迁移：写入默认提示词（首次）
{
  const { STANDARD_PROMPT } = require("./prompt");
  const count = db.prepare("SELECT COUNT(*) AS n FROM prompts").get().n;
  if (count === 0) {
    db.prepare("INSERT INTO prompts (name, content, is_default) VALUES (?, ?, 1)").run("鹈鹕骑自行车", STANDARD_PROMPT);
  }
}

function newId() {
  return crypto.randomUUID();
}

function maskApiKey(key) {
  if (!key) return "";
  const trimmed = key.trim();
  // 短 Key 只露尾 2 位，避免泄露过多；长 Key 露首 4 + 尾 4
  if (trimmed.length <= 12) return `***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

const PROTOCOLS = new Set(["openai-chat", "openai-responses", "anthropic"]);
const THINKING = new Set(["off", "low", "medium", "high", "max"]);
const { CHECKLIST } = require("./reference-html");
const { STANDARD_PROMPT } = require("./prompt");
const CHECKLIST_IDS = CHECKLIST.map((item) => item.id);

function validateModelInput(input) {
  const errors = [];
  const name = String(input.name ?? "").trim();
  const protocol = String(input.protocol ?? "").trim();
  const baseUrl = String(input.baseUrl ?? "").trim();
  const modelId = String(input.modelId ?? "").trim();
  const thinkingLevel = String(input.thinkingLevel ?? "off").trim();
  const intervalMinutes = Number(input.intervalMinutes ?? 60);
  const retention = Number(input.retention ?? 10);

  if (!name) errors.push("名称不能为空");
  if (name.length > 64) errors.push("名称最长 64 字符");
  if (!PROTOCOLS.has(protocol)) errors.push("协议不合法");
  if (!/^https?:\/\//i.test(baseUrl)) errors.push("Base URL 必须以 http(s):// 开头");
  if (baseUrl.length > 500) errors.push("Base URL 最长 500 字符");
  if (!modelId) errors.push("模型 ID 不能为空");
  if (modelId.length > 128) errors.push("模型 ID 最长 128 字符");
  if (!THINKING.has(thinkingLevel)) errors.push("思考强度不合法");
  if (String(input.apiKey ?? "").length > 256) errors.push("API Key 最长 256 字符");
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) {
    errors.push("生成间隔需为 1–10080 分钟");
  }
  if (!Number.isFinite(retention) || retention < 1 || retention > 500) {
    errors.push("保留样本数需为 1–500");
  }

  return {
    errors,
    value: {
      name,
      protocol,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: String(input.apiKey ?? "").trim(),
      modelId,
      thinkingLevel,
      intervalMinutes: Math.round(intervalMinutes),
      retention: Math.round(retention),
      enabled: input.enabled === undefined ? 1 : (input.enabled ? 1 : 0),
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
      promptId: input.promptId ? Number(input.promptId) : null,
    },
  };
}

// ---------- models ----------

function publicModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    apiKeyMask: maskApiKey(row.api_key),
    hasKey: Boolean(row.api_key),
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    intervalMinutes: row.interval_minutes,
    retention: row.retention ?? 10,
    promptId: row.prompt_id ?? null,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

function listModels() {
  return db.prepare("SELECT * FROM models ORDER BY sort_order ASC, id ASC").all();
}

function getModel(id) {
  return db.prepare("SELECT * FROM models WHERE id = ?").get(id);
}

function createModel(value) {
  const info = db.prepare(`
    INSERT INTO models (name, protocol, base_url, api_key, model_id, thinking_level, interval_minutes, retention, enabled, sort_order, prompt_id, next_run_at)
    VALUES (@name, @protocol, @baseUrl, @apiKey, @modelId, @thinkingLevel, @intervalMinutes, @retention, @enabled, @sortOrder, @promptId, datetime('now'))
  `).run(value);
  return getModel(info.lastInsertRowid);
}

function updateModel(id, value, { keepApiKey } = {}) {
  const existing = getModel(id);
  if (!existing) return null;
  const apiKey = value.apiKey || keepApiKey ? (value.apiKey || existing.api_key) : "";
  db.prepare(`
    UPDATE models SET name=@name, protocol=@protocol, base_url=@baseUrl, api_key=@apiKey,
      model_id=@modelId, thinking_level=@thinkingLevel, interval_minutes=@intervalMinutes,
      retention=@retention, enabled=@enabled, sort_order=@sortOrder, prompt_id=@promptId
    WHERE id=@id
  `).run({ ...value, apiKey, id });
  const updated = getModel(id);
  // 保留数调小后立即裁剪
  pruneResults(id, updated.retention);
  return updated;
}

function deleteModel(id) {
  const info = db.prepare("DELETE FROM models WHERE id = ?").run(id);
  return info.changes > 0;
}

function markRun(id, { nextRunAt }) {
  db.prepare("UPDATE models SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?").run(nextRunAt, id);
}

function dueModels(nowIso) {
  return db.prepare("SELECT * FROM models WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC").all(nowIso);
}

// ---------- results ----------

function insertResult({ modelConfigId, modelName, protocol, thinkingLevel, prompt, html, usage, durationMs, status, error, externalRefs, rawExcerpt }) {
  const id = newId();
  db.prepare(`
    INSERT INTO results (id, model_config_id, model_name, protocol, thinking_level, prompt, html,
      input_tokens, output_tokens, total_tokens, duration_ms, status, error, external_refs, raw_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, modelConfigId, modelName, protocol, thinkingLevel, prompt, html ?? null,
    usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null,
    durationMs ?? null, status, error ?? null,
    Array.isArray(externalRefs) ? JSON.stringify(externalRefs) : null,
    rawExcerpt ? String(rawExcerpt).slice(0, 4000) : null,
  );
  return id;
}

function publicResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    modelConfigId: row.model_config_id,
    modelName: row.model_name,
    protocol: row.protocol,
    thinkingLevel: row.thinking_level,
    prompt: row.prompt,
    html: row.html,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error,
    externalRefs: row.external_refs ? JSON.parse(row.external_refs) : [],
    rawExcerpt: row.raw_excerpt ?? null,
    checklist: row.checklist ? JSON.parse(row.checklist) : {},
    createdAt: row.created_at,
  };
}

function getResult(id) {
  return db.prepare("SELECT * FROM results WHERE id = ?").get(id);
}

/** 保存人工判断 checklist（只接受白名单内的项）。 */
function saveChecklist(resultId, checklist) {
  const valid = {};
  for (const item of CHECKLIST_IDS) {
    if (checklist[item] === true) valid[item] = true;
  }
  db.prepare("UPDATE results SET checklist = ? WHERE id = ?").run(JSON.stringify(valid), resultId);
  return valid;
}

function recentResultsByModel(limit = 6) {
  const rows = db.prepare(`
    SELECT * FROM results
    WHERE id IN (
      SELECT id FROM (
        SELECT id, model_config_id, ROW_NUMBER() OVER (PARTITION BY model_config_id ORDER BY created_at DESC, id DESC) AS rn
        FROM results
      ) WHERE rn <= ?
    )
    ORDER BY model_config_id ASC, created_at DESC, id DESC
  `).all(limit);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.model_config_id)) grouped.set(row.model_config_id, []);
    grouped.get(row.model_config_id).push(publicResult(row));
  }
  return grouped;
}

function resultCountByModel() {
  const rows = db.prepare("SELECT model_config_id AS mid, COUNT(*) AS n FROM results GROUP BY model_config_id").all();
  return new Map(rows.map((row) => [row.mid, row.n]));
}

/** 分组查询：多个模型的样本合并，按时间倒序取最新 limit 条。 */
function recentResultsForModels(modelIds, limit = 6) {
  if (!modelIds.length) return [];
  const placeholders = modelIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT * FROM results
    WHERE model_config_id IN (${placeholders})
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...modelIds, limit).map(publicResult);
}

/** 分组查询：多个模型的样本总数。 */
function resultCountForModels(modelIds) {
  if (!modelIds.length) return 0;
  const placeholders = modelIds.map(() => "?").join(",");
  return db.prepare(`SELECT COUNT(*) AS n FROM results WHERE model_config_id IN (${placeholders})`).get(...modelIds).n;
}

/**
 * 裁剪：每个模型只保留最新 retention 条样本（含失败记录），防止硬盘爆满。
 */
function pruneResults(modelConfigId, retention) {
  const keep = Number(retention);
  if (!Number.isFinite(keep) || keep < 1) return 0;
  const info = db.prepare(`
    DELETE FROM results
    WHERE model_config_id = ?
      AND id NOT IN (
        SELECT id FROM results WHERE model_config_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      )
  `).run(modelConfigId, modelConfigId, keep);
  return info.changes;
}

/** 启动时对全部模型执行一次裁剪（处理历史积压）。 */
function pruneAll() {
  let removed = 0;
  for (const model of listModels()) {
    removed += pruneResults(model.id, model.retention ?? 10);
  }
  return removed;
}

// ---------- logs ----------

function logAdmin(action, detail) {
  db.prepare("INSERT INTO admin_logs (action, detail) VALUES (?, ?)").run(action, detail ?? null);
}

// ---------- Base URL 历史 ----------

/** 记录一个使用过的 Base URL（去重，最新在前）。 */
function saveBaseUrl(url) {
  const trimmed = String(url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return;
  db.prepare("DELETE FROM base_url_history WHERE url = ?").run(trimmed);
  db.prepare("INSERT INTO base_url_history (url) VALUES (?)").run(trimmed);
  // 只保留最近 20 条
  db.prepare(`
    DELETE FROM base_url_history
    WHERE id NOT IN (SELECT id FROM base_url_history ORDER BY created_at DESC, id DESC LIMIT 20)
  `).run();
}

/** 读取 Base URL 历史列表。 */
function listBaseUrlHistory() {
  return db.prepare("SELECT url FROM base_url_history ORDER BY created_at DESC, id DESC").all().map((row) => row.url);
}

/** 删除一条 Base URL 历史。 */
function deleteBaseUrl(url) {
  db.prepare("DELETE FROM base_url_history WHERE url = ?").run(String(url ?? ""));
}

// ---------- 提示词管理 ----------

function listPrompts() {
  return db.prepare("SELECT id, name, content, is_default, created_at FROM prompts ORDER BY is_default DESC, id ASC").all()
    .map((row) => ({ id: row.id, name: row.name, content: row.content, isDefault: Boolean(row.is_default), createdAt: row.created_at }));
}

function getPrompt(id) {
  return db.prepare("SELECT * FROM prompts WHERE id = ?").get(id);
}

function createPrompt({ name, content, isDefault }) {
  if (isDefault) db.prepare("UPDATE prompts SET is_default = 0").run();
  const info = db.prepare("INSERT INTO prompts (name, content, is_default) VALUES (?, ?, ?)").run(name, content, isDefault ? 1 : 0);
  return getPrompt(info.lastInsertRowid);
}

function updatePrompt(id, { name, content, isDefault }) {
  const existing = getPrompt(id);
  if (!existing) return null;
  if (isDefault) db.prepare("UPDATE prompts SET is_default = 0").run();
  db.prepare("UPDATE prompts SET name=?, content=?, is_default=? WHERE id=?").run(name, content, isDefault ? 1 : 0, id);
  return getPrompt(id);
}

function deletePrompt(id) {
  const info = db.prepare("DELETE FROM prompts WHERE id = ?").run(id);
  return info.changes > 0;
}

/** 获取模型使用的提示词内容（无配置时回退默认）。 */
function getPromptForModel(modelRow) {
  if (modelRow.prompt_id) {
    const prompt = getPrompt(modelRow.prompt_id);
    if (prompt) return prompt.content;
  }
  const defaultPrompt = db.prepare("SELECT content FROM prompts WHERE is_default = 1 LIMIT 1").get();
  return defaultPrompt?.content ?? STANDARD_PROMPT;
}

/** 获取提示词名（用于展示）。 */
function getPromptNameForModel(modelRow) {
  if (modelRow.prompt_id) {
    const prompt = getPrompt(modelRow.prompt_id);
    if (prompt) return prompt.name;
  }
  const defaultPrompt = db.prepare("SELECT name FROM prompts WHERE is_default = 1 LIMIT 1").get();
  return defaultPrompt?.name ?? "默认";
}

function statsByModel() {
  return db.prepare(`
    SELECT m.id, m.name, m.model_id, COUNT(r.id) AS samples,
      AVG(CASE WHEN r.status = 'success' THEN r.duration_ms END) AS avg_duration_ms,
      AVG(CASE WHEN r.status = 'success' THEN r.total_tokens END) AS avg_total_tokens,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM models m LEFT JOIN results r ON r.model_config_id = m.id
    GROUP BY m.id ORDER BY m.sort_order ASC, m.id ASC
  `).all();
}

module.exports = {
  db,
  newId,
  maskApiKey,
  validateModelInput,
  publicModel,
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  markRun,
  dueModels,
  insertResult,
  publicResult,
  getResult,
  saveChecklist,
  recentResultsByModel,
  resultCountByModel,
  recentResultsForModels,
  resultCountForModels,
  pruneResults,
  pruneAll,
  logAdmin,
  statsByModel,
  saveBaseUrl,
  listBaseUrlHistory,
  deleteBaseUrl,
  listPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
  getPromptForModel,
  getPromptNameForModel,
};
