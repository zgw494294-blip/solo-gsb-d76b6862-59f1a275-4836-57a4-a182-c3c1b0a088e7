"""条款重排校稿台 —— FastAPI 后端。

引用模型：
- 导入原文中的引用写作 ``[[数字]]``，校验通过后绑定到条款的稳定 id（``c<原编号>``），
  正文内部统一存为 ``[[c<原编号>]]``。
- 编辑保存时，文本中的 ``[[数字]]`` 按“保存当刻”的显示编号绑定到对应稳定 id，
  因此之后无论怎样重排，引用都不会转指占用旧号的条款。
- 被引用条款被删除后，其 id 仍留在引用处，预览解析为失效引用（[[原X?]]），
  修复前导出接口返回 409，前端禁止下载。
- 合并两条条款时，按当前显示顺序用全角分号连接正文；合并结果沿用较前条款的稳定 id，
  较后条款删除，其 id 在所有正文中（含两条待合并正文）统一改写为较前条款 id。
  其他引用保持不动；已失效引用（id 已不存在于草稿）不会因合并恢复，仍保持失效。
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

MIN_LINES = 2
MAX_LINES = 40

# 匹配任意 [[...]]（内容不含方括号）；数字引用与内部 id 引用均用它识别
MARKER_RE = re.compile(r"\[\[([^\[\]]*)\]\]")
OPEN_RE = re.compile(r"(?=\[\[)")
CLOSE_RE = re.compile(r"(?=\]\])")
# 规范的引用/编号数字：十进制正整数，不允许前导零（0 单独成案处理）
NUM_TOKEN_RE = re.compile(r"^(0|[1-9][0-9]*)$")
# 稳定 id：c + 导入时的原始编号
ID_RE = re.compile(r"^c(\d+)$")

app = FastAPI(title="条款重排校稿台")


# --------------------------------------------------------------------------- #
# 请求模型
# --------------------------------------------------------------------------- #
class ImportIn(BaseModel):
    text: str


class ClauseIn(BaseModel):
    id: str
    body: str  # 内部形态：[[c3]] 形式的引用


class StateIn(BaseModel):
    order_ids: list[str]
    clauses: list[ClauseIn]


class SaveIn(BaseModel):
    order_ids: list[str]
    clauses: list[ClauseIn]
    edit_id: str
    text: str  # 编辑器中的正文（数字引用）


class MergeIn(BaseModel):
    order_ids: list[str]
    clauses: list[ClauseIn]
    keep_id: str  # 合并后沿用的身份（当前显示顺序中较前的一条）
    drop_id: str  # 被并入并移除的一条（当前显示顺序中较后的一条）


# --------------------------------------------------------------------------- #
# 通用解析
# --------------------------------------------------------------------------- #
def _stray_opens(text: str) -> list[int]:
    """找出没有构成合法 ``[[...]]`` 的 ``[[`` 位置（未闭合/嵌套等）。"""
    return [m.start() for m in OPEN_RE.finditer(text) if not MARKER_RE.match(text, m.start())]


def _stray_closes(text: str) -> list[int]:
    """找出不属于任何合法 ``[[...]]`` 的 ``]]`` 位置。"""
    close_starts = {m.end() - 2 for m in MARKER_RE.finditer(text)}
    return [m.start() for m in CLOSE_RE.finditer(text) if m.start() not in close_starts]


def scan_raw_refs(body: str) -> tuple[list[int], list[str]]:
    """扫描导入/编辑器正文中的显式引用。

    仅接受 ``[[数字]]``；其余 ``[[...]]`` 与游离的 ``[[`` 一律算格式错误。
    """
    refs: list[int] = []
    errors: list[str] = []
    for m in MARKER_RE.finditer(body):
        token = m.group(1)
        if NUM_TOKEN_RE.match(token):
            refs.append(int(token))
        else:
            errors.append(f"引用格式错误：{m.group(0)}（须写作 [[数字]]，中间不能有空格或其他字符）")
    if _stray_opens(body):
        errors.append("存在未正确闭合的 [[ 标记（引用须完整写作 [[数字]]）")
    if _stray_closes(body):
        errors.append("存在多余的 ]] 标记（引用须完整写作 [[数字]]）")
    return refs, errors


def parse_import(text: str) -> tuple[list[dict], list[str]]:
    """解析整份导入文本；任何错误都导致整份拒收。"""
    errors: list[str] = []
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    # 仅容忍粘贴时常见的结尾空行；中间/开头空行仍拒收
    while lines and lines[-1].strip() == "":
        lines.pop()

    n = len(lines)
    if not (MIN_LINES <= n <= MAX_LINES):
        return [], [f"行数需为 {MIN_LINES}～{MAX_LINES} 行“编号|正文”，当前为 {n} 行"]

    parsed: list[tuple[int, str, list[int], int]] = []
    for i, line in enumerate(lines, 1):
        if line.strip() == "":
            errors.append(f"第 {i} 行为空行，整份文本须为连续的编号条款")
            continue
        if "|" not in line:
            errors.append(f"第 {i} 行缺少分隔符“|”，格式须为“编号|正文”")
            continue
        head, body = line.split("|", 1)
        head = head.strip()
        if not head.isdigit():
            errors.append(f"第 {i} 行编号“{head or '（空）'}”不是正整数")
            continue
        num = int(head)
        if head != str(num):
            errors.append(f"第 {i} 行编号“{head}”含前导零，编号须写作 {num}")
        if body.strip() == "":
            errors.append(f"第 {i} 行正文为空")
        refs, ref_errors = scan_raw_refs(body)
        for err in ref_errors:
            errors.append(f"第 {i} 行：{err}")
        parsed.append((num, body, refs, i))

    # 重复编号
    seen: dict[int, list[int]] = {}
    for num, _, _, line_no in parsed:
        seen.setdefault(num, []).append(line_no)
    for num, idxs in seen.items():
        if len(idxs) > 1:
            errors.append(f"编号重复：{num} 同时出现在第 {'、'.join(map(str, idxs))} 行")

    got = {num for num, _, _, _ in parsed}
    expected = set(range(1, n + 1))
    for missing in sorted(expected - got):
        errors.append(f"编号未从 1 连续排列：缺少编号 {missing}")
    for extra in sorted(got - expected):
        errors.append(f"编号越界：{extra}（应分布在 1～{n}）")

    if errors:
        return [], errors

    # 引用目标检查（此时编号集合恰为 1..n）
    for num, body, refs, line_no in parsed:
        for ref in refs:
            if not (1 <= ref <= n):
                errors.append(f"第 {line_no} 行引用无目标：[[{ref}]]（有效编号为 1～{n}）")
    if errors:
        return [], errors

    parsed.sort(key=lambda item: item[0])
    clauses: list[dict] = []
    for num, body, refs, _ in parsed:
        internal = MARKER_RE.sub(lambda m: f"[[c{int(m.group(1))}]]", body)
        clauses.append(
            {
                "id": f"c{num}",
                "original": num,
                "body": internal,
                "ref_ids": [f"c{r}" for r in refs],
            }
        )
    return clauses, []


def _validate_state(order_ids: list[str], clauses: list[ClauseIn]) -> dict[str, ClauseIn]:
    """校验前端回传的文档状态，返回 id -> ClauseIn。"""
    by_id: dict[str, ClauseIn] = {}
    for clause in clauses:
        if not ID_RE.match(clause.id):
            raise HTTPException(422, detail={"errors": [f"内部条款 id 非法：{clause.id}"]})
        if clause.id in by_id:
            raise HTTPException(422, detail={"errors": [f"条款 {clause.id} 重复出现"]})
        by_id[clause.id] = clause
    if len(order_ids) != len(by_id) or set(order_ids) != set(by_id.keys()):
        raise HTTPException(422, detail={"errors": ["顺序列表与条款集合不一致"]})
    for clause in clauses:
        if clause.body.strip() == "":
            raise HTTPException(422, detail={"errors": [f"原第 {clause.id[1:]} 条正文为空"]})
        if "\n" in clause.body:
            raise HTTPException(422, detail={"errors": [f"原第 {clause.id[1:]} 条不是单行条款"]})
        for m in MARKER_RE.finditer(clause.body):
            if not ID_RE.match(m.group(1)):
                raise HTTPException(
                    422,
                    detail={"errors": [f"原第 {clause.id[1:]} 条内部引用形态损坏：{m.group(0)}"]},
                )
        if _stray_opens(clause.body) or _stray_closes(clause.body):
            raise HTTPException(422, detail={"errors": [f"原第 {clause.id[1:]} 条存在未闭合标记"]})
    return by_id


def resolve_body(body: str, pos_by_id: dict[str, int]) -> tuple[str, list[dict]]:
    """把内部正文解析为“当前显示编号”文本，并收集失效引用。"""
    out: list[str] = []
    broken: list[dict] = []
    pos = 0
    for m in MARKER_RE.finditer(body):
        out.append(body[pos : m.start()])
        token = m.group(1)
        if token in pos_by_id:
            out.append(f"[[{pos_by_id[token]}]]")
        else:
            original = int(ID_RE.match(token).group(1))  # 形态已在 _validate_state 保证
            broken.append({"ref_id": token, "original": original})
            out.append(f"[[原{original}?]]")
        pos = m.end()
    out.append(body[pos:])
    return "".join(out), broken


# --------------------------------------------------------------------------- #
# 接口
# --------------------------------------------------------------------------- #
@app.post("/api/import")
def import_doc(payload: ImportIn):
    clauses, errors = parse_import(payload.text)
    if errors:
        raise HTTPException(422, detail={"errors": errors})
    return {"clauses": clauses}


@app.post("/api/save")
def save_clause(payload: SaveIn):
    """保存对某条正文的编辑：数字引用按**保存当刻**显示编号绑定。"""
    by_id = _validate_state(payload.order_ids, payload.clauses)
    if payload.edit_id not in by_id:
        raise HTTPException(422, detail={"errors": ["被编辑的条款不存在"]})

    text = payload.text.replace("\r\n", "\n").replace("\r", "\n")
    errors: list[str] = []
    if text.strip() == "":
        errors.append("正文不能为空")
    if "\n" in text:
        errors.append("每条条款只能为单行，请去掉换行")
    refs, ref_errors = scan_raw_refs(text)
    errors.extend(ref_errors)

    total = len(payload.order_ids)
    for ref in refs:
        if not (1 <= ref <= total):
            errors.append(f"引用无目标：[[{ref}]]（当前显示编号范围为 1～{total}）")
    if errors:
        raise HTTPException(422, detail={"errors": errors})

    def bind(m: re.Match) -> str:
        target_id = payload.order_ids[int(m.group(1)) - 1]
        return f"[[{target_id}]]"

    internal = MARKER_RE.sub(bind, text)
    return {"id": payload.edit_id, "body": internal}


@app.post("/api/merge")
def merge_clauses(payload: MergeIn):
    """合并两条条款。

    - ``keep_id`` 必须是当前显示顺序中较前的一条，合并结果占据它的位置并沿用其 id；
      ``drop_id`` 为较后一条，合并后移除；其余条款相对顺序不变。
    - 合并正文为 ``较前正文；较后正文``（全角分号“；”连接）。
    - 所有指向 ``drop_id`` 的引用（含两条待合并正文中的引用）改指 ``keep_id``；
      其他引用不动；已失效引用（目标不在草稿内）保持失效。
    """
    by_id = _validate_state(payload.order_ids, payload.clauses)
    errors: list[str] = []
    if payload.keep_id not in by_id:
        errors.append("合并目标条款不存在")
    if payload.drop_id not in by_id:
        errors.append("被合并条款不存在")
    if payload.keep_id == payload.drop_id and payload.keep_id in by_id:
        errors.append("必须选择两条不同的条款")
    if errors:
        raise HTTPException(422, detail={"errors": errors})

    keep_pos = payload.order_ids.index(payload.keep_id)
    drop_pos = payload.order_ids.index(payload.drop_id)
    if keep_pos > drop_pos:
        raise HTTPException(
            422,
            detail={
                "errors": [
                    f"合并方向有误：原第 {payload.keep_id[1:]} 条当前在第 {keep_pos + 1} 位，"
                    f"原第 {payload.drop_id[1:]} 条在第 {drop_pos + 1} 位，"
                    "须按当前显示顺序选择较前与较后的两条"
                ]
            },
        )

    def repoint(m: re.Match) -> str:
        return f"[[{payload.keep_id if m.group(1) == payload.drop_id else m.group(1)}]]"

    merged: list[dict] = []
    for clause in payload.clauses:
        body = clause.body
        if clause.id == payload.keep_id:
            body = f"{body}；{by_id[payload.drop_id].body}"
        if clause.id == payload.drop_id:
            continue
        merged.append({"id": clause.id, "body": MARKER_RE.sub(repoint, body)})

    new_order = [cid for cid in payload.order_ids if cid != payload.drop_id]
    return {"order_ids": new_order, "clauses": merged}


@app.post("/api/preview")
def preview(payload: StateIn):
    by_id = _validate_state(payload.order_ids, payload.clauses)
    pos_by_id = {clause_id: i + 1 for i, clause_id in enumerate(payload.order_ids)}
    items = []
    has_broken = False
    for display, clause_id in enumerate(payload.order_ids, 1):
        clause = by_id[clause_id]
        text, broken = resolve_body(clause.body, pos_by_id)
        has_broken = has_broken or bool(broken)
        items.append(
            {
                "id": clause_id,
                "original": int(clause_id[1:]),
                "display": display,
                "text": text,
                "broken": broken,
            }
        )
    return {"items": items, "has_broken": has_broken}


@app.post("/api/export")
def export_doc(payload: StateIn):
    """修复所有失效引用后才返回纯文本；否则 409。"""
    by_id = _validate_state(payload.order_ids, payload.clauses)
    pos_by_id = {clause_id: i + 1 for i, clause_id in enumerate(payload.order_ids)}
    lines = []
    sources: list[str] = []
    for display, clause_id in enumerate(payload.order_ids, 1):
        clause = by_id[clause_id]
        text, broken = resolve_body(clause.body, pos_by_id)
        if broken:
            originals = "、".join(f"[[原{b['original']}?]]" for b in broken)
            sources.append(f"第 {display} 条（原第 {clause_id[1:]} 条）含失效引用 {originals}")
        lines.append(f"{display}|{text}")
    if sources:
        raise HTTPException(
            409,
            detail={"errors": ["存在失效引用，修复前禁止下载", *sources]},
        )
    return {"text": "\n".join(lines)}


# --------------------------------------------------------------------------- #
# 静态页面
# --------------------------------------------------------------------------- #
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
