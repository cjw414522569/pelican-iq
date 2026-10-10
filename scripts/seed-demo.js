"use strict";

/**
 * 写入视觉基准（移植自 PelicanBench 的手写参考动画，多套配色）。
 * 作为画廊第一行的「标准答案」对照，非模型成绩。
 * 重复执行会先清空旧的基准与演示数据。
 * 用法：node scripts/seed-demo.js
 */

const store = require("../src/db");
const { REFERENCE_SAMPLES } = require("../src/reference-html");
const { STANDARD_PROMPT } = require("../src/prompt");

const REFERENCE_MODEL_NAME = "视觉基准（参考实现）";

function seed() {
  // 清理旧的基准行与演示行
  for (const row of store.listModels()) {
    if (row.name === REFERENCE_MODEL_NAME || row.name.startsWith("演示 ·")) {
      store.deleteModel(row.id);
    }
  }

  const reference = store.createModel({
    name: REFERENCE_MODEL_NAME,
    protocol: "reference", // 特殊标记：画廊显示为「参考实现」，调度器不会执行（enabled=0 且无 Key）
    baseUrl: "https://reference.local",
    apiKey: "",
    modelId: "reference",
    thinkingLevel: "off",
    intervalMinutes: 525600, // 不会触发（已停用）
    retention: 10,
    enabled: 0,
    sortOrder: -100, // 排在最前
  });

  for (const sample of REFERENCE_SAMPLES) {
    store.insertResult({
      modelConfigId: reference.id,
      modelName: sample.model,
      protocol: "reference",
      thinkingLevel: "off",
      prompt: STANDARD_PROMPT,
      html: sample.html,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      durationMs: null,
      status: "success",
      error: null,
      externalRefs: [],
    });
  }

  console.log(`已写入视觉基准：${REFERENCE_SAMPLES.length} 套参考动画（${REFERENCE_SAMPLES.map((s) => s.model).join("、")}）。`);
  console.log("该行不参与调度，仅作为画廊对照。");
}

seed();
