import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def import_text(text):
    return client.post("/api/import", json={"text": text})


GOOD = "\n".join(
    [
        "1|甲方在七日内交付设备",
        "2|乙方按 [[1]] 验收后付款",
        "3|争议解决见 [[4]]，违约参照 [[2]]",
        "4|争议提交仲裁",
    ]
)


def test_import_ok_binds_stable_ids():
    r = import_text(GOOD)
    assert r.status_code == 200, r.text
    clauses = r.json()["clauses"]
    assert [c["id"] for c in clauses] == ["c1", "c2", "c3", "c4"]
    assert clauses[1]["body"] == "乙方按 [[c1]] 验收后付款"
    assert clauses[2]["body"] == "争议解决见 [[c4]]，违约参照 [[c2]]"


@pytest.mark.parametrize(
    "text",
    [
        "1|只有一行",  # 少于 2 行
        "1-无分隔符\n2|正常条款",
        "a|编号非数字\n2|正文",
        "0|编号须从 1 开始\n2|正文",
        "01|编号含前导零\n2|正文",
        "1|正文为空编号重复\n1|另一条",
        "1|第一条\n3|缺编号2",
        "1|引用越界 [[9]]\n2|正常",
        "1|标记带空格 [[ 2 ]]\n2|正常",
        "1|未闭合 [[2\n2|正常",
        "1|多余右括号 [[2]]]\n2|正常",
        "1|前导零 [[01]]\n2|正常",
        "1|引用零号 [[0]]\n2|正常",
        "1|空内容标记 [[]]\n2|正常",
        "1|\n2|空正文",
        "1|中间空行\n\n3|第三行",
    ],
)
def test_import_rejects_bad_inputs(text):
    r = import_text(text)
    assert r.status_code == 422
    assert r.json()["detail"]["errors"]


def test_line_count_limit():
    text = "\n".join(f"{i}|条款{i}" for i in range(1, 42))  # 41 行
    r = import_text(text)
    assert r.status_code == 422


def test_preview_and_reorder_keeps_binding():
    d = import_text(GOOD).json()
    ids = [c["id"] for c in d["clauses"]]
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]

    # 把原第 4 条移到第 1 位：原第 3 条引用 [[4]] 应显示为 [[1]]，而不是转指新占 4 号位的条款
    order = ["c4", "c1", "c2", "c3"]
    r = client.post("/api/preview", json={"order_ids": order, "clauses": bodies})
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c3"]["text"].startswith("争议解决见 [[1]]，违约参照 [[3]]")
    assert items["c4"]["display"] == 1


def test_edit_save_binds_by_current_display_number():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    # 当前顺序 c4,c1,c2,c3 下，第 1 位是原 4 条
    order = ["c4", "c1", "c2", "c3"]
    r = client.post(
        "/api/save",
        json={
            "order_ids": order,
            "clauses": bodies,
            "edit_id": "c2",
            "text": "改为引用当前第 1 条 [[1]]",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["body"] == "改为引用当前第 1 条 [[c4]]"

    # 再重排：引用仍锁定 c4（原条款），不会转指占旧号的条款
    saved = [b for b in bodies if b["id"] != "c2"] + [{"id": "c2", "body": "改为引用当前第 1 条 [[c4]]"}]
    r = client.post(
        "/api/preview",
        json={"order_ids": ["c1", "c2", "c3", "c4"], "clauses": saved},
    )
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c2"]["text"] == "改为引用当前第 1 条 [[4]]"


def test_save_rejects_dangling_ref():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = client.post(
        "/api/save",
        json={"order_ids": ids4(), "clauses": bodies, "edit_id": "c2", "text": "引用不存在 [[5]]"},
    )
    assert r.status_code == 422


def ids4():
    return ["c1", "c2", "c3", "c4"]


def test_delete_referenced_clause_marks_broken_and_blocks_export():
    d = import_text(GOOD).json()
    # 删除被引用的 c4（c3 引用它）
    order = ["c1", "c2", "c3"]
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"] if c["id"] != "c4"]

    r = client.post("/api/preview", json={"order_ids": order, "clauses": bodies})
    preview = r.json()
    assert preview["has_broken"] is True
    c3 = next(it for it in preview["items"] if it["id"] == "c3")
    assert "[[原4?]]" in c3["text"]
    assert c3["broken"] == [{"ref_id": "c4", "original": 4}]

    # 修复前导出 409
    r = client.post("/api/export", json={"order_ids": order, "clauses": bodies})
    assert r.status_code == 409

    # 修复：编辑 c3，改引当前第 1 条（c1）
    r = client.post(
        "/api/save",
        json={"order_ids": order, "clauses": bodies, "edit_id": "c3", "text": "争议解决改为 [[1]]"},
    )
    assert r.status_code == 200
    fixed = [{"id": b["id"], "body": b["body"]} for b in bodies if b["id"] != "c3"]
    fixed.append({"id": "c3", "body": r.json()["body"]})

    r = client.post("/api/preview", json={"order_ids": order, "clauses": fixed})
    assert r.json()["has_broken"] is False

    r = client.post("/api/export", json={"order_ids": order, "clauses": fixed})
    assert r.status_code == 200
    lines = r.json()["text"].split("\n")
    assert lines == [
        "1|甲方在七日内交付设备",
        "2|乙方按 [[1]] 验收后付款",
        "3|争议解决改为 [[1]]",
    ]


def test_self_reference_is_allowed():
    r = import_text("1|本条说明自身 [[1]]\n2|普通条款")
    assert r.status_code == 200


def test_single_line_only_enforced_on_edit():
    d = import_text(GOOD).json()
    bodies = [{"id": c["id"], "body": c["body"]} for c in d["clauses"]]
    r = client.post(
        "/api/save",
        json={"order_ids": ids4(), "clauses": bodies, "edit_id": "c2", "text": "第一行\n第二行"},
    )
    assert r.status_code == 422
    assert "单行" in r.json()["detail"]["errors"][0]


def test_pipe_only_split_on_first_one():
    r = import_text("1|正文里|可以有竖线\n2|引用 [[1]]")
    assert r.status_code == 200
    assert r.json()["clauses"][0]["body"] == "正文里|可以有竖线"


# --------------------------------------------------------------------------- #
# 合并
# --------------------------------------------------------------------------- #
def _bodies(doc):
    return [{"id": c["id"], "body": c["body"]} for c in doc["clauses"]]


def test_merge_joins_with_fullwidth_semicolon_and_repoints_refs():
    bodies = _bodies(import_text(GOOD).json())
    # 合并原 1（保留）与原 2（并入）
    r = client.post(
        "/api/merge",
        json={"order_ids": ids4(), "clauses": bodies, "keep_id": "c1", "drop_id": "c2"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["order_ids"] == ["c1", "c3", "c4"]
    merged = {c["id"]: c["body"] for c in data["clauses"]}
    # 全角分号连接；c2 正文里指向 c1 的引用保持/并入 c1
    assert merged["c1"] == "甲方在七日内交付设备；乙方按 [[c1]] 验收后付款"
    # 原来指向 c2 的引用（c3）改指合并结果 c1；其余引用不动
    assert merged["c3"] == "争议解决见 [[c4]]，违约参照 [[c1]]"
    assert "c2" not in merged

    # 预览 / 导出立即对应同一份草稿
    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    items = {it["id"]: it for it in r.json()["items"]}
    assert r.json()["has_broken"] is False
    assert items["c1"]["display"] == 1
    assert items["c1"]["text"] == "甲方在七日内交付设备；乙方按 [[1]] 验收后付款"
    assert items["c3"]["text"] == "争议解决见 [[3]]，违约参照 [[1]]"

    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 200
    assert r.json()["text"].split("\n") == [
        "1|甲方在七日内交付设备；乙方按 [[1]] 验收后付款",
        "2|争议解决见 [[3]]，违约参照 [[1]]",
        "3|争议提交仲裁",
    ]


def test_merge_in_reordered_doc_uses_display_order():
    # 当前显示顺序 c4(1), c1(2), c2(3), c3(4)：合并显示较前的 c1 与较后的 c3
    order = ["c4", "c1", "c2", "c3"]
    bodies = _bodies(import_text(GOOD).json())
    r = client.post(
        "/api/merge",
        json={"order_ids": order, "clauses": bodies, "keep_id": "c1", "drop_id": "c3"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["order_ids"] == ["c4", "c1", "c2"]  # 其余条款相对顺序不变
    merged = {c["id"]: c["body"] for c in data["clauses"]}
    # c3 正文中 [[c4]] 与 [[c2]] 都不是被移除身份，保持不变（c2 并未被合并）
    assert merged["c1"] == "甲方在七日内交付设备；争议解决见 [[c4]]，违约参照 [[c2]]"
    assert merged["c2"] == "乙方按 [[c1]] 验收后付款"  # c2 对 c1 的引用保持

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c1"]["text"] == "甲方在七日内交付设备；争议解决见 [[1]]，违约参照 [[3]]"
    assert items["c2"]["text"] == "乙方按 [[2]] 验收后付款"
    assert items["c2"]["display"] == 3


def test_merge_keeps_already_broken_refs_broken():
    doc = import_text(GOOD).json()
    # 先删 c4：c3 中 [[c4]] 失效
    order = ["c1", "c2", "c3"]
    bodies = [b for b in _bodies(doc) if b["id"] != "c4"]

    # 再合并 c2（保留）+ c3（并入）
    r = client.post(
        "/api/merge",
        json={"order_ids": order, "clauses": bodies, "keep_id": "c2", "drop_id": "c3"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    merged = {c["id"]: c["body"] for c in data["clauses"]}
    # [[c2]] 改指保留方 c2（自引用），[[c4]] 保持失效，不会因合并恢复
    assert merged["c2"] == "乙方按 [[c1]] 验收后付款；争议解决见 [[c4]]，违约参照 [[c2]]"

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    preview = r.json()
    assert preview["has_broken"] is True
    c2 = next(it for it in preview["items"] if it["id"] == "c2")
    assert "[[原4?]]" in c2["text"]

    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 409


def test_merge_rejects_reversed_same_and_missing():
    bodies = _bodies(import_text(GOOD).json())
    # 方向反了：c2 在 c1 之后，却要求保留 c2
    r = client.post(
        "/api/merge",
        json={"order_ids": ids4(), "clauses": bodies, "keep_id": "c2", "drop_id": "c1"},
    )
    assert r.status_code == 422

    # 同一条款不能与自己合并
    r = client.post(
        "/api/merge",
        json={"order_ids": ids4(), "clauses": bodies, "keep_id": "c1", "drop_id": "c1"},
    )
    assert r.status_code == 422

    # 条款不存在
    r = client.post(
        "/api/merge",
        json={"order_ids": ids4(), "clauses": bodies, "keep_id": "c1", "drop_id": "c9"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# 拆分
# --------------------------------------------------------------------------- #
def _split(order, bodies, split_id, offset, route="front", new_id="c5"):
    return client.post(
        "/api/split",
        json={
            "order_ids": order,
            "clauses": bodies,
            "split_id": split_id,
            "offset": offset,
            "route": route,
            "new_id": new_id,
        },
    )


def test_split_front_route_keeps_identity_and_chars():
    bodies = _bodies(import_text(GOOD).json())
    # c2 = "乙方按 [[c1]] 验收后付款"，在“乙方按 ”之后拆开（offset 按码点计）
    r = _split(ids4(), bodies, "c2", 4, route="front", new_id="c5")
    assert r.status_code == 200, r.text
    data = r.json()
    # 后段紧跟前段，其余顺序不变
    assert data["order_ids"] == ["c1", "c2", "c5", "c3", "c4"]
    assert data["new_id"] == "c5"
    got = {c["id"]: c["body"] for c in data["clauses"]}
    # 字符原样保留：前段结尾空格不裁剪，两段拼接等于原正文
    assert got["c2"] == "乙方按 "
    assert got["c5"] == "[[c1]] 验收后付款"
    assert got["c2"] + got["c5"] == "乙方按 [[c1]] 验收后付款"
    # 引用落点为前段：指向 c2 的引用保持 c2；指向其他条款的引用不动
    assert got["c3"] == "争议解决见 [[c4]]，违约参照 [[c2]]"
    assert got["c1"] == "甲方在七日内交付设备"

    # 预览 / 导出立即对应拆分后的同一份草稿
    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    preview = r.json()
    assert preview["has_broken"] is False
    items = {it["id"]: it for it in preview["items"]}
    assert items["c2"]["display"] == 2 and items["c2"]["text"] == "乙方按 "
    assert items["c5"]["display"] == 3 and items["c5"]["text"] == "[[1]] 验收后付款"
    assert items["c3"]["text"] == "争议解决见 [[5]]，违约参照 [[2]]"

    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 200
    assert r.json()["text"].split("\n") == [
        "1|甲方在七日内交付设备",
        "2|乙方按 ",
        "3|[[1]] 验收后付款",
        "4|争议解决见 [[5]]，违约参照 [[2]]",
        "5|争议提交仲裁",
    ]


def test_split_back_route_repoints_inbound_and_self_refs():
    doc = import_text("1|本条引用自身 [[1]] 且引用 [[2]]\n2|普通条款 [[1]]").json()
    bodies = _bodies(doc)
    # c1 = "本条引用自身 [[c1]] 且引用 [[c2]]"，在“本条引用自身 ”之后拆开
    r = _split(["c1", "c2"], bodies, "c1", 7, route="back", new_id="c3")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["order_ids"] == ["c1", "c3", "c2"]
    got = {c["id"]: c["body"] for c in data["clauses"]}
    assert got["c1"] == "本条引用自身 "
    # 后段内的自引用 [[c1]] 改指后段 c3；指向其他条款的 [[c2]] 不动
    assert got["c3"] == "[[c3]] 且引用 [[c2]]"
    # 其他条款中指向被拆条款的引用统一改指后段
    assert got["c2"] == "普通条款 [[c3]]"

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c3"]["text"] == "[[2]] 且引用 [[3]]"
    assert items["c2"]["text"] == "普通条款 [[2]]"


def test_split_in_reordered_doc_inserts_right_after_front():
    bodies = _bodies(import_text(GOOD).json())
    order = ["c4", "c1", "c2", "c3"]
    r = _split(order, bodies, "c1", 3, route="front", new_id="c5")
    assert r.status_code == 200, r.text
    data = r.json()
    # 新条款紧跟前段，其余条款相对顺序不变
    assert data["order_ids"] == ["c4", "c1", "c5", "c2", "c3"]
    got = {c["id"]: c["body"] for c in data["clauses"]}
    assert got["c1"] == "甲方在"
    assert got["c5"] == "七日内交付设备"
    # c2 对 c1 的引用落点为前段，保持 c1
    assert got["c2"] == "乙方按 [[c1]] 验收后付款"


def test_split_rejects_boundary_inside_marker():
    bodies = _bodies(import_text(GOOD).json())
    body = "乙方按 [[c1]] 验收后付款"
    start = body.index("[[c1]]")
    for offset in (start + 1, start + 3, start + len("[[c1]]") - 1):
        r = _split(ids4(), bodies, "c2", offset)
        assert r.status_code == 422, offset
        assert "切开" in r.json()["detail"]["errors"][0]
    # 紧贴标记两侧是合法的
    assert _split(ids4(), bodies, "c2", start).status_code == 200
    assert _split(ids4(), bodies, "c2", start + len("[[c1]]")).status_code == 200


def test_split_rejects_blank_segments():
    bodies = _bodies(import_text(GOOD).json())
    body = "乙方按 [[c1]] 验收后付款"
    # 分界在开头 / 结尾：必有一段为空
    assert _split(ids4(), bodies, "c2", 0).status_code == 422
    assert _split(ids4(), bodies, "c2", len(body)).status_code == 422
    # 仅含空白的一段同样拒绝
    doc = import_text("1| 甲方交付设备\n2|乙方按 [[1]] 验收").json()
    r = _split(["c1", "c2"], _bodies(doc), "c1", 1)  # 前段只有一个空格
    assert r.status_code == 422
    assert "空白" in r.json()["detail"]["errors"][0]


def test_split_rejects_beyond_forty_clauses():
    text = "\n".join(f"{i}|条款{i}" for i in range(1, 41))  # 40 条，合法上限
    doc = import_text(text).json()
    order = [c["id"] for c in doc["clauses"]]
    r = _split(order, _bodies(doc), "c1", 2, new_id="c41")
    assert r.status_code == 422
    assert "40" in r.json()["detail"]["errors"][0]

    # 39 条时拆分成功，总数恰为 40
    text39 = "\n".join(f"{i}|条款{i}" for i in range(1, 40))
    doc39 = import_text(text39).json()
    order39 = [c["id"] for c in doc39["clauses"]]
    r = _split(order39, _bodies(doc39), "c1", 2, new_id="c40")
    assert r.status_code == 200, r.text
    assert len(r.json()["order_ids"]) == 40


def test_split_rejects_bad_params():
    bodies = _bodies(import_text(GOOD).json())
    # 条款不存在
    assert _split(ids4(), bodies, "c9", 1).status_code == 422
    # 落点非法
    assert _split(ids4(), bodies, "c2", 4, route="middle").status_code == 422
    # 新身份非法 / 已被占用
    assert _split(ids4(), bodies, "c2", 4, new_id="x5").status_code == 422
    assert _split(ids4(), bodies, "c2", 4, new_id="c3").status_code == 422
    # 分界越界
    assert _split(ids4(), bodies, "c2", -1).status_code == 422
    assert _split(ids4(), bodies, "c2", 10_000).status_code == 422


def test_split_never_revives_broken_refs():
    doc = import_text(GOOD).json()
    # 先删 c4：c3 中 [[c4]] 失效
    order = ["c1", "c2", "c3"]
    bodies = [b for b in _bodies(doc) if b["id"] != "c4"]

    # 新身份不得复用被删除条款的身份（否则失效引用会复活）
    r = _split(order, bodies, "c2", 4, new_id="c4")
    assert r.status_code == 422
    assert "复活" in r.json()["detail"]["errors"][0]

    # 用全新身份拆分：失效引用保持失效
    r = _split(order, bodies, "c2", 4, route="back", new_id="c5")
    assert r.status_code == 200, r.text
    data = r.json()
    got = {c["id"]: c["body"] for c in data["clauses"]}
    assert got["c3"] == "争议解决见 [[c4]]，违约参照 [[c5]]"  # [[c4]] 仍失效，指向 c2 的改指后段

    r = client.post("/api/preview", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    preview = r.json()
    assert preview["has_broken"] is True
    c3 = next(it for it in preview["items"] if it["id"] == "c3")
    assert "[[原4?]]" in c3["text"]
    # 失效引用未修复前仍禁止导出
    r = client.post("/api/export", json={"order_ids": data["order_ids"], "clauses": data["clauses"]})
    assert r.status_code == 409


def test_split_result_supports_further_editing():
    # 拆分后的草稿可继续保存编辑、合并、再次拆分（状态始终通过同一套校验）
    bodies = _bodies(import_text(GOOD).json())
    data = _split(ids4(), bodies, "c2", 4, route="front", new_id="c5").json()

    # 继续编辑后段
    r = client.post(
        "/api/save",
        json={
            "order_ids": data["order_ids"],
            "clauses": data["clauses"],
            "edit_id": "c5",
            "text": "[[1]] 验收后三十日内付款",
        },
    )
    assert r.status_code == 200, r.text
    clauses = [{"id": c["id"], "body": c["body"]} for c in data["clauses"]]
    for c in clauses:
        if c["id"] == "c5":
            c["body"] = r.json()["body"]

    # 再把前后两段合并回去（按当前显示顺序，c2 在前）
    r = client.post(
        "/api/merge",
        json={"order_ids": data["order_ids"], "clauses": clauses, "keep_id": "c2", "drop_id": "c5"},
    )
    assert r.status_code == 200, r.text
    merged = {c["id"]: c["body"] for c in r.json()["clauses"]}
    assert merged["c2"] == "乙方按 ；[[c1]] 验收后三十日内付款"
    # 合并移除的身份 c5 不得复用：下一次拆分用 c6
    r = _split(r.json()["order_ids"], r.json()["clauses"], "c2", 3, new_id="c6")
    assert r.status_code == 200, r.text
    assert r.json()["new_id"] == "c6"
