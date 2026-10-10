"use strict";

/* global document, fetch, FormData, setInterval, window */

const PROTOCOL_LABELS = { "openai-chat": "OpenAI Chat", "openai-responses": "OpenAI Responses", anthropic: "Claude Messages" };
const THINKING_LABELS = { off: "关闭", low: "低", medium: "中", high: "高", max: "极高" };

const loginView = document.getElementById("login-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const adminView = document.getElementById("admin-view");
const adminBanner = document.getElementById("admin-banner");
const modelsTbody = document.getElementById("models-tbody");
const statCards = document.getElementById("stat-cards");
const statsBody = document.getElementById("stats-body");
const modelForm = document.getElementById("model-form");
const editDialog = document.getElementById("edit-dialog");
const editForm = document.getElementById("edit-form");
const groupEditDialog = document.getElementById("group-edit-dialog");
const groupEditForm = document.getElementById("group-edit-form");
const navLogout = document.getElementById("nav-logout");
const crumbCurrent = document.getElementById("crumb-current");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// 数据库时间为 UTC，转为本地时间显示
function fmtTime(utc) {
  if (!utc) return "—";
  const date = new Date(String(utc).replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return String(utc);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function showBanner(message) {
  adminBanner.textContent = message;
  adminBanner.hidden = !message;
  if (message) setTimeout(() => { adminBanner.hidden = true; }, 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

// ---------- 侧边栏导航（独立视图切换） ----------

const VIEW_TITLES = { models: "模型管理", create: "新增模型", prompts: "提示词", stats: "运行概览", logs: "生成日志" };

function switchView(name) {
  if (!VIEW_TITLES[name]) return;
  for (const key of Object.keys(VIEW_TITLES)) {
    const view = document.getElementById(`view-${key}`);
    if (view) view.hidden = key !== name;
  }
  document.querySelectorAll(".aside-nav a[data-nav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.nav === name);
  });
  crumbCurrent.textContent = VIEW_TITLES[name];
  // 切到对应视图时刷新数据
  if (name === "models") void refreshModels();
  if (name === "stats") void refreshStats();
  if (name === "logs") void refreshGenLogs();
  if (name === "create") { void loadBaseUrlHistory(); void loadPromptOptions(); }
  if (name === "prompts") void refreshPrompts();
}

document.querySelectorAll(".aside-nav a[data-nav]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    switchView(link.dataset.nav);
    history.replaceState(null, "", `#${link.dataset.nav}`);
  });
});

document.getElementById("btn-goto-create").addEventListener("click", () => switchView("create"));

// ---------- 登录 ----------

async function checkSession() {
  try {
    const data = await api("/api/admin/session");
    if (!data.adminConfigured) {
      document.body.innerHTML = '<div class="login-wrap"><div class="banner-error" style="max-width:420px">未配置 ADMIN_PASSWORD 环境变量。请在 .env 中设置后重启服务。</div></div>';
      return;
    }
    if (data.authenticated) showAdmin();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginView.hidden = false;
  adminView.hidden = true;
}

function showAdmin() {
  loginView.hidden = true;
  adminView.hidden = false;
  // 恢复 hash 指定的视图（默认模型管理）
  switchView(location.hash.replace("#", "") || "models");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: document.getElementById("login-password").value }),
    });
    document.getElementById("login-password").value = "";
    showAdmin();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  }
});

navLogout.addEventListener("click", async (event) => {
  event.preventDefault();
  await api("/api/admin/logout", { method: "POST" }).catch(() => undefined);
  showLogin();
});

// ---------- 模型管理（按分组聚合） ----------

async function refreshModels() {
  let models;
  try {
    models = (await api("/api/admin/models")).models;
  } catch (error) {
    if (error.message.includes("未登录")) { showLogin(); return; }
    showBanner(`模型列表读取失败：${error.message}`);
    return;
  }
  if (!models.length) {
    modelsTbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:32px">还没有配置模型，请在「新增模型」中添加。</td></tr>';
    return;
  }
  // 按名称分组聚合（一组一行，展开显示子模型）
  const groupMap = new Map();
  for (const model of models) {
    if (!groupMap.has(model.name)) groupMap.set(model.name, []);
    groupMap.get(model.name).push(model);
  }
  modelsTbody.innerHTML = [...groupMap.entries()].map(([name, groupModels]) => {
    const multi = groupModels.length > 1;
    const enabledCount = groupModels.filter((m) => m.enabled).length;
    const hasKey = groupModels.some((m) => m.hasKey);
    const apiKeyMask = groupModels.find((m) => m.hasKey)?.apiKeyMask ?? "";
    const nextRun = groupModels.filter((m) => m.enabled && m.nextRunAt).map((m) => m.nextRunAt).sort()[0];
    const groupRow = `
    <tr class="group-row" data-group="${esc(name)}">
      <td><b>${esc(name)}</b>${multi ? ` <span class="st st-info">${groupModels.length} 个模型</span>` : ""}</td>
      <td>${esc(PROTOCOL_LABELS[groupModels[0].protocol] ?? groupModels[0].protocol)}</td>
      <td class="mono">${multi ? "—" : esc(groupModels[0].modelId)}</td>
      <td>${multi ? "—" : esc(THINKING_LABELS[groupModels[0].thinkingLevel] ?? groupModels[0].thinkingLevel)}</td>
      <td>${multi ? "—" : `${groupModels[0].intervalMinutes} 分钟`}</td>
      <td>${multi ? "—" : `${groupModels[0].retention ?? 10} 张`}</td>
      <td>${multi
        ? `<span class="st ${enabledCount ? "st-ok" : "st-off"}">${enabledCount}/${groupModels.length} 启用</span>`
        : groupModels[0].enabled ? '<span class="st st-ok">已启用</span>' : '<span class="st st-off">已停用</span>'}</td>
      <td class="num">${multi ? (nextRun ? esc(fmtTime(nextRun)) : "—") : esc(fmtTime(groupModels[0].nextRunAt))}</td>
      <td>${hasKey ? `<span class="st st-info">${esc(apiKeyMask)}</span>` : '<span class="st st-bad">未配置</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        ${multi ? `<button type="button" class="btn btn-sm btn-ghost" data-action="toggle-group">展开</button>` : ""}
        <button type="button" class="btn btn-sm" data-action="run-group">全部运行</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="edit-group">编辑</button>
        ${multi ? "" : `<button type="button" class="btn btn-sm btn-ghost" data-action="test" data-id="${groupModels[0].id}">测试</button>`}
        <button type="button" class="btn btn-sm btn-danger" data-action="delete-group">删除</button>
      </td>
    </tr>`;
    const subRows = multi ? groupModels.map((model) => `
    <tr class="sub-row" data-group="${esc(name)}" data-id="${model.id}" hidden>
      <td class="muted" style="padding-left:32px">└ ${esc(model.modelId)}</td>
      <td></td>
      <td class="mono">${esc(model.modelId)}</td>
      <td>${esc(THINKING_LABELS[model.thinkingLevel] ?? model.thinkingLevel)}</td>
      <td class="num">${model.intervalMinutes} 分钟</td>
      <td class="num">${model.retention ?? 10} 张</td>
      <td>${model.enabled ? '<span class="st st-ok">已启用</span>' : '<span class="st st-off">已停用</span>'}</td>
      <td class="num">${esc(fmtTime(model.nextRunAt))}</td>
      <td>${model.hasKey ? `<span class="st st-info">${esc(model.apiKeyMask)}</span>` : '<span class="st st-bad">未配置</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button type="button" class="btn btn-sm" data-action="run">立即运行</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="test">测试</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="edit">编辑</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="delete">删除</button>
      </td>
    </tr>`).join("") : "";
    return groupRow + subRows;
  }).join("");
  // 刷新后恢复展开状态
  for (const groupName of expandedGroups) {
    for (const row of modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`)) {
      row.hidden = false;
    }
    const groupRowEl = modelsTbody.querySelector(`.group-row[data-group="${CSS.escape(groupName)}"]`);
    const toggleBtn = groupRowEl?.querySelector('button[data-action="toggle-group"]');
    if (toggleBtn) toggleBtn.textContent = "收起";
  }
}

// 展开的分组（保持刷新后状态）
const expandedGroups = new Set();

modelsTbody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const groupRow = button.closest(".group-row");
  const subRow = button.closest(".sub-row");

  // 分组操作
  if (action === "toggle-group" && groupRow) {
    const groupName = groupRow.dataset.group;
    const expanding = !expandedGroups.has(groupName);
    if (expanding) expandedGroups.add(groupName);
    else expandedGroups.delete(groupName);
    for (const row of modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`)) {
      row.hidden = !expanding;
    }
    button.textContent = expanding ? "收起" : "展开";
    return;
  }
  if (action === "run-group" && groupRow) {
    const groupName = groupRow.dataset.group;
    const subIds = [...modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`)].map((row) => row.dataset.id);
    const ids = subIds.length ? subIds : [groupRow.querySelector('button[data-action="test"]')?.dataset.id].filter(Boolean);
    button.disabled = true;
    button.textContent = "触发中…";
    let triggered = 0;
    for (const id of ids) {
      try {
        await api(`/api/admin/models/${id}/run`, { method: "POST" });
        triggered += 1;
      } catch { /* 单个失败继续 */ }
    }
    button.disabled = false;
    button.textContent = "全部运行";
    showBanner(triggered ? `已触发 ${triggered} 个模型生成` : "没有可运行的模型（可能正在生成中）");
    setTimeout(() => { void refreshModels(); void refreshStats(); }, 8000);
    return;
  }
  if (action === "edit-group" && groupRow) {
    const groupName = groupRow.dataset.group;
    const subCount = modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`).length;
    const modelCount = subCount || 1;
    document.getElementById("group-edit-title").textContent = `编辑分组「${groupName}」`;
    document.getElementById("group-edit-meta").textContent = `将批量设置组内 ${modelCount} 个模型`;
    groupEditForm.groupName.value = groupName;
    groupEditForm.thinkingLevel.value = "";
    groupEditForm.intervalMinutes.value = "";
    groupEditForm.retention.value = "";
    groupEditForm.sortOrder.value = "";
    groupEditForm.enabled.checked = false;
    groupEditDialog.showModal();
    return;
  }
  if (action === "delete-group" && groupRow) {
    const groupName = groupRow.dataset.group;
    const count = modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`).length || 1;
    if (!window.confirm(`确定删除分组「${groupName}」及其全部 ${count} 个模型与样本？`)) return;
    const subIds = [...modelsTbody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`)].map((row) => row.dataset.id);
    const ids = subIds.length ? subIds : [groupRow.querySelector('button[data-action="test"]')?.dataset.id].filter(Boolean);
    try {
      for (const id of ids) await api(`/api/admin/models/${id}`, { method: "DELETE" });
      expandedGroups.delete(groupName);
      void refreshModels();
      void refreshStats();
    } catch (error) {
      showBanner(error.message);
    }
    return;
  }

  // 子模型 / 单模型操作
  const row = subRow ?? groupRow;
  if (!row) return;
  const id = row.dataset.id ?? button.dataset.id;
  if (!id) return;
  if (action === "run") {
    button.disabled = true;
    button.textContent = "生成中…";
    try {
      const data = await api(`/api/admin/models/${id}/run`, { method: "POST" });
      showBanner(data.message ?? "已触发生成");
      setTimeout(() => { void refreshModels(); void refreshStats(); }, 8000);
    } catch (error) {
      showBanner(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "立即运行";
    }
  } else if (action === "test") {
    // 连通性测试：用该行模型已保存的配置发一句话
    button.disabled = true;
    button.textContent = "测试中…";
    try {
      const result = await api("/api/admin/test-model", {
        method: "POST",
        body: JSON.stringify({ id: Number(id) }),
      });
      if (result.ok) {
        showBanner(`✓ 测试成功：${(result.durationMs / 1000).toFixed(1)}s 收到回复「${result.reply}」`);
      } else {
        showBanner(`✕ 测试失败：${result.error}`);
      }
    } catch (error) {
      showBanner(`✕ 测试失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = "测试";
    }
  } else if (action === "edit") {
    const model = (await api("/api/admin/models")).models.find((item) => String(item.id) === id);
    if (!model) return;
    editForm.id.value = model.id;
    editForm.name.value = model.name;
    editForm.protocol.value = model.protocol;
    editForm.baseUrl.value = model.baseUrl;
    editForm.apiKey.value = "";
    editForm.modelId.value = model.modelId;
    editForm.thinkingLevel.value = model.thinkingLevel;
    editForm.intervalMinutes.value = model.intervalMinutes;
    editForm.retention.value = model.retention ?? 10;
    editForm.sortOrder.value = model.sortOrder;
    editForm.enabled.checked = model.enabled;
    if (editForm.elements.promptId) editForm.elements.promptId.value = model.promptId ?? "";
    void loadPromptOptions();
    resetPicker(editForm);
    editDialog.showModal();
  } else if (action === "delete") {
    if (!window.confirm("确定删除该模型及其全部样本？")) return;
    try {
      await api(`/api/admin/models/${id}`, { method: "DELETE" });
      void refreshModels();
      void refreshStats();
    } catch (error) {
      showBanner(error.message);
    }
  }
});

// ---------- 模型多选与每模型配置（新增表单） ----------

const selectedModels = new Map(); // modelId -> {modelId, thinkingLevel, intervalMinutes, retention, sortOrder, enabled}
const modelCheckList = document.getElementById("model-check-list");
const selectedModelsEl = document.getElementById("selected-models");

function pickerOf(form) {
  return {
    form,
    button: form.querySelector('button[data-action="fetch"]'),
    input: form.elements.modelId,
    status: form.querySelector(".model-picker .status"),
  };
}

function resetPicker(form) {
  const picker = pickerOf(form);
  if (modelCheckList) modelCheckList.hidden = true;
  if (modelCheckList) modelCheckList.innerHTML = "";
  picker.status.textContent = "";
  picker.status.className = "status";
}

// 从表单默认值生成一个模型配置项
function defaultsFromForm() {
  return {
    thinkingLevel: modelForm.elements.thinkingLevel.value,
    intervalMinutes: Number(modelForm.elements.intervalMinutes.value) || 60,
    retention: Number(modelForm.elements.retention.value) || 10,
    sortOrder: Number(modelForm.elements.sortOrder.value) || 0,
    enabled: modelForm.elements.enabled.checked,
  };
}

function addSelectedModel(modelId) {
  const id = String(modelId).trim();
  if (!id || selectedModels.has(id)) return;
  selectedModels.set(id, { modelId: id, ...defaultsFromForm() });
  renderSelectedModels();
}

function removeSelectedModel(modelId) {
  selectedModels.delete(modelId);
  renderSelectedModels();
  // 同步取消勾选
  const checkbox = modelCheckList?.querySelector(`input[data-model="${CSS.escape(modelId)}"]`);
  if (checkbox) checkbox.checked = false;
}

function renderSelectedModels() {
  if (!selectedModels.size) {
    selectedModelsEl.innerHTML = '<p class="muted" style="font-size:12px;margin:6px 0">尚未选择模型。获取列表后勾选，或在上方手动输入添加。</p>';
    return;
  }
  selectedModelsEl.innerHTML = [...selectedModels.values()].map((item) => `
    <div class="selected-model-row" data-model="${esc(item.modelId)}">
      <b class="sm-model" title="${esc(item.modelId)}">${esc(item.modelId)}</b>
      <label class="sm-field">思考
        <select class="sm-thinking">
          ${["off", "low", "medium", "high", "max"].map((v) => `<option value="${v}" ${item.thinkingLevel === v ? "selected" : ""}>${THINKING_LABELS[v]}</option>`).join("")}
        </select>
      </label>
      <label class="sm-field">间隔(分)
        <input class="sm-interval" type="number" min="1" max="10080" value="${item.intervalMinutes}">
      </label>
      <label class="sm-field">保留
        <input class="sm-retention" type="number" min="1" max="500" value="${item.retention}">
      </label>
      <label class="sm-field">排序
        <input class="sm-sort" type="number" value="${item.sortOrder}">
      </label>
      <label class="sm-field checkbox-label"><input class="sm-enabled" type="checkbox" ${item.enabled ? "checked" : ""}>启用</label>
      <button type="button" class="btn btn-sm btn-danger" data-remove="${esc(item.modelId)}">移除</button>
    </div>`).join("");
}

// 已选模型配置行的输入变化 → 同步回 selectedModels
selectedModelsEl.addEventListener("input", (event) => {
  const row = event.target.closest(".selected-model-row");
  if (!row) return;
  const item = selectedModels.get(row.dataset.model);
  if (!item) return;
  if (event.target.classList.contains("sm-thinking")) item.thinkingLevel = event.target.value;
  if (event.target.classList.contains("sm-interval")) item.intervalMinutes = Number(event.target.value) || 60;
  if (event.target.classList.contains("sm-retention")) item.retention = Number(event.target.value) || 10;
  if (event.target.classList.contains("sm-sort")) item.sortOrder = Number(event.target.value) || 0;
});
selectedModelsEl.addEventListener("change", (event) => {
  const row = event.target.closest(".selected-model-row");
  if (!row) return;
  const item = selectedModels.get(row.dataset.model);
  if (!item) return;
  if (event.target.classList.contains("sm-enabled")) item.enabled = event.target.checked;
});
selectedModelsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove]");
  if (button) removeSelectedModel(button.dataset.remove);
});

// 手动添加模型 ID
document.getElementById("add-manual").addEventListener("click", () => {
  const input = modelForm.elements.modelId;
  addSelectedModel(input.value);
  input.value = "";
});

// 勾选列表变化
modelCheckList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-model]");
  if (!checkbox) return;
  if (checkbox.checked) addSelectedModel(checkbox.dataset.model);
  else removeSelectedModel(checkbox.dataset.model);
});

async function fetchModelList(form) {
  const picker = pickerOf(form);
  const baseUrl = form.elements.baseUrl.value.trim();
  const apiKey = form.elements.apiKey.value.trim();
  const protocol = form.elements.protocol.value;
  // 编辑表单带隐藏 id 字段：Key 留空时服务端自动使用已保存的 Key
  const idInput = form.querySelector('input[name="id"]');
  const configId = idInput && idInput.value ? Number(idInput.value) : undefined;
  if (!/^https?:\/\//i.test(baseUrl)) {
    picker.status.textContent = "请先填写 Base URL";
    picker.status.className = "status err";
    return;
  }
  if (!apiKey && !Number.isFinite(configId)) {
    picker.status.textContent = "请先填写 API Key";
    picker.status.className = "status err";
    return;
  }
  picker.button.disabled = true;
  picker.button.textContent = "拉取中…";
  picker.status.textContent = apiKey ? "正在从上游获取模型列表…" : "正在使用已保存的 API Key 获取模型列表…";
  picker.status.className = "status";
  try {
    const data = await api("/api/admin/fetch-models", {
      method: "POST",
      body: JSON.stringify({ baseUrl, apiKey, protocol, id: Number.isFinite(configId) ? configId : undefined }),
    });
    const models = data.models ?? [];
    // 渲染勾选列表（保留已选中的勾选状态）
    modelCheckList.innerHTML = models.map((id) => `
      <label class="model-check-item">
        <span class="model-check-name">${esc(id)}</span>
        <input type="checkbox" data-model="${esc(id)}" ${selectedModels.has(id) ? "checked" : ""}>
      </label>`).join("");
    modelCheckList.hidden = false;
    picker.status.textContent = `已获取 ${models.length} 个模型，勾选后可在下方单独设置`;
    picker.status.className = "status ok";
  } catch (error) {
    modelCheckList.hidden = true;
    picker.status.textContent = `获取失败：${error.message}`;
    picker.status.className = "status err";
  } finally {
    picker.button.disabled = false;
    picker.button.textContent = "获取模型列表";
  }
}

// 绑定两处 model-picker（新增表单 + 编辑弹层）
for (const form of [modelForm, editForm]) {
  const picker = pickerOf(form);
  picker.button.addEventListener("click", () => { void fetchModelList(form); });
}

// ---------- 新增 / 编辑提交 ----------

async function submitModel(form, path, method) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.intervalMinutes = Number(data.intervalMinutes);
  data.retention = Number(data.retention);
  data.sortOrder = Number(data.sortOrder || 0);
  data.enabled = form.elements.enabled.checked;
  data.promptId = form.elements.promptId ? form.elements.promptId.value : null;
  await api(path, { method, body: JSON.stringify(data) });
}

modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedModels.size) {
    showBanner("请先选择至少一个模型（获取列表后勾选，或手动输入添加）");
    return;
  }
  try {
    const data = await api("/api/admin/models-bulk", {
      method: "POST",
      body: JSON.stringify({
        name: modelForm.elements.name.value.trim(),
        protocol: modelForm.elements.protocol.value,
        baseUrl: modelForm.elements.baseUrl.value.trim(),
        apiKey: modelForm.elements.apiKey.value.trim(),
        promptId: modelForm.elements.promptId ? modelForm.elements.promptId.value : null,
        models: [...selectedModels.values()],
      }),
    });
    const created = data.created?.length ?? 0;
    const failed = data.errors?.length ?? 0;
    showBanner(failed
      ? `已创建 ${created} 个模型，${failed} 个失败：${data.errors.join("；")}`
      : `已创建 ${created} 个模型（分组「${modelForm.elements.name.value.trim()}」）`);
    modelForm.reset();
    modelForm.elements.intervalMinutes.value = 60;
    modelForm.elements.retention.value = 10;
    modelForm.elements.enabled.checked = true;
    selectedModels.clear();
    renderSelectedModels();
    resetPicker(modelForm);
    void refreshModels();
    void refreshStats();
    switchView("models");
  } catch (error) {
    showBanner(error.message);
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await submitModel(editForm, `/api/admin/models/${editForm.id.value}`, "PUT");
    editDialog.close();
    void refreshModels();
    void refreshStats();
    showBanner("修改已保存");
  } catch (error) {
    showBanner(error.message);
  }
});

document.getElementById("edit-cancel").addEventListener("click", () => editDialog.close());

// 分组编辑：批量设置组内所有模型
document.getElementById("group-edit-cancel").addEventListener("click", () => groupEditDialog.close());
groupEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const groupName = groupEditForm.groupName.value;
  const body = { groupName };
  const thinkingLevel = groupEditForm.thinkingLevel.value;
  if (thinkingLevel) body.thinkingLevel = thinkingLevel;
  const intervalMinutes = groupEditForm.intervalMinutes.value;
  if (intervalMinutes) body.intervalMinutes = Number(intervalMinutes);
  const retention = groupEditForm.retention.value;
  if (retention) body.retention = Number(retention);
  const sortOrder = groupEditForm.sortOrder.value;
  if (sortOrder !== "") body.sortOrder = Number(sortOrder);
  body.enabled = groupEditForm.enabled.checked;
  try {
    const data = await api("/api/admin/models-group", { method: "PUT", body: JSON.stringify(body) });
    groupEditDialog.close();
    showBanner(`已批量更新「${groupName}」的 ${data.updated} 个模型`);
    void refreshModels();
    void refreshStats();
  } catch (error) {
    showBanner(error.message);
  }
});

// 编辑弹层「测试连接」：用表单当前值测试（Key 留空时服务端自动用已保存的 Key）
document.getElementById("edit-test").addEventListener("click", async (event) => {
  const button = event.target;
  const status = document.getElementById("edit-test-status");
  const baseUrl = editForm.elements.baseUrl.value.trim();
  const modelId = editForm.elements.modelId.value.trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    status.textContent = "请先填写 Base URL";
    status.className = "status err";
    return;
  }
  if (!modelId) {
    status.textContent = "请先填写模型 ID";
    status.className = "status err";
    return;
  }
  button.disabled = true;
  button.textContent = "测试中…";
  status.textContent = "正在发送测试消息…";
  status.className = "status";
  try {
    const result = await api("/api/admin/test-model", {
      method: "POST",
      body: JSON.stringify({
        id: Number(editForm.querySelector('input[name="id"]').value),
        baseUrl,
        apiKey: editForm.elements.apiKey.value.trim(),
        protocol: editForm.elements.protocol.value,
        modelId,
      }),
    });
    if (result.ok) {
      status.textContent = `✓ 测试成功：${(result.durationMs / 1000).toFixed(1)}s 收到回复「${result.reply}」`;
      status.className = "status ok";
    } else {
      status.textContent = `✕ 测试失败：${result.error}`;
      status.className = "status err";
    }
  } catch (error) {
    status.textContent = `✕ 测试失败：${error.message}`;
    status.className = "status err";
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
});

// ---------- 概览 ----------

async function refreshStats() {
  try {
    const { stats } = await api("/api/admin/overview");
    const totalSamples = stats.reduce((sum, row) => sum + row.samples, 0);
    const totalSuccess = stats.reduce((sum, row) => sum + row.successCount, 0);
    const totalFailed = stats.reduce((sum, row) => sum + row.failedCount, 0);
    const durations = stats.filter((row) => row.avgDurationMs != null);
    const avgDuration = durations.length ? durations.reduce((sum, row) => sum + row.avgDurationMs, 0) / durations.length : null;
    statCards.innerHTML = `
      <div class="stat-card"><div class="k">模型数</div><div class="v">${stats.length}</div></div>
      <div class="stat-card"><div class="k">样本总数</div><div class="v">${totalSamples}</div></div>
      <div class="stat-card"><div class="k">成功 / 失败</div><div class="v">${totalSuccess} / ${totalFailed}</div></div>
      <div class="stat-card"><div class="k">平均耗时</div><div class="v">${avgDuration != null ? (avgDuration / 1000).toFixed(1) + "s" : "—"}</div></div>`;
    if (!stats.length) {
      statsBody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">暂无数据</td></tr>';
      return;
    }
    // 按名称分组聚合（一组一行，展开显示子模型）
    const groupMap = new Map();
    for (const row of stats) {
      if (!groupMap.has(row.name)) groupMap.set(row.name, []);
      groupMap.get(row.name).push(row);
    }
    let html = "";
    for (const [name, groupStats] of groupMap) {
      const multi = groupStats.length > 1;
      const gSamples = groupStats.reduce((s, r) => s + r.samples, 0);
      const gSuccess = groupStats.reduce((s, r) => s + r.successCount, 0);
      const gFailed = groupStats.reduce((s, r) => s + r.failedCount, 0);
      const gDurations = groupStats.filter((r) => r.avgDurationMs != null);
      const gAvgDuration = gDurations.length ? gDurations.reduce((s, r) => s + r.avgDurationMs * r.successCount, 0) / Math.max(1, gSuccess) : null;
      const gAvgTokens = groupStats.filter((r) => r.avgTotalTokens != null);
      const gAvgTokensVal = gAvgTokens.length ? Math.round(gAvgTokens.reduce((s, r) => s + r.avgTotalTokens * r.successCount, 0) / Math.max(1, gSuccess)) : null;
      html += `
        <tr class="group-row" data-group="${esc(name)}">
          <td><b>${esc(name)}</b>${multi ? ` <span class="st st-info">${groupStats.length} 个模型</span>` : ""}</td>
          <td class="num">${gSamples}</td>
          <td class="num">${gSuccess}</td>
          <td class="num">${gFailed}</td>
          <td class="num">${gAvgDuration != null ? `${(gAvgDuration / 1000).toFixed(1)}s` : "—"}</td>
          <td class="num">${gAvgTokensVal != null ? gAvgTokensVal : "—"}</td>
        </tr>`;
      if (multi) {
        for (const row of groupStats) {
          html += `
        <tr class="sub-row" data-group="${esc(name)}" hidden>
          <td class="muted" style="padding-left:32px">└ ${esc(row.modelId ?? row.id)}</td>
          <td class="num">${row.samples}</td>
          <td class="num">${row.successCount}</td>
          <td class="num">${row.failedCount}</td>
          <td class="num">${row.avgDurationMs != null ? `${(row.avgDurationMs / 1000).toFixed(1)}s` : "—"}</td>
          <td class="num">${row.avgTotalTokens != null ? row.avgTotalTokens : "—"}</td>
        </tr>`;
        }
      }
    }
    statsBody.innerHTML = html;
    // 恢复展开状态
    for (const groupName of expandedGroups) {
      for (const row of statsBody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`)) {
        row.hidden = false;
      }
    }
  } catch {
    // 未登录时静默
  }
}

// 运行概览：点击分组行展开/收起子模型
statsBody.addEventListener("click", (event) => {
  const groupRow = event.target.closest(".group-row");
  if (!groupRow) return;
  const groupName = groupRow.dataset.group;
  const subRows = statsBody.querySelectorAll(`.sub-row[data-group="${CSS.escape(groupName)}"]`);
  if (!subRows.length) return;
  const expanding = subRows[0].hidden;
  if (expanding) expandedGroups.add(groupName);
  else expandedGroups.delete(groupName);
  for (const row of subRows) row.hidden = !expanding;
});

// ---------- 生成日志（实时流式） ----------

const genLogsList = document.getElementById("gen-logs-list");
const genLogsCount = document.getElementById("gen-logs-count");

// 内容更新时若原本贴底则保持贴底（终端式跟随输出）
function stickToBottom(el, update) {
  if (!el) { update(); return; }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  update();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function buildGenLogEntry(log) {
  const el = document.createElement("div");
  el.className = `genlog ${log.status === "running" ? "running" : ""}`;
  el.dataset.logId = log.id;
  el.innerHTML = `
    <div class="genlog-head">
      <b class="genlog-model"></b>
      <span class="st genlog-status"></span>
      <span class="muted genlog-time"></span>
      <span class="muted genlog-metric"></span>
      <span class="st st-bad genlog-error" hidden></span>
      <span class="muted" style="margin-left:auto">正文 <span class="genlog-chars">0</span> 字符</span>
    </div>
    <div class="genlog-content"><span class="genlog-text"></span><div class="genlog-thinking" hidden></div></div>
    <details class="genlog-prompt"><summary>查看提示词</summary><pre></pre></details>`;
  updateGenLogEntry(el, log);
  return el;
}

function updateGenLogEntry(el, log) {
  const running = log.status === "running";
  el.classList.toggle("running", running);
  el.querySelector(".genlog-model").textContent = log.model;
  const statusEl = el.querySelector(".genlog-status");
  statusEl.textContent = running ? "⟳ 生成中" : log.status === "success" ? "成功" : "失败";
  statusEl.className = `st genlog-status ${running ? "st-info" : log.status === "success" ? "st-ok" : "st-bad"}`;
  el.querySelector(".genlog-time").textContent = fmtTime(log.startedAt);
  const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : "—";
  const tokens = log.tokens != null ? ` · ${log.tokens} tokens` : "";
  el.querySelector(".genlog-metric").textContent = duration + tokens;
  const errorEl = el.querySelector(".genlog-error");
  errorEl.hidden = !log.error;
  if (log.error) {
    errorEl.textContent = log.error.length > 60 ? log.error.slice(0, 60) + "…" : log.error;
    errorEl.title = log.error;
  }
  el.querySelector(".genlog-chars").textContent = log.contentLength;
  // 内容就地更新 + 贴底跟随（不重建 DOM，滚动位置与展开状态都保留）
  const textEl = el.querySelector(".genlog-text");
  const thinkEl = el.querySelector(".genlog-thinking");
  const contentEl = el.querySelector(".genlog-content");
  stickToBottom(contentEl, () => {
    textEl.textContent = log.contentTail || (running ? "（尚未收到内容…）" : "");
    thinkEl.hidden = !log.thinkingTail;
    if (log.thinkingTail) thinkEl.textContent = `【思考 ${log.thinkingLength} 字符】\n${log.thinkingTail}`;
  });
  const promptPre = el.querySelector(".genlog-prompt pre");
  if (promptPre.textContent === "") promptPre.textContent = log.prompt;
}

async function refreshGenLogs() {
  let logs;
  try {
    logs = (await api("/api/admin/gen-logs")).logs;
  } catch (error) {
    if (error.message.includes("未登录")) { showLogin(); return; }
    return; // 静默，下次轮询重试
  }
  genLogsCount.textContent = `${logs.length} 条`;
  if (!logs.length) {
    genLogsList.innerHTML = '<p class="muted" style="text-align:center;padding:32px">还没有生成记录。触发生成后会实时显示提示词与内容。</p>';
    genLogsList.dataset.empty = "1";
    return;
  }
  if (genLogsList.dataset.empty === "1" || !genLogsList.querySelector(".genlog")) genLogsList.innerHTML = "";
  delete genLogsList.dataset.empty;
  // 就地同步：已有条目更新内容，新条目按顺序插入，被淘汰的移除
  const existing = new Map([...genLogsList.querySelectorAll(".genlog")].map((el) => [el.dataset.logId, el]));
  for (const log of logs) {
    const el = existing.get(log.id);
    if (el) {
      existing.delete(log.id);
      updateGenLogEntry(el, log);
    } else {
      genLogsList.insertBefore(buildGenLogEntry(log), null);
    }
  }
  for (const el of existing.values()) el.remove();
  // 按最新在前排序
  const ordered = logs.map((log) => genLogsList.querySelector(`[data-log-id="${log.id}"]`));
  for (const el of ordered) genLogsList.appendChild(el);
}

// ---------- Base URL 历史下拉 ----------

const baseUrlList = document.getElementById("base-url-list");

async function loadBaseUrlHistory() {
  try {
    const { urls } = await api("/api/admin/base-url-history");
    baseUrlList.innerHTML = urls.map((url) => `<option value="${esc(url)}"></option>`).join("");
  } catch {
    // 静默失败，不影响表单使用
  }
}

// ---------- 提示词管理 ----------

const promptsList = document.getElementById("prompts-list");
const promptEditDialog = document.getElementById("prompt-edit-dialog");
const promptEditForm = document.getElementById("prompt-edit-form");
let promptCache = []; // 缓存提示词列表，供模型表单下拉使用

async function refreshPrompts() {
  let prompts;
  try {
    prompts = (await api("/api/admin/prompts")).prompts;
  } catch (error) {
    if (error.message.includes("未登录")) { showLogin(); return; }
    return;
  }
  promptCache = prompts;
  if (!prompts.length) {
    promptsList.innerHTML = '<p class="muted" style="text-align:center;padding:32px">还没有提示词。点击右上角「新增提示词」添加。</p>';
    return;
  }
  promptsList.innerHTML = prompts.map((p) => `
    <div class="genlog" data-prompt-id="${p.id}">
      <div class="genlog-head">
        <b>${esc(p.name)}</b>
        ${p.isDefault ? '<span class="st st-ok">默认</span>' : ""}
        <span class="muted" style="margin-left:auto">${p.content.length} 字符</span>
        <button type="button" class="btn btn-sm btn-ghost" data-action="edit-prompt" data-id="${p.id}">编辑</button>
        ${p.isDefault ? "" : `<button type="button" class="btn btn-sm btn-danger" data-action="delete-prompt" data-id="${p.id}">删除</button>`}
      </div>
      <div class="genlog-content" style="max-height:120px">${esc(p.content)}</div>
    </div>`).join("");
}

// 提示词列表操作
promptsList.addEventListener("click", async (event) => {
  const editBtn = event.target.closest('button[data-action="edit-prompt"]');
  if (editBtn) {
    const prompt = promptCache.find((p) => String(p.id) === editBtn.dataset.id);
    if (!prompt) return;
    promptEditForm.id.value = prompt.id;
    promptEditForm.name.value = prompt.name;
    promptEditForm.content.value = prompt.content;
    promptEditForm.isDefault.checked = prompt.isDefault;
    document.getElementById("prompt-edit-title").textContent = `编辑提示词「${prompt.name}」`;
    promptEditDialog.showModal();
    return;
  }
  const delBtn = event.target.closest('button[data-action="delete-prompt"]');
  if (delBtn) {
    if (!window.confirm("确定删除该提示词？使用此提示词的模型将回退到默认提示词。")) return;
    try {
      await api(`/api/admin/prompts/${delBtn.dataset.id}`, { method: "DELETE" });
      void refreshPrompts();
    } catch (error) {
      showBanner(error.message);
    }
  }
});

// 新增提示词
document.getElementById("btn-add-prompt").addEventListener("click", () => {
  promptEditForm.reset();
  promptEditForm.id.value = "";
  document.getElementById("prompt-edit-title").textContent = "新增提示词";
  promptEditDialog.showModal();
});

document.getElementById("prompt-edit-cancel").addEventListener("click", () => promptEditDialog.close());

promptEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = promptEditForm.id.value;
  const body = {
    name: promptEditForm.name.value.trim(),
    content: promptEditForm.content.value.trim(),
    isDefault: promptEditForm.isDefault.checked,
  };
  try {
    if (id) {
      await api(`/api/admin/prompts/${id}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/api/admin/prompts", { method: "POST", body: JSON.stringify(body) });
    }
    promptEditDialog.close();
    void refreshPrompts();
  } catch (error) {
    showBanner(error.message);
  }
});

// 加载提示词选项（供模型表单下拉）
async function loadPromptOptions() {
  try {
    const { prompts } = await api("/api/admin/prompts");
    promptCache = prompts;
    // 填充新增表单和编辑表单的提示词下拉
    for (const select of document.querySelectorAll("select[name='promptId']")) {
      const current = select.value;
      select.innerHTML = '<option value="">默认提示词</option>' + prompts.map((p) =>
        `<option value="${p.id}" ${p.isDefault ? 'title="默认"' : ""}>${esc(p.name)}${p.isDefault ? "（默认）" : ""}</option>`
      ).join("");
      if (current) select.value = current;
    }
  } catch {
    // 静默
  }
}

// ---------- 启动 ----------

void checkSession();
setInterval(() => {
  if (adminView.hidden) return;
  // 只刷新当前可见视图的数据
  if (!document.getElementById("view-models").hidden) void refreshModels();
  if (!document.getElementById("view-stats").hidden) void refreshStats();
}, 15000);
// 生成日志：1 秒轮询实时流式刷新（仅在该视图可见时）
setInterval(() => {
  if (adminView.hidden) return;
  if (!document.getElementById("view-logs").hidden) void refreshGenLogs();
}, 1000);
