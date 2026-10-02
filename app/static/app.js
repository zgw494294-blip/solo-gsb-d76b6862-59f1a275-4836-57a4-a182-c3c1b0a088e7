"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  mergeIds: [], // 勾选待合并的两条条款 id
  preview: null, // 服务端 /api/preview 返回；仅当 previewFresh 为真时与当前草稿对应
  dragId: null,
  epoch: 0, // 草稿世代：导入成功 / 重新导入时 +1；上一草稿的迟到响应一律丢弃
  rev: 0, // 草稿修订号：任何本地改动 +1；响应发出后草稿又有改动的，响应不再适用
  previewFresh: false, // 页面预览是否已追上最新草稿；未追上时禁止下载与合并
  importing: false, // /api/import 在途（期间忽略重复提交）
  saving: false, // /api/save 在途
  merging: false, // /api/merge 在途（期间阻止编辑 / 删除 / 重排 / 勾选 / 重复合并）
  exporting: false, // /api/export 在途
};

let previewSeq = 0; // 预览请求序号：只采用最后一次发出的预览响应
let exportSeq = 0; // 下载请求序号：只有仍持有它的下载能收尾按钮；重新导入 / 新下载会作废旧下载的收尾权

const MARKER = /\[\[(?:原(\d+)\?|(\d+))\]\]/g; // 预览文本中的引用形态

const $ = (sel) => document.querySelector(sel);

const importPanel = $("#import-panel");
const desk = $("#desk");
const importText = $("#import-text");
const importErrors = $("#import-errors");
const importBtn = $("#import-btn");
const clauseList = $("#clause-list");
const previewText = $("#preview-text");
const brokenBanner = $("#broken-banner");
const downloadBtn = $("#download-btn");
const mergeBtn = $("#merge-btn");
const statCount = $("#stat-count");
const statBroken = $("#stat-broken");

// --------------------------------------------------------------------------- //
// 工具
// --------------------------------------------------------------------------- //
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error("api error");
    err.status = res.status;
    err.errors = (data.detail && data.detail.errors) || ["请求失败"];
    throw err;
  }
  return data;
}

function snapshot() {
  return {
    order_ids: state.orderIds,
    clauses: state.clauses.map((c) => ({ id: c.id, body: c.body })),
  };
}

// --------------------------------------------------------------------------- //
// 草稿改动与工具栏状态
// --------------------------------------------------------------------------- //
// 任何本地草稿改动都要经过 touch()：修订号 +1（使在途响应失效）、
// 标记预览未追上最新草稿（期间禁止下载 / 合并），直到下一次预览响应被采用。
function touch() {
  state.rev += 1;
  state.previewFresh = false;
  syncToolbar();
}

function syncToolbar() {
  updateMergeBtn();
  updateDownloadBtn();
}

function updateMergeBtn() {
  if (state.merging) {
    mergeBtn.disabled = true;
    mergeBtn.textContent = "合并中…";
    return;
  }
  mergeBtn.disabled =
    state.editingId !== null || !state.previewFresh || state.mergeIds.length !== 2;
  mergeBtn.textContent =
    state.mergeIds.length === 2 ? "合并所选（2 条）" : "合并所选";
}

function updateDownloadBtn() {
  downloadBtn.disabled =
    state.exporting ||
    state.merging ||
    !state.previewFresh ||
    !state.preview ||
    state.preview.has_broken;
  downloadBtn.textContent = state.exporting ? "下载中…" : "下载纯文本";
}

// --------------------------------------------------------------------------- //
// 导入
// --------------------------------------------------------------------------- //
const SAMPLE = [
  "1|甲方应在合同签订后七日内交付设备。",
  "2|乙方按第 [[1]] 条验收合格后三十日内付款。",
  "3|设备规格与数量见附件，不符合的按 [[1]] 退换。",
  "4|因本合同产生的争议，按 [[5]] 处理。",
  "5|争议提交甲方所在地仲裁委员会仲裁。",
].join("\n");

$("#sample-btn").addEventListener("click", () => {
  importText.value = SAMPLE;
  importErrors.hidden = true;
});

importBtn.addEventListener("click", async () => {
  if (state.importing) return; // 忽略等待期间的重复提交
  state.importing = true;
  importBtn.disabled = true;
  importBtn.textContent = "导入中…";
  try {
    const data = await api("/api/import", { text: importText.value });
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: c.original,
      body: c.body,
    }));
    state.orderIds = state.clauses.map((c) => c.id);
    state.editingId = null;
    state.mergeIds = [];
    state.preview = null;
    state.epoch += 1; // 新草稿世代：上一草稿的在途请求全部作废
    touch();
    importErrors.hidden = true;
    importPanel.hidden = true;
    desk.hidden = false;
    render();
  } catch (e) {
    importErrors.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
    importErrors.hidden = false;
  } finally {
    state.importing = false;
    importBtn.disabled = false;
    importBtn.textContent = "导入";
  }
});

$("#reimport-btn").addEventListener("click", () => {
  if (!confirm("重新导入将丢弃当前草稿，确定继续？")) return;
  // 世代 +1：所有在途请求（预览 / 保存 / 合并 / 下载）的迟到响应都会被丢弃，
  // 其成功或失败不再影响新草稿及提示、按钮状态
  state.epoch += 1;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.mergeIds = [];
  state.preview = null;
  state.previewFresh = false;
  state.rev += 1;
  state.saving = false;
  state.merging = false;
  state.exporting = false;
  exportSeq += 1; // 作废旧下载对等待状态的收尾权：其成功或失败都不得解锁新草稿的下载按钮
  clauseList.classList.remove("busy");
  desk.hidden = true;
  importPanel.hidden = false;
  syncToolbar();
});

// --------------------------------------------------------------------------- //
// 渲染（数据全部以服务端 /api/preview 为准）
// --------------------------------------------------------------------------- //
async function render() {
  const epoch = state.epoch;
  const rev = state.rev;
  const seq = ++previewSeq;
  let data;
  try {
    data = await api("/api/preview", snapshot());
  } catch (e) {
    if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return; // 迟到响应：丢弃
    state.previewFresh = false; // 预览未追上草稿：保持禁止下载 / 合并
    syncToolbar();
    alert("预览刷新失败：\n" + e.errors.join("\n"));
    return;
  }
  // 只采用仍适用于当前草稿的响应：之后已发出更新的预览、或草稿已变化 / 已重新导入，则丢弃
  if (seq !== previewSeq || epoch !== state.epoch || rev !== state.rev) return;
  state.preview = data;
  state.previewFresh = true;

  clauseList.classList.toggle("busy", state.merging);
  clauseList.textContent = "";
  let brokenTotal = 0;
  const brokenLines = [];

  for (const item of data.items) {
    brokenTotal += item.broken.length;
    if (item.broken.length) {
      const marks = item.broken.map((b) => `[[原${b.original}?]]`).join("、");
      brokenLines.push(
        `<li>第 ${item.display} 条（导入时原第 ${item.original} 条）中的 ${esc(marks)} 已失去目标（原条款已删除）</li>`,
      );
    }

    const li = document.createElement("li");
    li.className =
      "card" +
      (item.broken.length ? " source-broken" : "") +
      (state.mergeIds.includes(item.id) ? " selected" : "");
    li.id = `card-${item.id}`;
    li.dataset.id = item.id;

    const isEditing = state.editingId === item.id;
    li.innerHTML = `
      <div class="card-head">
        <input type="checkbox" class="merge-pick" title="勾选后与另一条合并（按当前显示顺序）"
          ${state.mergeIds.includes(item.id) ? "checked" : ""}
          ${state.editingId ? "disabled" : ""} />
        <span class="grip" title="拖拽调整顺序">⠿</span>
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="card-actions">
          ${
            isEditing
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || state.editingId ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || state.editingId ? "disabled" : ""
                 }>↓</button>
                 <button data-action="edit" ${state.editingId ? "disabled" : ""}>编辑正文</button>
                 <button data-action="delete" class="danger" ${
                   state.editingId ? "disabled" : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : `<div class="card-body">${bodyHtml(item)}</div>`}
    `;
    clauseList.appendChild(li);
  }

  // 顶部状态
  statCount.textContent = `共 ${data.items.length} 条`;
  statBroken.hidden = brokenTotal === 0;
  statBroken.textContent = `${brokenTotal} 处失效引用`;
  syncToolbar();

  // 失效引用横幅
  if (brokenLines.length) {
    brokenBanner.hidden = false;
    brokenBanner.innerHTML =
      `<strong>存在失效引用，修复前禁止下载。</strong>请编辑下列条款，把失效标记改为有效的 [[当前编号]]，或删除该标记：<ul>${brokenLines.join(
        "",
      )}</ul>`;
  } else {
    brokenBanner.hidden = true;
    brokenBanner.textContent = "";
  }

  // 纯文本预览：直接用服务端解析出的 text 拼装，与 /api/export 完全同一逻辑
  const plain = data.items.map((it) => `${it.display}|${it.text}`).join("\n");
  previewText.textContent = plain;
  previewText.classList.toggle("blocked", data.has_broken);

  attachDnd();
}

// 预览正文：把 [[n]] 渲染为可点击引用、[[原X?]] 渲染为失效标记
// 仅在预览响应与当前草稿一致时才会执行（render 已校验），
// 因此这里用 state.orderIds 解释 [[n]] 不会拿新顺序去套旧编号
function bodyHtml(item) {
  let html = "";
  let last = 0;
  for (const m of item.text.matchAll(MARKER)) {
    html += esc(item.text.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="ref dead" title="失效引用：原第 ${m[1]} 条已删除，请编辑本条修复">[[原${m[1]}?]]</span>`;
    } else {
      const target = state.orderIds[parseInt(m[2], 10) - 1];
      html += `<button type="button" class="ref" data-goto="${esc(target)}">[[${m[2]}]]</button>`;
    }
    last = m.index + m[0].length;
  }
  html += esc(item.text.slice(last));
  return html;
}

function editorHtml(item) {
  return `
    <div class="editor">
      <textarea data-role="edit-text">${esc(item.text)}</textarea>
      <div class="editor-actions">
        <button data-action="save" class="primary">保存</button>
        <button data-action="cancel">取消</button>
        <span class="edit-hint">
          单行条款（回车不换行）；[[数字]] 按保存当刻的显示编号绑定；${
            item.broken.length ? "<b>请先修复 [[原X?]] 标记</b>，否则无法保存；" : ""
          }Ctrl+Enter 快速保存
        </span>
      </div>
      <ul class="edit-errors" data-role="edit-errors" hidden></ul>
    </div>`;
}

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
clauseList.addEventListener("change", (ev) => {
  const pick = ev.target.closest(".merge-pick");
  if (!pick) return;
  const id = pick.closest(".card").dataset.id;
  if (state.merging) {
    pick.checked = state.mergeIds.includes(id); // 合并提交期间不允许改动选择
    return;
  }
  if (pick.checked) {
    if (state.mergeIds.length >= 2) {
      // 一次只能合并两条：取消本次勾选并提示
      pick.checked = false;
      alert("一次只能合并两条条款：请先取消已勾选的条款。");
      return;
    }
    state.mergeIds.push(id);
  } else {
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
  }
  document.getElementById(`card-${id}`).classList.toggle("selected", pick.checked);
  updateMergeBtn();
});

mergeBtn.addEventListener("click", async () => {
  if (state.merging) return; // 阻止重复提交
  if (state.editingId) {
    alert("请先保存或取消正在编辑的正文，再合并条款。");
    return;
  }
  if (state.mergeIds.length !== 2 || !state.previewFresh || !state.preview) return;

  // 按当前显示顺序确定较前 / 较后条款
  const [a, b] = state.mergeIds;
  const keepId = state.orderIds.indexOf(a) < state.orderIds.indexOf(b) ? a : b;
  const dropId = keepId === a ? b : a;
  const previewById = Object.fromEntries(state.preview.items.map((it) => [it.id, it]));
  const keep = previewById[keepId];
  const drop = previewById[dropId];
  const inbound = state.clauses.filter(
    (c) => c.body.includes(`[[${dropId}]]`),
  ).length;

  const msg =
    `将把当前第 ${drop.display} 条并入第 ${keep.display} 条：\n\n` +
    `第 ${keep.display} 条：${keep.text}\n` +
    `第 ${drop.display} 条：${drop.text}\n\n` +
    `合并后正文（全角分号连接）：\n${keep.text}；${drop.text}\n\n` +
    `合并结果沿用第 ${keep.display} 条（原第 ${keep.original} 条）的位置与身份，` +
    `第 ${drop.display} 条移除，其余条款顺序不变。\n` +
    `共有 ${inbound} 处引用指向第 ${drop.display} 条，合并后全部改指合并结果；` +
    `其他引用不变，已失效引用仍保持失效。\n` +
    `此操作在重新导入或刷新前不可撤销，确定合并？`;
  if (!confirm(msg)) return;

  const epoch = state.epoch;
  // 提交期间阻止编辑 / 删除 / 重排 / 勾选 / 重复合并，成功或失败后恢复
  state.merging = true;
  clauseList.classList.add("busy");
  syncToolbar();
  try {
    const data = await api("/api/merge", {
      ...snapshot(),
      keep_id: keepId,
      drop_id: dropId,
    });
    if (epoch !== state.epoch) return; // 已重新导入：旧合并结果不得作用于新草稿
    // 仅在服务端成功后才改动草稿，保证列表 / 预览 / 下载立即对应同一份草稿
    state.orderIds = data.order_ids;
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: parseInt(c.id.slice(1), 10),
      body: c.body,
    }));
    state.mergeIds = [];
    state.merging = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    // 合并失败：草稿未改动，恢复被暂时阻止的操作（勾选保持不变，可修正后重试）
    state.merging = false;
    alert("合并失败，草稿未改动：\n" + e.errors.join("\n"));
  } finally {
    clauseList.classList.toggle("busy", state.merging);
    syncToolbar();
  }
});

// --------------------------------------------------------------------------- //
// 列表交互（事件委托）
// --------------------------------------------------------------------------- //
clauseList.addEventListener("click", async (ev) => {
  const goto = ev.target.closest("[data-goto]");
  if (goto) {
    const card = document.getElementById(`card-${goto.dataset.goto}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const action = btn.dataset.action;

  // 编辑中或合并提交中：阻止 编辑 / 删除 / 重排（按钮已禁用，这里再兜底）
  if (["up", "down", "edit", "delete"].includes(action) && (state.editingId || state.merging))
    return;

  if (action === "up" || action === "down") {
    const idx = state.orderIds.indexOf(id);
    const j = action === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= state.orderIds.length) return;
    [state.orderIds[idx], state.orderIds[j]] = [state.orderIds[j], state.orderIds[idx]];
    touch();
    render();
  } else if (action === "edit") {
    state.editingId = id;
    render().then(() => {
      const ta = clauseList.querySelector(`#card-${id} textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener("keydown", onEditorKey);
      }
    });
  } else if (action === "delete") {
    const inbound = state.clauses.filter(
      (c) => c.id !== id && c.body.includes(`[[${id}]]`),
    ).length;
    const msg =
      `确定删除该条款？\n` +
      (inbound ? `有 ${inbound} 条条款引用它，删除后这些引用将标为失效，修复前无法下载。\n` : "") +
      `（编号会自动重排，此操作在重新导入或刷新前不可撤销）`;
    if (!confirm(msg)) return;
    state.orderIds = state.orderIds.filter((x) => x !== id);
    state.clauses = state.clauses.filter((c) => c.id !== id);
    state.mergeIds = state.mergeIds.filter((x) => x !== id);
    touch();
    render();
  } else if (action === "cancel") {
    state.editingId = null;
    render();
  } else if (action === "save") {
    await saveEdit(id);
  }
});

function onEditorKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    // 只处理单行条款：Enter 不插入换行；Ctrl/⌘+Enter 保存
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) saveEdit(state.editingId);
  }
}

async function saveEdit(id) {
  if (state.saving) return; // 忽略等待期间的重复提交
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const text = card.querySelector("textarea").value;
  const epoch = state.epoch;
  state.saving = true;
  setEditorBusy(id, true);
  try {
    const data = await api("/api/save", { ...snapshot(), edit_id: id, text });
    if (epoch !== state.epoch) return; // 已重新导入：旧保存结果不得作用于新草稿
    const clause = state.clauses.find((c) => c.id === id);
    if (clause) clause.body = data.body;
    state.editingId = null;
    state.saving = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    state.saving = false;
    setEditorBusy(id, false);
    // 重新查询当前 DOM：等待期间可能有预览响应重建过编辑器
    const errBox = document
      .getElementById(`card-${id}`)
      ?.querySelector('[data-role="edit-errors"]');
    if (errBox) {
      errBox.innerHTML = e.errors.map((m) => `<li>${esc(m)}</li>`).join("");
      errBox.hidden = false;
    }
  }
}

// 保存等待期间禁用编辑器按钮，结束后恢复（DOM 可能已被重建，按当前节点操作）
function setEditorBusy(id, busy) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const saveBtn = card.querySelector('[data-action="save"]');
  const cancelBtn = card.querySelector('[data-action="cancel"]');
  if (saveBtn) {
    saveBtn.disabled = busy;
    saveBtn.textContent = busy ? "保存中…" : "保存";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

// --------------------------------------------------------------------------- //
// 拖拽重排
// --------------------------------------------------------------------------- //
function attachDnd() {
  for (const card of clauseList.querySelectorAll(".card")) {
    const grip = card.querySelector(".grip");
    grip.addEventListener("mousedown", () => {
      if (!state.editingId && !state.merging) card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId || state.merging) {
        ev.preventDefault();
        return;
      }
      state.dragId = card.dataset.id;
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
      card.classList.remove("dragging");
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      state.dragId = null;
    });
    card.addEventListener("dragover", (ev) => {
      if (!state.dragId || state.dragId === card.dataset.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      clauseList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      card.classList.add("drag-over");
    });
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const targetId = card.dataset.id;
      if (!state.dragId || state.dragId === targetId) return;
      const rect = card.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveClause(state.dragId, targetId, after);
    });
  }
}

function moveClause(srcId, targetId, after) {
  const ids = state.orderIds.filter((x) => x !== srcId);
  let idx = ids.indexOf(targetId);
  if (after) idx += 1;
  ids.splice(idx, 0, srcId);
  state.orderIds = ids;
  touch();
  render();
}

// --------------------------------------------------------------------------- //
// 下载（以服务端 /api/export 为准，保证与预览一致）
// --------------------------------------------------------------------------- //
downloadBtn.addEventListener("click", async () => {
  if (downloadBtn.disabled) return; // 预览未追上 / 有失效引用 / 在途时不允许下载
  // 取得本次下载对等待状态的唯一收尾权：等待期间重新导入或又发起一次下载时，
  // 序号会推进，旧下载的响应与收尾一律失效，不能保存旧文件、弹提示或解锁新下载
  const token = ++exportSeq;
  state.exporting = true;
  syncToolbar();
  const epoch = state.epoch;
  const rev = state.rev;
  try {
    const data = await api("/api/export", snapshot());
    if (token !== exportSeq) return; // 已重新导入 / 被新下载取代：旧响应静默丢弃
    if (epoch !== state.epoch) return; // 旧草稿的响应：静默丢弃
    if (rev !== state.rev) {
      // 等待期间草稿又有改动：下载内容已与页面不一致，取消本次下载
      alert("草稿在下载期间又有改动，本次下载已取消，请重新下载。");
      return;
    }
    const blob = new Blob([data.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    a.href = url;
    a.download = `clauses-${stamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (token !== exportSeq || epoch !== state.epoch || rev !== state.rev) return; // 已不属于当前下载：不提示
    alert(e.errors.join("\n"));
  } finally {
    // 只有仍持有收尾权的下载才能清掉等待状态：旧下载提前返回时不得解锁新下载
    if (token === exportSeq) {
      state.exporting = false;
      syncToolbar(); // 按当前草稿与预览状态恢复（可重试 / 可再次下载）
    }
  }
});
