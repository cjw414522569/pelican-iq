"use strict";

/* global document, fetch, setInterval */

const POLL_MS = 15000;
const PAGE_SIZE = 6; // 每行初始加载数
const PROTOCOL_LABELS = { "openai-chat": "OpenAI Chat", "openai-responses": "OpenAI Responses", anthropic: "Claude Messages", reference: "参考实现" };
const THINKING_LABELS = { off: "关闭", low: "低", medium: "中", high: "高", max: "极高" };

const gallery = document.getElementById("gallery");
const statusLine = document.getElementById("gallery-status");
const dialog = document.getElementById("detail-dialog");
let lastSignature = "";
// 每行已加载的样本数（modelId -> limit）
const loaded = new Map();
// 分组内模型切换状态：分组名 -> "all" | 模型配置 id
const groupFilter = new Map();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 数据库时间为 UTC，转为本地时间显示
function fmtTime(utc) {
  if (!utc) return "—";
  const date = new Date(String(utc).replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return String(utc);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function fmtCountdown(nextRunAt) {
  if (!nextRunAt) return "未排期";
  const target = new Date(nextRunAt.replace(" ", "T") + "Z").getTime();
  const diff = target - Date.now();
  if (diff <= 0) return "即将生成";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

// 行状态文案：生成中 / 下次倒计时 / 参考实现
function rowStatusText(model) {
  if (model.protocol === "reference") return "参考实现 · 不参与调度";
  if (model.generating) return "正在生成…";
  return `每 ${model.intervalMinutes} 分钟 · ${fmtCountdown(model.nextRunAt)}`;
}

// 卡片右上角徽标：所属模型的下次生成倒计时（生成中由实时卡片表示）
function cardBadge(item, group) {
  const model = group?.models?.find((m) => String(m.id) === String(item.modelConfigId));
  if (!model || model.generating || model.protocol === "reference") return "";
  return `<span class="card-badge">⏳ ${esc(fmtCountdown(model.nextRunAt))}</span>`;
}

// 实时生成卡片：生成期间出现在行首，完成后由新样本卡片接替
function liveCardHtml(model) {
  return `
  <article class="g-card live" data-live-model="${model.id}" tabindex="0" role="button" aria-label="查看实时生成内容">
    <div class="image live-placeholder">
      <span class="live-spinner">⟳</span>
      <span class="live-title">正在生成</span>
      <span class="live-chars" data-chars>等待内容…</span>
    </div>
    <div class="info">
      <div class="label">${esc(model.modelId)}</div>
      <div class="result"><span class="ok">⟳ 实时生成中</span></div>
      <div class="bottom"><time>点击查看提示词与实时输出</time></div>
    </div>
  </article>`;
}

function cardHtml(item, group) {
  const failed = item.status !== "success";
  const label = item.modelLabel ?? item.modelName;
  return `
  <article class="g-card ${failed ? "failed" : ""}" data-id="${esc(item.id)}" tabindex="0" role="button" aria-label="查看样本详情">
    <div class="image">
      ${cardBadge(item, group)}
      ${failed
        ? `<div class="fail-note"><b>✕ 生成失败</b><p>${esc(item.error ?? "未知错误")}</p></div>`
        : `<iframe src="${esc(item.previewUrl)}" sandbox="allow-scripts" loading="lazy" title="${esc(label)} 动画预览"></iframe>`}
    </div>
    <div class="info">
      <div class="label">${esc(label)}</div>
      <div class="result">
        <span class="${failed ? "bad" : "ok"}">${failed ? "生成失败" : "生成成功"}</span>
        <span>Token ${fmtTokens(item.totalTokens)}</span>
        ${checklistCount(item.checklist) > 0 ? `<span class="ok">✓ ${checklistCount(item.checklist)}/8</span>` : ""}
      </div>
      <div class="bottom">
        <time>${esc(fmtTime(item.createdAt))}</time>
        <span class="duration">${fmtDuration(item.durationMs)}</span>
      </div>
    </div>
  </article>`;
}

function groupHtml(group) {
  // 分组过滤状态（"all" 或模型配置 id）
  const filter = groupFilter.get(group.name) ?? "all";
  const activeModel = filter === "all" ? null : group.models.find((m) => String(m.id) === String(filter));
  const results = filter === "all"
    ? group.results
    : group.results.filter((item) => String(item.modelConfigId) === String(filter));
  const filterTotal = filter === "all" ? group.total : results.length;
  // loaded 的键统一为分组名（字符串）
  const limit = loaded.get(group.name) ?? PAGE_SIZE;
  const shown = results.slice(0, limit);
  const hasMore = filterTotal > shown.length;
  // 实时卡片：分组内正在生成的模型
  const liveCards = group.models.filter((m) => m.generating).map((m) => liveCardHtml(m)).join("");
  // 切换标签（仿 jiji：全部 + 各模型）
  const tabs = group.models.length > 1 || filter !== "all"
    ? `<div class="g-tabs" role="tablist">
        <button type="button" role="tab" class="g-tab ${filter === "all" ? "active" : ""}" data-filter="all">全部 ${group.total}</button>
        ${group.models.map((m) => `
          <button type="button" role="tab" class="g-tab ${String(filter) === String(m.id) ? "active" : ""}" data-filter="${m.id}">
            <span class="g-tab-label">${esc(m.modelId)}</span>
          </button>`).join("")}
      </div>`
    : "";
  // 侧栏状态：全部 = 分组摘要；具体模型 = 该模型的调度信息
  const meta = activeModel
    ? `<span class="tag ${activeModel.enabled ? "on" : "off"}">${activeModel.enabled ? "调度中" : "已停用"}</span>
       <span class="tag">${esc(PROTOCOL_LABELS[activeModel.protocol] ?? activeModel.protocol)}</span>
       <span class="tag">思考：${esc(THINKING_LABELS[activeModel.thinkingLevel] ?? activeModel.thinkingLevel)}</span>
       <span class="next${activeModel.generating ? " generating" : ""}">${esc(rowStatusText(activeModel))}</span>`
    : `<span class="tag">${group.models.length} 个模型</span>
       <span class="next">${group.models.some((m) => m.generating) ? "正在生成…" : `${group.total} 条记录`}</span>`;
  return `
  <section class="g-row" data-group="${esc(group.name)}">
    <div class="g-key">
      <div class="g-heading">
        <h2>${esc(group.name)}</h2>
        <span class="g-count">${group.total} 条记录</span>
      </div>
      ${tabs}
      <div class="g-meta">${meta}</div>
    </div>
    <div class="g-strip" role="list" aria-label="${esc(group.name)}的生成记录">
      ${liveCards}
      ${shown.length ? shown.map((item) => cardHtml(item, group)).join("") : `<div class="g-empty" style="padding:24px">${liveCards ? "正在生成…" : "暂无样本，等待首次生成…"}</div>`}
      ${hasMore ? '<div class="g-more"><button type="button" data-action="more">加载更多</button><span>还有 ' + (filterTotal - shown.length) + ' 条</span></div>' : ""}
    </div>
  </section>`;
}

async function fetchGroup(groupName, limit) {
  const response = await fetch(`/api/gallery?limit=${limit}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const group = (data.groups ?? []).find((item) => item.name === groupName);
  if (!group) throw new Error("分组不存在");
  return group;
}

function render(data) {
  const groups = data.groups ?? [];
  if (!groups.length) {
    gallery.innerHTML = `<div class="g-empty">还没有配置任何模型。请到 <a href="/admin">后台管理</a> 添加模型。</div>`;
    statusLine.textContent = "";
    return;
  }
  const signature = JSON.stringify(groups.map((group) => [
    group.name,
    group.total,
    group.models.map((m) => [m.id, m.nextRunAt, m.generating]),
    group.results.map((item) => item.id),
  ]));
  if (signature === lastSignature) {
    // 数据没变，只刷新倒计时徽标与记录数
    for (const group of groups) {
      const row = gallery.querySelector(`[data-group="${CSS.escape(group.name)}"]`);
      if (!row) continue;
      row.querySelector(".g-count").textContent = `${group.total} 条记录`;
      // 倒计时徽标按卡片所属模型刷新
      for (const card of row.querySelectorAll(".g-card:not(.live)")) {
        const item = group.results.find((r) => r.id === card.dataset.id);
        if (!item) continue;
        const old = card.querySelector(".card-badge");
        const fresh = document.createElement("template");
        fresh.innerHTML = cardBadge(item, group);
        if (old) old.replaceWith(fresh.content.firstElementChild || document.createComment(""));
        else if (fresh.content.firstElementChild) card.querySelector(".image").prepend(fresh.content.firstElementChild);
      }
    }
    return;
  }
  lastSignature = signature;
  gallery.innerHTML = groups.map((group) => groupHtml(group)).join("");
  statusLine.textContent = `共 ${groups.length} 个分组 · ${groups.reduce((sum, group) => sum + group.total, 0)} 份样本 · 每 15 秒自动刷新`;
  // 有模型在生成 → 启动实时轮询
  updateLivePolling();
}

async function loadGallery() {
  try {
    const maxLimit = Math.max(PAGE_SIZE, ...[...loaded.values()]);
    const response = await fetch(`/api/gallery?limit=${maxLimit}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    render(data);
  } catch (error) {
    statusLine.textContent = `画廊读取失败：${error.message}`;
  }
}

// 行内交互：切换标签 / 加载更多 / 打开详情 / 实时卡片
gallery.addEventListener("click", async (event) => {
  // 切换分组内的模型标签
  const tab = event.target.closest(".g-tab");
  if (tab) {
    const row = tab.closest(".g-row");
    const groupName = row.dataset.group;
    groupFilter.set(groupName, tab.dataset.filter);
    try {
      const maxLimit = Math.max(PAGE_SIZE, ...[...loaded.values()]);
      const group = await fetchGroup(groupName, maxLimit);
      const fresh = document.createElement("div");
      fresh.innerHTML = groupHtml(group);
      row.replaceWith(fresh.firstElementChild);
    } catch (error) {
      statusLine.textContent = `切换失败：${error.message}`;
    }
    return;
  }
  const liveCard = event.target.closest(".g-card.live");
  if (liveCard) {
    openLiveDialog(liveCard.dataset.liveModel);
    return;
  }
  const moreButton = event.target.closest('button[data-action="more"]');
  if (moreButton) {
    const row = moreButton.closest(".g-row");
    const groupName = row.dataset.group;
    const next = (loaded.get(groupName) ?? PAGE_SIZE) + PAGE_SIZE;
    loaded.set(groupName, next);
    try {
      const group = await fetchGroup(groupName, next);
      const fresh = document.createElement("div");
      fresh.innerHTML = groupHtml(group);
      row.replaceWith(fresh.firstElementChild);
    } catch (error) {
      statusLine.textContent = `加载失败：${error.message}`;
    }
    return;
  }
  const card = event.target.closest(".g-card");
  if (card) void openDetail(card.dataset.id);
});
gallery.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const card = event.target.closest(".g-card");
  if (card) void openDetail(card.dataset.id);
});

// ---------- 详情弹层 ----------

const CHECKLIST = [
  { id: "beak", label: "喙与喉囊分开，朝向合理" },
  { id: "body", label: "头、颈、身、翅、尾可以分开辨认" },
  { id: "wheels", label: "两个车轮独立，并且在转动" },
  { id: "frame", label: "车架、车座、车把、脚踏都在" },
  { id: "pedal", label: "踩踏和曲柄是同步的" },
  { id: "loop", label: "动画循环衔接，没有明显跳帧" },
  { id: "self", label: "没有依赖外部图片、字体或脚本" },
  { id: "fit", label: "缩放到不同宽度时主体仍然完整" },
];

const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const detailMetrics = document.getElementById("detail-metrics");
const detailFrame = document.getElementById("detail-frame");
const tabSource = document.getElementById("tab-source");
const tabPrompt = document.getElementById("tab-prompt");
const detailRefs = document.getElementById("detail-refs");
const checklistEl = document.getElementById("detail-checklist");
const checklistScore = document.getElementById("checklist-score");
let currentDetail = null;

function checklistCount(checklist) {
  return CHECKLIST.filter((item) => checklist?.[item.id] === true).length;
}

function switchDetailTab(name) {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  document.getElementById("tab-preview").hidden = name !== "preview";
  tabSource.hidden = name !== "source";
  tabPrompt.hidden = name !== "prompt";
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchDetailTab(btn.dataset.tab));
});

function renderChecklist(detail) {
  const saved = detail.checklist ?? {};
  checklistScore.textContent = `（${checklistCount(saved)}/${CHECKLIST.length}）`;
  checklistEl.innerHTML = CHECKLIST.map((item) => `
    <label class="check-item">
      <input type="checkbox" data-item="${item.id}" ${saved[item.id] ? "checked" : ""}>
      <span>${esc(item.label)}</span>
    </label>`).join("");
}

checklistEl.addEventListener("change", async (event) => {
  const input = event.target.closest("input[data-item]");
  if (!input || !currentDetail) return;
  const next = {};
  for (const el of checklistEl.querySelectorAll("input[data-item]")) {
    if (el.checked) next[el.dataset.item] = true;
  }
  try {
    const response = await fetch(`/api/results/${encodeURIComponent(currentDetail.id)}/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checklist: next }),
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "保存失败");
    const data = await response.json();
    currentDetail.checklist = data.checklist;
    checklistScore.textContent = `（${checklistCount(data.checklist)}/${CHECKLIST.length}）`;
    void loadGallery(); // 刷新卡片评分
  } catch (error) {
    statusLine.textContent = `判断保存失败：${error.message}`;
    input.checked = !input.checked;
  }
});

async function openDetail(id) {
  let detail;
  try {
    const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("样本不存在");
    detail = await response.json();
  } catch (error) {
    statusLine.textContent = `详情读取失败：${error.message}`;
    return;
  }
  currentDetail = detail;
  detailTitle.textContent = detail.modelName;
  detailMeta.innerHTML = `
    <span>${esc(PROTOCOL_LABELS[detail.protocol] ?? detail.protocol)}</span> ·
    <span>思考：${esc(THINKING_LABELS[detail.thinkingLevel] ?? detail.thinkingLevel)}</span> ·
    <time>${esc(fmtTime(detail.createdAt))}</time>`;
  detailMetrics.innerHTML = `
    <div><dt>耗时</dt><dd>${fmtDuration(detail.durationMs)}</dd></div>
    <div><dt>输入 Token</dt><dd>${fmtTokens(detail.inputTokens)}</dd></div>
    <div><dt>输出 Token</dt><dd>${fmtTokens(detail.outputTokens)}</dd></div>
    <div><dt>总 Token</dt><dd>${fmtTokens(detail.totalTokens)}</dd></div>
    <div><dt>外部引用</dt><dd>${detail.externalRefs?.length ? `${detail.externalRefs.length} 处` : "无"}</dd></div>
    <div><dt>状态</dt><dd>${detail.status === "success" ? "成功" : "失败"}</dd></div>`;
  if (detail.html) {
    // 使用带 CSP 注入的预览端点，与卡片预览一致（禁外链）
    detailFrame.src = `/api/results/${encodeURIComponent(id)}/preview`;
    detailFrame.style.display = "";
  } else {
    detailFrame.removeAttribute("src");
    detailFrame.style.display = "none";
  }
  tabSource.textContent = detail.html
    ?? `生成失败：${detail.error ?? "未知错误"}`
      + (detail.rawExcerpt ? `\n\n--- 收到内容节选 ---\n${detail.rawExcerpt}` : "");
  tabPrompt.textContent = detail.prompt ?? "—";
  detailRefs.hidden = !detail.externalRefs?.length;
  if (detail.externalRefs?.length) {
    detailRefs.textContent = `源码里出现了外部地址：${detail.externalRefs.join("，")}。隔离预览会挡住它们，这通常说明没有遵守「禁止外部资源」。`;
  }
  renderChecklist(detail);
  switchDetailTab("preview");
  dialog.showModal();
}

// 下载 / 复制
document.getElementById("detail-download").addEventListener("click", () => {
  if (!currentDetail?.html) return;
  const blob = new Blob([currentDetail.html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(currentDetail.modelName || "pelican").replace(/[\\/:*?"<>|]/g, "_")}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
document.getElementById("detail-copy").addEventListener("click", async () => {
  if (!currentDetail?.html) return;
  try {
    await navigator.clipboard.writeText(currentDetail.html);
    statusLine.textContent = "源码已复制";
  } catch {
    statusLine.textContent = "复制失败（浏览器限制）";
  }
});

document.getElementById("detail-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

// ---------- 实时生成弹层 ----------

const liveDialog = document.getElementById("live-dialog");
const liveDialogTitle = document.getElementById("live-title");
const livePrompt = document.getElementById("live-prompt");
const liveContent = document.getElementById("live-content");
const liveThinking = document.getElementById("live-thinking");
const liveStatus = document.getElementById("live-status");
let liveModelId = null; // 当前弹层跟踪的模型配置 id
let liveTimer = null;

// 内容更新时若原本贴底则保持贴底（终端式跟随输出）；用户上翻查看历史时不打扰
function stickToBottom(el, update) {
  if (!el) { update(); return; }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  update();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function openLiveDialog(modelId) {
  liveModelId = String(modelId);
  livePrompt.textContent = "加载中…";
  liveContent.textContent = "";
  liveThinking.textContent = "";
  liveStatus.textContent = "⟳ 生成中";
  liveStatus.className = "st st-info";
  ensureLivePolling();
  void refreshLive();
  liveDialog.showModal();
}

document.getElementById("live-close").addEventListener("click", () => {
  liveDialog.close();
  liveModelId = null;
});
liveDialog.addEventListener("close", () => {
  liveModelId = null;
  updateLivePolling();
});
liveDialog.addEventListener("click", (event) => {
  if (event.target === liveDialog) liveDialog.close();
});

async function refreshLive() {
  let data;
  try {
    const response = await fetch("/api/live");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch {
    return; // 下次轮询重试
  }
  const entries = data.live ?? [];
  // 更新实时卡片上的字符数
  for (const card of gallery.querySelectorAll(".g-card.live")) {
    const entry = entries.find((item) => String(item.modelConfigId) === String(card.dataset.liveModel));
    const charsEl = card.querySelector("[data-chars]");
    if (charsEl) {
      charsEl.textContent = entry
        ? `已输出 ${entry.contentLength + entry.thinkingLength} 字符`
        : "即将完成…";
    }
  }
  // 更新弹层（内容贴底跟随，终端式流式观看）
  if (liveModelId && liveDialog.open) {
    const entry = entries.find((item) => String(item.modelConfigId) === liveModelId);
    if (entry) {
      liveDialogTitle.textContent = `${entry.model} · 实时生成`;
      livePrompt.textContent = entry.prompt;
      stickToBottom(liveContent, () => {
        liveContent.textContent = entry.contentTail
          || (entry.thinkingTail ? "（正文尚未开始，模型正在思考，思考内容见下方…）" : "（等待模型输出…）");
      });
      // 注意：用 hidden 属性控制（style.display 会被 [hidden]{display:none!important} 覆盖）
      liveThinking.hidden = !entry.thinkingTail;
      if (entry.thinkingTail) {
        stickToBottom(liveThinking, () => {
          liveThinking.textContent = `【思考 ${entry.thinkingLength} 字符】\n${entry.thinkingTail}`;
        });
      }
      liveStatus.textContent = `⟳ 生成中 · 正文 ${entry.contentLength} 字符${entry.thinkingLength ? ` · 思考 ${entry.thinkingLength} 字符` : ""}`;
    } else {
      // 该模型的生成已结束
      liveStatus.textContent = "✓ 生成结束，结果已入画廊";
      liveStatus.className = "st st-ok";
      void loadGallery(); // 立即刷新画廊，新卡片接替实时卡片
    }
  }
  updateLivePolling(entries);
}

// 有模型在生成或弹层打开时，保持 2 秒轮询；否则停止
function ensureLivePolling() {
  if (liveTimer) return;
  liveTimer = setInterval(() => { void refreshLive(); }, 1000);
}
function updateLivePolling(entries) {
  const shouldPoll = liveDialog.open
    || (entries ? entries.length > 0 : gallery.querySelector(".g-card.live") !== null);
  if (shouldPoll) ensureLivePolling();
  else if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

// ---------- 启动 ----------

void loadGallery();
setInterval(() => { void loadGallery(); }, POLL_MS);
