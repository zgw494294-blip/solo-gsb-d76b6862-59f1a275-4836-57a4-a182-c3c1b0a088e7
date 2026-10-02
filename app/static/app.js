"use strict";

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const state = {
  clauses: [], // { id, original, body(内部形态 [[c3]]) }
  orderIds: [],
  editingId: null,
  mergeIds: [], // 勾选待合并的两条条款 id
  splittingId: null, // 正在选择拆分分界的条款 id（拆分界面打开期间，其他改稿操作同样锁定）
  splitOffset: null, // 已选分界在内部正文中的码点位置（与 Python 字符串下标一致）
  splitRoute: "front", // 原指向被拆条款的引用落到前段(front)还是后段(back)
  nextIdNum: 1, // 下一个可用的全新身份编号：只增不减，删除/合并移除的身份永不复用
  preview: null, // 服务端 /api/preview 返回；仅当 previewFresh 为真时与当前草稿对应
  dragId: null,
  epoch: 0, // 草稿世代：导入成功 / 重新导入时 +1；上一草稿的迟到响应一律丢弃
  rev: 0, // 草稿修订号：任何本地改动 +1；响应发出后草稿又有改动的，响应不再适用
  previewFresh: false, // 页面预览是否已追上最新草稿；未追上时禁止下载与合并
  importing: false, // /api/import 在途（期间忽略重复提交）
  saving: false, // /api/save 在途
  merging: false, // /api/merge 在途（期间阻止编辑 / 删除 / 重排 / 勾选 / 重复合并）
  splitting: false, // /api/split 在途（期间阻止其他一切改稿操作）
  exporting: false, // /api/export 在途
};

const MAX_CLAUSES = 40; // 与后端 MAX_LINES 一致：拆分后总数不得超过它

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
    state.editingId !== null ||
    state.splittingId !== null ||
    state.splitting ||
    !state.previewFresh ||
    state.mergeIds.length !== 2;
  mergeBtn.textContent =
    state.mergeIds.length === 2 ? "合并所选（2 条）" : "合并所选";
}

function updateDownloadBtn() {
  downloadBtn.disabled =
    state.exporting ||
    state.merging ||
    state.splitting ||
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
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRoute = "front";
    state.nextIdNum = state.clauses.length + 1; // 导入身份为 c1..cn，全新身份从 n+1 起
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
  // 世代 +1：所有在途请求（预览 / 保存 / 合并 / 拆分 / 下载）的迟到响应都会被丢弃，
  // 其成功或失败不再影响新草稿及提示、按钮状态
  state.epoch += 1;
  state.clauses = [];
  state.orderIds = [];
  state.editingId = null;
  state.mergeIds = [];
  state.splittingId = null;
  state.splitOffset = null;
  state.splitRoute = "front";
  state.nextIdNum = 1;
  state.preview = null;
  state.previewFresh = false;
  state.rev += 1;
  state.saving = false;
  state.merging = false;
  state.splitting = false;
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

  clauseList.classList.toggle("busy", state.merging || state.splitting);
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
    const isSplitting = state.splittingId === item.id;
    const locked = state.editingId || state.splittingId; // 编辑或拆分界面打开时，锁定各卡片的改稿操作
    li.innerHTML = `
      <div class="card-head">
        <input type="checkbox" class="merge-pick" title="勾选后与另一条合并（按当前显示顺序）"
          ${state.mergeIds.includes(item.id) ? "checked" : ""}
          ${locked ? "disabled" : ""} />
        <span class="grip" title="拖拽调整顺序">⠿</span>
        <span class="num">${item.display}</span>
        <span class="orig">（原第 ${item.original} 条）</span>
        ${item.broken.length ? '<span class="warn-tag">含失效引用</span>' : ""}
        <span class="card-actions">
          ${
            isEditing || isSplitting
              ? ""
              : `<button data-action="up" ${
                  item.display === 1 || locked ? "disabled" : ""
                }>↑</button>
                 <button data-action="down" ${
                   item.display === data.items.length || locked ? "disabled" : ""
                 }>↓</button>
                 <button data-action="edit" ${locked ? "disabled" : ""}>编辑正文</button>
                 <button data-action="split" ${locked ? "disabled" : ""}>拆分</button>
                 <button data-action="delete" class="danger" ${
                   locked ? "disabled" : ""
                 }>删除</button>`
          }
        </span>
      </div>
      ${isEditing ? editorHtml(item) : isSplitting ? splitterHtml(item) : `<div class="card-body">${bodyHtml(item)}</div>`}
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
// 拆分一条条款
// --------------------------------------------------------------------------- //
// 把内部正文切成“普通字符逐字 + 引用标记整体”的 token 序列，
// 每个 token 标注码点位置（for..of / Array.from 按码点迭代，与 Python 字符串下标一致），
// 分界只能落在 token 之间，因此引用标记（无论有效还是失效）永远不会被切开。
function tokenizeForSplit(body) {
  const tokens = [];
  const re = /\[\[[^\[\]]*\]\]/g;
  let pos = 0; // UTF-16 下标（供 slice 用）
  let cp = 0; // 码点下标（发给服务端的 offset）
  const pushChars = (text) => {
    for (const ch of text) {
      tokens.push({ kind: "ch", ch, cp });
      cp += 1;
    }
  };
  for (const m of body.matchAll(re)) {
    pushChars(body.slice(pos, m.index));
    tokens.push({ kind: "ref", id: m[0].slice(2, -2), cp });
    cp += Array.from(m[0]).length;
    pos = m.index + m[0].length;
  }
  pushChars(body.slice(pos));
  return tokens;
}

// 与服务端 resolve_body 同一逻辑的本地解析：[[cN]] → [[当前显示号]] 或 [[原N?]]
function resolveLocal(body) {
  return body.replace(/\[\[c(\d+)\]\]/g, (m, num) => {
    const pos = state.orderIds.indexOf(`c${num}`);
    return pos >= 0 ? `[[${pos + 1}]]` : `[[原${num}?]]`;
  });
}

function splitRefHtml(token) {
  const pos = state.orderIds.indexOf(token.id);
  if (pos >= 0) return `<span class="ref static">[[${pos + 1}]]</span>`;
  return `<span class="ref dead static">[[原${token.id.slice(1)}?]]</span>`;
}

function splitterHtml(item) {
  const clause = state.clauses.find((c) => c.id === item.id);
  const tokens = tokenizeForSplit(clause.body);
  let bodyStr = "";
  tokens.forEach((t, i) => {
    // 分界不能落在最前 / 最后（那样必有一段为空），只渲染 token 之间的分界
    if (i > 0) {
      bodyStr += `<span class="split-gap" data-offset="${t.cp}" title="在此拆分"></span>`;
    }
    bodyStr += t.kind === "ref" ? splitRefHtml(t) : `<span class="split-ch">${esc(t.ch)}</span>`;
  });
  const inbound = state.clauses.filter((c) => c.body.includes(`[[${item.id}]]`)).length;
  return `
    <div class="splitter">
      <div class="split-hint">在已保存正文上点击字符间的分界位置（引用标记是不可切开的整体；两段都须含非空白字符，其余字符原样保留）：</div>
      <div class="split-body">${bodyStr}</div>
      ${
        tokens.length < 2
          ? '<div class="split-hint">正文过短，没有可拆分的分界位置。</div>'
          : ""
      }
      <div class="split-segs" data-role="split-segs" hidden>
        <div class="split-seg">
          <span class="split-seg-label">前段（沿用原身份）</span>
          <span class="split-seg-text" data-role="seg-front"></span>
        </div>
        <div class="split-seg">
          <span class="split-seg-label">后段（新身份，紧跟前段）</span>
          <span class="split-seg-text" data-role="seg-back"></span>
        </div>
      </div>
      <div class="split-route">
        原指向本条的引用（含自引用，涉及 ${inbound} 条条款）统一改指：
        <label><input type="radio" data-role="split-route" name="split-route-${item.id}" value="front" checked /> 前段</label>
        <label><input type="radio" data-role="split-route" name="split-route-${item.id}" value="back" /> 后段</label>
      </div>
      <div class="editor-actions">
        <button data-action="split-confirm" class="primary" disabled>确认拆分</button>
        <button data-action="split-cancel">取消</button>
        <span class="edit-hint">其他引用与已失效引用不受影响；拆分后编号自动重排</span>
      </div>
      <ul class="edit-errors" data-role="split-errors" hidden></ul>
    </div>`;
}

// 选中某个分界：高亮、预览前后两段（本地解析，编号为拆分前显示号）、本地预检空白段
function selectSplitGap(card, offset) {
  state.splitOffset = offset;
  card
    .querySelectorAll(".split-gap")
    .forEach((g) => g.classList.toggle("on", parseInt(g.dataset.offset, 10) === offset));
  const clause = state.clauses.find((c) => c.id === card.dataset.id);
  const chars = Array.from(clause.body); // 按码点切片，与服务端一致
  const front = chars.slice(0, offset).join("");
  const back = chars.slice(offset).join("");
  const segs = card.querySelector('[data-role="split-segs"]');
  segs.hidden = false;
  segs.querySelector('[data-role="seg-front"]').textContent = resolveLocal(front);
  segs.querySelector('[data-role="seg-back"]').textContent = resolveLocal(back);
  card.querySelector('[data-action="split-confirm"]').disabled = false;
  const errs = [];
  if (front.trim() === "") errs.push("前段不能只含空白字符，请重新选择分界");
  if (back.trim() === "") errs.push("后段不能只含空白字符，请重新选择分界");
  showSplitErrors(card, errs);
}

function showSplitErrors(card, errs) {
  const box = card.querySelector('[data-role="split-errors"]');
  if (!box) return;
  if (!errs.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = errs.map((m) => `<li>${esc(m)}</li>`).join("");
  box.hidden = false;
}

// 拆分提交期间禁用拆分界面按钮，结束后恢复（DOM 可能已被重建，按当前节点操作）
function setSplitBusy(card, busy) {
  const confirmBtn = card.querySelector('[data-action="split-confirm"]');
  const cancelBtn = card.querySelector('[data-action="split-cancel"]');
  if (confirmBtn) {
    confirmBtn.disabled = busy;
    confirmBtn.textContent = busy ? "拆分中…" : "确认拆分";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

async function confirmSplit(id) {
  if (state.splitting) return; // 阻止重复提交
  const clause = state.clauses.find((c) => c.id === id);
  const card = document.getElementById(`card-${id}`);
  if (!clause || !card || state.splitOffset === null) return;

  // 本地预检（服务端仍会权威校验）：任何一项不满足都不改草稿、不发请求
  const chars = Array.from(clause.body);
  const front = chars.slice(0, state.splitOffset).join("");
  const back = chars.slice(state.splitOffset).join("");
  const localErrs = [];
  if (front.trim() === "") localErrs.push("前段不能只含空白字符，请重新选择分界");
  if (back.trim() === "") localErrs.push("后段不能只含空白字符，请重新选择分界");
  if (state.orderIds.length + 1 > MAX_CLAUSES)
    localErrs.push(`拆分后总数将超过 ${MAX_CLAUSES} 条上限`);
  if (localErrs.length) {
    showSplitErrors(card, localErrs);
    return;
  }

  const epoch = state.epoch;
  // 提交期间阻止其他一切改稿操作（列表置灰），成功或失败后恢复
  state.splitting = true;
  clauseList.classList.add("busy");
  setSplitBusy(card, true);
  syncToolbar();
  try {
    const data = await api("/api/split", {
      ...snapshot(),
      split_id: id,
      offset: state.splitOffset,
      route: state.splitRoute,
      new_id: `c${state.nextIdNum}`,
    });
    if (epoch !== state.epoch) return; // 已重新导入：旧拆分结果不得写回新草稿
    // 仅在服务端成功后才改动草稿，保证列表 / 预览 / 引用跳转 / 下载立即对应同一份草稿
    state.orderIds = data.order_ids;
    state.clauses = data.clauses.map((c) => ({
      id: c.id,
      original: parseInt(c.id.slice(1), 10),
      body: c.body,
    }));
    state.nextIdNum += 1; // 身份编号只增不减：删除 / 合并移除的身份永不复用
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRoute = "front";
    state.splitting = false;
    touch();
    render();
  } catch (e) {
    if (epoch !== state.epoch) return; // 旧草稿的失败不在新草稿上提示
    // 拆分失败：草稿未改动，恢复被暂时阻止的操作，可修正分界后重试
    state.splitting = false;
    const cur = document.getElementById(`card-${id}`);
    if (cur) {
      setSplitBusy(cur, false);
      showSplitErrors(cur, e.errors);
    }
  } finally {
    clauseList.classList.toggle("busy", state.merging || state.splitting);
    syncToolbar();
  }
}

// --------------------------------------------------------------------------- //
// 合并两条条款
// --------------------------------------------------------------------------- //
clauseList.addEventListener("change", (ev) => {
  const routePick = ev.target.closest('[data-role="split-route"]');
  if (routePick) {
    state.splitRoute = routePick.value; // 原指向被拆条款的引用落到前段还是后段
    return;
  }
  const pick = ev.target.closest(".merge-pick");
  if (!pick) return;
  const id = pick.closest(".card").dataset.id;
  if (state.merging || state.splitting) {
    pick.checked = state.mergeIds.includes(id); // 合并 / 拆分提交期间不允许改动选择
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
  if (state.merging || state.splitting) return; // 阻止重复提交 / 拆分提交期间不可合并
  if (state.editingId) {
    alert("请先保存或取消正在编辑的正文，再合并条款。");
    return;
  }
  if (state.splittingId) {
    alert("请先确认或取消正在进行的拆分，再合并条款。");
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
    clauseList.classList.toggle("busy", state.merging || state.splitting);
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

  // 拆分界面中的分界点击：只更新本地选择，不改动草稿
  const gap = ev.target.closest(".split-gap");
  if (gap) {
    if (state.splitting) return; // 提交期间不允许改选分界
    selectSplitGap(gap.closest(".card"), parseInt(gap.dataset.offset, 10));
    return;
  }

  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = card.dataset.id;
  const action = btn.dataset.action;

  // 编辑中、拆分界面打开或合并 / 拆分提交中：阻止 编辑 / 删除 / 重排 / 发起拆分（按钮已禁用，这里再兜底）
  if (
    ["up", "down", "edit", "delete", "split"].includes(action) &&
    (state.editingId || state.splittingId || state.merging || state.splitting)
  )
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
  } else if (action === "split") {
    // 拆分针对已保存正文：有未保存编辑时按钮已禁用，这里再兜底
    if (state.orderIds.length >= MAX_CLAUSES) {
      alert(`当前共 ${state.orderIds.length} 条，拆分后将超过 ${MAX_CLAUSES} 条上限，请先合并或删除条款。`);
      return;
    }
    state.splittingId = id;
    state.splitOffset = null;
    state.splitRoute = "front";
    render();
  } else if (action === "split-cancel") {
    if (state.splitting) return; // 提交期间不允许取消（按钮已禁用，这里再兜底）
    state.splittingId = null;
    state.splitOffset = null;
    state.splitRoute = "front";
    render(); // 取消拆分：草稿不变，仅关闭拆分界面
  } else if (action === "split-confirm") {
    await confirmSplit(id);
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
      if (!state.editingId && !state.splittingId && !state.merging && !state.splitting)
        card.draggable = true;
    });
    card.addEventListener("mouseup", () => (card.draggable = false));

    card.addEventListener("dragstart", (ev) => {
      if (state.editingId || state.splittingId || state.merging || state.splitting) {
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
