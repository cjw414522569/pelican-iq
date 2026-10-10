"use strict";

const store = require("./db");
const { runBench } = require("./llm-client");
const genLog = require("./gen-log");

const TICK_MS = 30 * 1000;
const running = new Set(); // modelConfigId -> true，防止同一模型并发执行

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function nextRunIso(intervalMinutes) {
  return new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 执行一次模型生成并写入 results。
 * 调度器与手动「立即运行」共用此路径。
 */
async function runModel(modelRow) {
  if (running.has(modelRow.id)) {
    return { skipped: true, reason: "该模型正在生成中" };
  }
  running.add(modelRow.id);
  const nextRunAt = nextRunIso(modelRow.interval_minutes);
  const logId = genLog.start({ model: modelRow.name, protocol: modelRow.protocol, prompt: store.getPromptForModel(modelRow), modelConfigId: modelRow.id });
  const logStarted = Date.now();
  try {
    const result = await runBench({
      baseUrl: modelRow.base_url,
      apiKey: modelRow.api_key,
      protocol: modelRow.protocol,
      model: modelRow.model_id,
      thinking: modelRow.thinking_level,
      onDelta: (delta) => genLog.append(logId, delta), // 实时记录流式内容
    });
    const resultId = store.insertResult({
      modelConfigId: modelRow.id,
      modelName: modelRow.name,
      protocol: modelRow.protocol,
      thinkingLevel: modelRow.thinking_level,
      prompt: store.getPromptForModel(modelRow),
      html: result.ok ? result.html : null,
      usage: result.usage,
      durationMs: result.durationMs,
      status: result.ok ? "success" : "failed",
      error: result.ok ? null : (result.error ?? "未知错误"),
      externalRefs: result.externalRefs,
      rawExcerpt: result.ok ? null : result.raw,
    });
    // 只保留最新 retention 条样本，防止硬盘爆满
    store.pruneResults(modelRow.id, modelRow.retention ?? 10);
    store.markRun(modelRow.id, { nextRunAt });
    genLog.finish(logId, { ok: result.ok, error: result.error ?? null, durationMs: result.durationMs, tokens: result.usage?.totalTokens ?? null });
    return { skipped: false, resultId, ok: result.ok, error: result.error ?? null, durationMs: result.durationMs, nextRunAt };
  } catch (error) {
    // 异常也要结束日志，避免条目永远停在「生成中」
    genLog.finish(logId, { ok: false, error: error?.message ?? "执行异常", durationMs: Date.now() - logStarted, tokens: null });
    throw error;
  } finally {
    running.delete(modelRow.id);
  }
}

async function tick() {
  try {
    const due = store.dueModels(nowIso());
    for (const model of due) {
      // 串行执行，避免并发打爆上游
      try {
        const outcome = await runModel(model);
        console.log(`[scheduler] ${model.name} -> ${outcome.skipped ? "跳过（运行中）" : outcome.ok ? "成功" : `失败：${outcome.error}`}`);
      } catch (error) {
        console.error(`[scheduler] ${model.name} 执行异常:`, error?.message ?? error);
        store.markRun(model.id, { nextRunAt: nextRunIso(model.interval_minutes) });
      }
    }
  } catch (error) {
    console.error("[scheduler] tick 异常:", error?.message ?? error);
  }
}

function start() {
  // 启动清扫：按各模型保留数裁剪历史样本
  const removed = store.pruneAll();
  if (removed > 0) console.log(`[scheduler] 启动清扫：裁剪了 ${removed} 条超出保留数的旧样本`);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
  // 启动后 3 秒先跑一次，处理停机期间积压的任务
  const initial = setTimeout(() => { void tick(); }, 3000);
  initial.unref();
  console.log(`[scheduler] 已启动，每 ${TICK_MS / 1000}s 检查一次到期模型`);
}

module.exports = { start, runModel, tick, isRunning: (id) => running.has(id) };
