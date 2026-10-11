"""
NIS memory/knowledge bridge — 供 pi-bridge (Node) 通过 stdin/stdout 调用的 Python 进程。

协议：JSON 行（每行一个请求 / 一个响应）
  请求  : {"op": "memory_search", "id": 1, "params": {...}}
  响应  : {"id": 1, "ok": true, "result": {...}}
          {"id": 1, "ok": false, "error": "..."}

支持的 op：
  memory_search     {query, top_k?, scope?}        scope: nis_core|project
  memory_store      {content, memory_type?, scope?, importance?}
  knowledge_query   {query, top_k?, project_id?}
  knowledge_list    {project_id?}
  knowledge_add     {title, content, entry_type?, tags?, project_id?}
  knowledge_delete  {id}
  ping              {}   → {pong: true}

数据目录固定指向旧后端的 .nis_data（复用已有记忆/知识库数据）。
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback

# 指向 NIS Python 后端源码（core.memory / core.knowledge 独立可导入，不依赖 main）
# 0918：改成"内核包就在本文件旁边" —— 不再依赖网页版目录
SRC_PYTHON = os.path.dirname(os.path.abspath(__file__))
# 数据目录（0913）：优先 NIS_MEMORY_DIR（NIS 后端按「设置→通用→存储目录」注入），缺省回退旧后端 .nis_data。
# 首次指向新目录时由 Node 侧把旧库一次性拷过去（不删旧，旧后端仍可用）。
DATA_DIR = os.environ.get("NIS_MEMORY_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "_data")
sys.path.insert(0, SRC_PYTHON)

MEMORY_DB = os.path.join(DATA_DIR, "memory_system.db")
KNOWLEDGE_DB = os.path.join(DATA_DIR, "knowledge.db")

_store = None        # MemoryStore
_knowledge = None    # KnowledgeStore
_nis_core_scope_id = None
_embedding_provider = None
_retrieval_backend = None


def _ensure_embedding():
    """惰性加载本地语义模型（bge-small-zh-v1.5），失败则 None → 检索降级 FTS。"""
    global _embedding_provider, _retrieval_backend
    if _embedding_provider is not None:
        return
    try:
        from core.memory.embedding import SentenceTransformerEmbedder
        from core.memory.vector_index import SqliteVectorIndex
        provider = SentenceTransformerEmbedder("BAAI/bge-small-zh-v1.5")
        _embedding_provider = provider
        _retrieval_backend = SqliteVectorIndex(MEMORY_DB, provider.dimensions)
    except Exception:
        _embedding_provider = None
        _retrieval_backend = None


def _get_store():
    global _store, _nis_core_scope_id
    if _store is None:
        from core.memory.store import MemoryStore
        from core.memory.models import ScopeType
        _ensure_embedding()
        _store = MemoryStore(
            db_path=MEMORY_DB,
            embedding_provider=_embedding_provider,
            retrieval_backend=_retrieval_backend,
            auto_index=_embedding_provider is not None,
        )
        scope = _store.create_scope(ScopeType.NIS_CORE)
        _nis_core_scope_id = scope.id
    return _store


def _get_knowledge():
    global _knowledge
    if _knowledge is None:
        from core.knowledge.store import KnowledgeStore
        _knowledge = KnowledgeStore(db_path=KNOWLEDGE_DB)
    return _knowledge


# ── 0924 一期：6 类分法 + 摘要(索引层)/详情两级 + 命中权重（冷热分层数据来源）──
# 分类定版（用户 0924）：5 类（偏好/决策/教训/模式/事实）+ 画像；人设走设置，"长期记忆"桶废除
CATEGORY_TO_TYPE = {
    "preference": "preference",       # 偏好
    "decision": "project_decision",   # 决策
    "lesson": "project_lesson",       # 教训
    "pattern": "procedure",           # 模式
    "fact": "semantic",               # 事实
    "profile": "user_profile",        # 画像
}
TYPE_TO_NODE = {
    "preference": "preference",
    "project_decision": "decision",
    "project_lesson": "pitfall",
    "procedure": "pattern",
    "semantic": "fact",
    "project_fact": "fact",
    "user_profile": "profile",
}


def _map_node_type(mtype) -> str:
    """memory_type → 前端 6 类显示桶（偏好/决策/教训/模式/事实/画像）。
    0924 废除"长期记忆"兜底桶：归不了的一律按「事实」显示。"""
    return TYPE_TO_NODE.get(str(mtype or ""), "fact")


_extra_cols_ready = False


def _ensure_extra_columns(store) -> None:
    """0924 一期：幂等补列 summary / hit_count / last_hit_at（摘要索引层 + 冷热权重）。"""
    global _extra_cols_ready
    if _extra_cols_ready:
        return
    conn = store._conn()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(memory_records)")}
        for ddl in (
            "ALTER TABLE memory_records ADD COLUMN summary TEXT DEFAULT ''",
            "ALTER TABLE memory_records ADD COLUMN hit_count INTEGER DEFAULT 0",
            "ALTER TABLE memory_records ADD COLUMN last_hit_at REAL DEFAULT 0",
        ):
            name = ddl.split("ADD COLUMN")[1].split()[0]
            if name not in cols:
                conn.execute(ddl)
        conn.commit()
        _extra_cols_ready = True
    finally:
        conn.close()


def _extra_fields(store, mem_id: str) -> dict:
    conn = store._conn()
    try:
        row = conn.execute(
            "SELECT summary, hit_count, last_hit_at, structured_value, tags FROM memory_records WHERE id = ?",
            (mem_id,)).fetchone()
        if not row:
            return {}
        src = ""
        try:
            sv = json.loads(row[3]) if row[3] else {}
            src = str(sv.get("source") or "")
        except Exception:
            src = ""
        try:
            tg = json.loads(row[4]) if row[4] else []
            tags = [str(t) for t in tg] if isinstance(tg, list) else []
        except Exception:
            tags = []
        return {"summary": row[0] or "", "hit_count": row[1] or 0, "last_hit_at": row[2] or 0, "source": src, "tags": tags}
    finally:
        conn.close()


def _write_extra(store, mem_id: str, summary: str = "", source: str = "", tags=None, hist=None) -> None:
    """0924：tags=None 不动；list（含空列表）= 覆写为该 JSON 数组（审核「采纳」清标签用）。
    hist=旧版本列表（刀③ 留痕）→ 存 structured_value.history。"""
    conn = store._conn()
    try:
        sets = ["summary = ?", "structured_value = ?"]
        sv = {"source": source}
        if hist is not None:
            sv["history"] = hist
        vals = [summary, json.dumps(sv, ensure_ascii=False)]
        if tags is not None:
            sets.append("tags = ?")
            vals.append(json.dumps([str(t) for t in tags], ensure_ascii=False))
        vals.append(mem_id)
        conn.execute("UPDATE memory_records SET " + ", ".join(sets) + " WHERE id = ?", vals)
        conn.commit()
    finally:
        conn.close()


def _mark_hits(store, ids) -> None:
    """命中回写：一次检索 = 一次使用，冷热分层的数据来源。"""
    if not ids:
        return
    now = time.time()
    conn = store._conn()
    try:
        for i in ids:
            conn.execute("UPDATE memory_records SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?", (now, i))
        conn.commit()
    finally:
        conn.close()


def _weighted_score(mem, score: float, extra: dict | None = None) -> float:
    """权重分层：语义分 × (1 + 0.2·重要性) × 冷热 × 时效。
    冷热：近 7 天用过 ×1.1 / 90 天没用 ×0.9（冷冻不删）；过期事实 ×0.7。"""
    ex = extra or {}
    base = float(score) * (1.0 + 0.2 * float(getattr(mem, "importance", None) or 0.5))
    la = float(ex.get("last_hit_at") or 0)
    now = time.time()
    if la and la > now - 7 * 86400:
        base *= 1.1
    elif la and la < now - 90 * 86400:
        base *= 0.9
    vu = float(getattr(mem, "valid_until", None) or 0)
    if vu and vu < now:
        base *= 0.7
    # 0924 已定案 A+C：待确认（pending_review）降权 0.7 —— 可作线索、顺位靠后，别抢已确认记忆的戏
    tg = ex.get("tags") if isinstance(ex, dict) else None
    if isinstance(tg, list) and "pending_review" in tg:
        base *= 0.7
    return base


def _cosine(a, b) -> float:
    try:
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(y * y for y in b) ** 0.5
        return dot / (na * nb) if na and nb else 0.0
    except Exception:
        return 0.0


def _cosine_pair(store, text_a: str, text_b: str) -> float:
    # 真余弦（0924 二期批4）：embed 后比对；无嵌入模型/失败返回 0（调用方自行 fallback 混合分）
    try:
        ef = _embed_fn()
        if ef is None:
            return 0.0
        return _cosine(ef(text_a), ef(text_b))
    except Exception:
        return 0.0


def _norm_sim(a: str, b: str) -> float:
    """字面近重复度（字符 bigram Jaccard + 包含关系加成；0~1）—— 与 server.ts simScore 同口径。
    0924：替代"hybrid 分当余弦"的错位尺子，作为合并/查重的主判据。"""
    def norm(s: str) -> str:
        return "".join(ch for ch in str(s or "").lower() if ch.isalnum())
    x, y = norm(a), norm(b)
    if not x or not y:
        return 0.0
    if x == y:
        return 1.0
    if x in y or y in x:
        return (min(len(x), len(y)) / max(len(x), len(y))) * 0.9 + 0.1

    def grams(s: str):
        return {s[i:i + 2] for i in range(len(s) - 1)}
    A, B = grams(x), grams(y)
    inter = len(A & B)
    uni = len(A) + len(B) - inter
    return inter / uni if uni else 0.0


def _auto_link_memory(store, mem_id: str, content: str, scope_type=None, scope_id: str = "") -> int:
    """写入即关联（0924 一期 B）：新记忆 vs 全库语义对比 —— 中等相似（0.55~0.92）自动连
    「相关」边（>0.92 的在写入查重层已合并成同一条）。边存 memory_edges，星系连线与
    检索"顺藤摸瓜"都吃这张表。fts 模式下相似度公式与写入查重一致（保守，少连不乱连）。"""
    try:
        from core.memory.models import MemoryStatus
        res = store.search(
            text=content, scope_type=scope_type, scope_id=scope_id,
            top_k=8, mode="vector" if store._retrieval_backend else "fts",
        )
    except Exception as e:
        print(f"[memory-bridge] auto_link search failed: {e}", flush=True)
        return 0
    made = 0
    try:
        g = _get_graph()
        for m, s in zip(res.memories, res.scores):
            if str(m.id) == str(mem_id) or getattr(m, "status", None) != MemoryStatus.ACTIVE:
                continue
            sim = float(s) if res.retrieval_method in ("vector", "hybrid") else 1.0 / (1.0 + abs(float(s)))
            # 0924：阈值按 hybrid 混合分量纲校准（实测强命中 ≈0.85、可 >1；不是余弦！）。
            # 宽进宽出 [0.45, 0.95)：太像的在写入查重层（≥0.92）已合并成同一条，这里只管"中等相似连边"。
            # 二期升级真余弦（取 embedding 直接算）后可收紧。
            if _embedding_provider:
                cos_link = _cosine_pair(store, content, m.content)
                link_ok = 0.55 <= cos_link < 0.92
            else:
                link_ok = 0.45 <= sim < 0.95
            if link_ok:
                try:
                    g.add_edge(str(mem_id), str(m.id), "related")
                    made += 1
                except Exception as e2:
                    print(f"[memory-bridge] auto_link add_edge failed: {e2}", flush=True)
    except Exception:
        return made
    return made


def _memory_to_dict(m, score: float | None = None) -> dict:
    d = {
        "id": m.id,
        "memory_type": getattr(m.memory_type, "value", str(m.memory_type or "")),
        "scope_type": getattr(m.scope_type, "value", str(m.scope_type or "")),
        "scope_id": m.scope_id or "",
        "content": m.content or "",
        "status": getattr(m.status, "value", str(m.status or "")),
        "confidence": m.confidence,
        "importance": m.importance,
        "source_type": m.source_type or "",
        "tags": m.tags or [],
        "created_at": m.created_at,
        "updated_at": m.updated_at,
    }
    if score is not None:
        d["score"] = round(float(score), 4)
    return d


def handle_memory_search(params: dict) -> dict:
    from core.memory.models import SearchQuery, ScopeType, MemoryStatus
    store = _get_store()
    _ensure_extra_columns(store)
    query = str(params.get("query") or "").strip()
    top_k = int(params.get("top_k") or 5)
    scope = str(params.get("scope") or "nis_core")
    scope_type = ScopeType.PROJECT if scope == "project" else ScopeType.NIS_CORE
    # project scope 需要具体 scope_id；nis_core 用全局根作用域
    scope_id = str(params.get("scope_id") or "")
    if scope_type == ScopeType.NIS_CORE:
        scope_id = scope_id or _nis_core_scope_id or ""
    if not query:
        return {"memories": [], "retrieval_method": "none"}
    res = store.search(SearchQuery(
        text=query,
        scope_type=scope_type,
        scope_id=scope_id,
        top_k=top_k * 3,  # 扩大候选集再分层过滤
    ))
    # 分层过滤：默认只返回 core+hot+warm；layers=all 时含 cold/archive
    layers = str(params.get("layers") or "auto")
    filtered = []
    for m, s in zip(res.memories, res.scores):
        if m.status != MemoryStatus.ACTIVE:
            continue
        if m.retention_policy == "archive":
            if layers != "all":
                continue
            filtered.append((m, s))
            continue
        layer = store.memory_layer(m)
        if layers == "all":
            filtered.append((m, s))
        elif layer in ("core", "hot", "warm"):
            filtered.append((m, s))
        if len(filtered) >= top_k:
            break
    # ── 0924 一期：权重重排 + 摘要优先（两级检索：detail=1 才给全文）+ 命中回写 ──
    detail = bool(params.get("detail"))
    items = []
    for m, s in filtered:
        ex = _extra_fields(store, m.id) or {}
        d = _memory_to_dict(m, _weighted_score(m, s, ex))
        d.update(ex)
        if "pending_review" in (d.get("tags") or []):
            d["pending"] = True  # A+C：未确认记忆显式标注（自动提炼/待审核），引用前先与用户核实
        if not detail:
            d["content"] = (ex.get("summary") or (m.content or ""))[:120]
        items.append(d)
    items.sort(key=lambda x: x.get("score") or 0, reverse=True)
    # ── 顺藤摸瓜（0924 一期 B）：命中条目沿「相关」边带出 1 跳邻居（×0.8 权重，同主题散碎记忆一次到案）──
    try:
        g = _get_graph()
        seen = {str(d0.get("id") or "") for d0 in items}
        for d0 in items[:3]:
            for e in (g.get_edges(str(d0.get("id") or "")) or []):
                src = str(e.get("source_node") or "")
                tgt = str(e.get("target_node") or "")
                other = tgt if src == str(d0.get("id")) else src
                if not other or other in seen or not other.startswith("mem_"):
                    continue
                seen.add(other)
                nm = store.get(other)
                if nm is None or getattr(nm, "status", None) != MemoryStatus.ACTIVE:
                    continue
                ex = _extra_fields(store, other) or {}
                d1 = _memory_to_dict(nm, _weighted_score(nm, (d0.get("score") or 0.5) * 0.8, ex))
                d1.update(ex)
                d1["via"] = d0.get("id")
                if "pending_review" in (d1.get("tags") or []):
                    d1["pending"] = True
                if not detail:
                    d1["content"] = (ex.get("summary") or (nm.content or ""))[:120]
                items.append(d1)
    except Exception:
        pass
    _mark_hits(store, [m.id for m, _ in filtered])  # 最后回写，避免污染本次冷热权重
    return {
        "memories": items,
        "retrieval_method": res.retrieval_method,
        "total_candidates": len(filtered),
        "layers": layers,
        "detail": detail,
    }


def handle_memory_maintenance(params: dict) -> dict:
    """每日维护：purge 软删 / 过期标记 / 旧事件清理 / Cold 归档"""
    store = _get_store()
    return store.maintenance()


def handle_memory_store(params: dict) -> dict:
    from core.memory.models import Memory, MemoryType, ScopeType, MemoryStatus, MemorySourceType
    store = _get_store()
    _ensure_extra_columns(store)
    content = str(params.get("content") or "").strip()
    if not content:
        raise ValueError("content required")
    # 0924 一期：6 类必选（preference/decision/lesson/pattern/fact/profile），兼容老 memory_type 直传
    category = str(params.get("category") or "").strip().lower()
    if category in CATEGORY_TO_TYPE:
        mtype = CATEGORY_TO_TYPE[category]
    else:
        mtype = str(params.get("memory_type") or "semantic")
        if mtype not in [t.value for t in MemoryType]:
            mtype = "semantic"
    summary = str(params.get("summary") or "").strip()
    if not summary:
        summary = content.splitlines()[0][:60] if content else ""
    source = str(params.get("source") or "ai").strip() or "ai"
    # 0924：tags 流转（0913 待确认审核区靠 pending_review 标签；auto 提炼会带 from_auto_memory）
    tags = [str(t).strip() for t in (params.get("tags") or []) if str(t).strip()][:12]
    importance = float(params.get("importance") or 0.5)
    scope = str(params.get("scope") or "nis_core")
    scope_type = ScopeType.PROJECT if scope == "project" else ScopeType.NIS_CORE
    scope_id = str(params.get("scope_id") or "")
    if scope_type == ScopeType.NIS_CORE:
        scope_id = scope_id or _nis_core_scope_id or ""

    # ── 查重：写入前语义检索相似记忆（>0.92 视为重复）→ 合并更新旧条目，不新建 ──
    try:
        dup_result = store.search(
            text=content, scope_type=scope_type, scope_id=scope_id,
            top_k=5, mode="vector" if store._retrieval_backend else "fts",
        )
        for mem, score in zip(dup_result.memories, dup_result.scores):
            if mem.status != MemoryStatus.ACTIVE or mem.superseded_by:
                continue
            # 0924 刀①：合并判据双轨 —— 字面近重复（Jaccard≥0.85，主）或 语义保守线（≥0.95，hybrid 分量纲）
            sim = score if dup_result.retrieval_method in ("vector", "hybrid") else 1.0 / (1.0 + abs(score))
            cos_dup = _cosine_pair(store, content, mem.content) if _embedding_provider else 0.0
            if _norm_sim(content, mem.content) < 0.85 and cos_dup < 0.92 and sim < 0.95:
                continue
            # 命中重复：旧条目合并新内容（版本 +1，保留原 id 与记忆链）
            try:
                merged = store.update(
                    mem.id,
                    {"content": content, "importance": max(mem.importance, importance),
                     "last_confirmed_at": time.time()},
                    expected_version=mem.version,
                )
                if merged:
                    # 0924 刀③：覆盖式更新 + 旧版留痕（structured_value.history 最多 5 版，可查回）
                    old_hist = []
                    try:
                        sv_old = json.loads(getattr(mem, "structured_value", None) or "{}")
                        old_hist = list(sv_old.get("history") or [])
                    except Exception:
                        old_hist = []
                    prev_ex = _extra_fields(store, mem.id) or {}
                    old_hist.insert(0, {"at": time.time(), "content": str(getattr(mem, "content", "") or "")[:2000], "summary": str(prev_ex.get("summary") or "")})
                    hist = old_hist[:5]
                    _write_extra(store, mem.id, summary=summary, source=source, tags=(tags or None), hist=hist)
                    out = _memory_to_dict(merged)
                    out.update(_extra_fields(store, mem.id))
                    return {"memory": out, "deduped": True, "merged_from": mem.id}
            except Exception as e:
                print(f"[memory-bridge] dedup merge failed: {e}", flush=True)
            break
    except Exception as e:
        print(f"[memory-bridge] dedup check failed: {e}", flush=True)

    candidate = Memory(
        id="",
        scope_type=scope_type,
        scope_id=scope_id,
        memory_type=MemoryType(mtype),
        content=content,
        status=MemoryStatus.ACTIVE,
        importance=importance,
        source_type=MemorySourceType.USER_EXPLICIT.value,
    )
    saved = store.add(candidate)
    _write_extra(store, saved.id, summary=summary, source=source, tags=(tags or None))
    linked = _auto_link_memory(store, saved.id, content, scope_type, scope_id)  # 0924 一期 B：写入即关联
    out = _memory_to_dict(saved)
    out.update(_extra_fields(store, saved.id))
    return {"memory": out, "linked": linked}


def handle_memory_delete(params: dict) -> dict:
    """删除记忆：按 id 精确删除；或按内容关键词检索后删除匹配条目（软删/硬删）"""
    # ★1007 修复（上线前检查·critical）：下方 store.search(SearchQuery(...)) 此前未导入 SearchQuery
    #   ⇒ 按关键词删除永远 NameError（被外层 except 吞成 deleted:False / no_match）。
    from core.memory.models import SearchQuery, MemoryStatus, ScopeType
    store = _get_store()
    mid = str(params.get("id") or "").strip()
    query = str(params.get("query") or "").strip()
    hard = bool(params.get("hard"))
    scope = str(params.get("scope") or "nis_core")
    scope_type = ScopeType.PROJECT if scope == "project" else ScopeType.NIS_CORE
    scope_id = str(params.get("scope_id") or "")
    if scope_type == ScopeType.NIS_CORE:
        scope_id = scope_id or _nis_core_scope_id or ""

    if mid:
        mem = store.get(mid)
        if mem is None:
            return {"deleted": False, "reason": "not_found", "memory_id": mid}
        try:
            store.change_state(mid, MemoryStatus.SOFT_DELETED, reason="user_delete")
            if hard:
                store.change_state(mid, MemoryStatus.HARD_DELETED, reason="user_delete_hard")
            return {"deleted": True, "memory_id": mid, "hard": hard}
        except Exception as e:
            return {"deleted": False, "reason": str(e)[:200], "memory_id": mid}

    if not query:
        raise ValueError("id or query required")
    # 按内容语义检索，取匹配的记忆删除（不强制子串匹配：语义相关即候选，避免"多轮删不掉"）
    try:
        res = store.search(SearchQuery(
            text=query,
            scope_type=scope_type,
            scope_id=scope_id,
            top_k=5,
        ))
    except Exception:
        res = None
    candidates = []
    if res is not None:
        candidates = list(res.memories)
    if not candidates:
        return {"deleted": False, "reason": "no_match", "query": query}
    deleted = []
    for m in candidates:
        try:
            store.change_state(m.id, MemoryStatus.SOFT_DELETED, reason="user_delete")
            if hard:
                store.change_state(m.id, MemoryStatus.HARD_DELETED, reason="user_delete_hard")
            deleted.append(m.id)
        except Exception:
            continue
    return {"deleted": len(deleted) > 0, "deleted_ids": deleted, "query": query, "hard": hard}


def _embed_fn():
    """给知识库的**语义关联**用的嵌入函数（没装模型就返回 None，退回字面关联）。

    ⚠️ 第一次调用会真的加载 bge-small-zh-v1.5（几秒）—— 与记忆检索同一条懒加载路径。
    """
    _ensure_embedding()
    if _embedding_provider is None:
        return None
    return lambda text: _embedding_provider.embed(text)


def _resolve_category(ks, name: str) -> str:
    """分类名 → 分类(folder) id。已存在同名分类就用它；**不存在就新建**（设计口径：
    "以后的未分类让 ai 根据情况来分"）。给空名 → 返回 ''（保持未分类，不硬塞）。"""
    n = str(name or "").strip()
    if not n:
        return ""
    try:
        for e in ks.list_all(limit=500):
            if e.entry_type == "folder" and str(e.title or "").strip() == n:
                return e.id
        from core.knowledge.models import KnowledgeEntry
        folder = ks.add(KnowledgeEntry(id="", title=n, content="", summary="",
                                      entry_type="folder", tags=[], project_id=""))
        return folder.id
    except Exception:
        return ""


def handle_knowledge_query(params: dict) -> dict:
    ks = _get_knowledge()
    query = str(params.get("query") or "").strip()
    top_k = int(params.get("top_k") or 5)
    project_id = str(params.get("project_id") or "")
    # 分类清单（folder）：让 AI 写入前知道"已有哪几类"，能归就归、别乱建
    categories = [{"id": e.id, "name": e.title} for e in ks.list_all(limit=500) if e.entry_type == "folder"]
    if query:
        results = ks.search(query, project_id=project_id, top_k=top_k)
        entries = []
        for r in results:
            entry = r.get("entry") if isinstance(r.get("entry"), dict) else r
            entries.append({
                "id": entry.get("id"),
                "title": entry.get("title"),
                "content": entry.get("content"),
                "entry_type": entry.get("entry_type"),
                "tags": entry.get("tags") or [],
                "project_id": entry.get("project_id") or "",
                "score": r.get("score"),
            })
        return {"entries": entries, "hit": True, "categories": categories}
    # 空查询：列最近条目
    recent = [e for e in ks.list_all(limit=max(top_k, 5)) if e.entry_type != "folder"]
    return {
        "entries": [{
            "id": e.id, "title": e.title, "content": e.content,
            "entry_type": e.entry_type, "tags": e.tags or [],
            "project_id": e.project_id or "",
        } for e in recent],
        "hit": False,
        "categories": categories,
    }


def handle_knowledge_list(params: dict) -> dict:
    ks = _get_knowledge()
    project_id = str(params.get("project_id") or "")
    # ★ 0919：升级后**第一次**打开知识库时，把已有条目也补一遍关联（只做一次，见 store.backfill_relations）。
    #   不补的话老条目在星系里永远是一堆孤点 —— 写入侧只解决"以后"。
    if ks.get_meta("rel_backfill") != "done":
        try:
            made = ks.backfill_relations(embed=_embed_fn())
            ks.set_meta("rel_backfill", "done")
            if made:
                print(f"[knowledge] 老条目补关联：新建 {made} 条边", file=sys.stderr)
        except Exception:
            pass
    entries = ks.list_all(project_id=project_id, limit=500)
    return {
        "entries": [{
            "id": e.id, "title": e.title, "content": e.content, "summary": e.summary,
            "entry_type": e.entry_type, "tags": e.tags or [],
            "project_id": e.project_id or "", "parent_id": e.parent_id or "",
            "version": e.version, "created_at": e.created_at, "updated_at": e.updated_at,
        } for e in entries],
        # 关联边（0919）：星系里的星桥直接用它画，前端不再自己"猜"（原来按同 tag 连是演示逻辑）
        "relations": ks.list_relations(),
    }


def handle_knowledge_add(params: dict) -> dict:
    from core.knowledge.models import KnowledgeEntry
    ks = _get_knowledge()
    title = str(params.get("title") or "").strip()
    content = str(params.get("content") or "").strip()
    if not title and not content:
        raise ValueError("title or content required")
    # 分类：优先显式 parent_id；否则按 category 名找/建分类；都没有就保持未分类
    parent_id = str(params.get("parent_id") or "")
    if not parent_id and params.get("category"):
        parent_id = _resolve_category(ks, str(params.get("category")))
    entry = KnowledgeEntry(
        id="",
        title=title or (content[:20] if content else "未命名"),
        content=content,
        summary=str(params.get("summary") or ""),
        entry_type=str(params.get("entry_type") or "doc"),
        tags=list(params.get("tags") or []),
        project_id=str(params.get("project_id") or ""),
        parent_id=parent_id,
        source_url=str(params.get("source_url") or ""),
        source_label=str(params.get("source_label") or ""),
        version=1,
    )
    # ── 0924 刀②：写入查重 —— 字面近重复（Jaccard≥0.85 或标题全含）命中 = 覆盖式更新旧条目（刀③ 留痕）──
    try:
        cand = ks.list_all(limit=500)
    except Exception:
        cand = []
    new_text = (title or "") + "\n" + (content or "")
    for old in cand:
        if old.entry_type == "folder":
            continue
        old_text = (old.title or "") + "\n" + (old.content or "")
        if _norm_sim(new_text, old_text) < 0.85:
            continue
        try:
            hist_key = "history:" + old.id
            hist = []
            try:
                hist = json.loads(ks.get_meta(hist_key) or "[]")
                if not isinstance(hist, list):
                    hist = []
            except Exception:
                hist = []
            hist.insert(0, {"at": time.time(), "content": (old.content or "")[:2000], "summary": (old.summary or "")})
            try:
                ks.set_meta(hist_key, json.dumps(hist[:5], ensure_ascii=False))
            except Exception:
                pass
            updated = ks.update(old.id, {
                "title": title or old.title,
                "content": content or old.content,
                "summary": str(params.get("summary") or old.summary or ""),
                "tags": (list(params.get("tags") or []) or old.tags),
                "parent_id": parent_id or old.parent_id,
            })
            if updated:
                try:
                    ks.auto_link(updated, embed=_embed_fn())
                except Exception:
                    pass
                return {"entry": {
                    "id": updated.id, "title": updated.title, "content": updated.content,
                    "entry_type": updated.entry_type, "tags": updated.tags or [],
                    "project_id": updated.project_id or "",
                    "parent_id": updated.parent_id or "",
                }, "deduped": True, "merged_from": old.id, "linked": {}}
        except Exception as e3:
            print(f"[memory-bridge] knowledge dedup update failed: {e3}", flush=True)
            break
    saved = ks.add(entry)
    # ★ 0919：落库后自动建关联边（字面/标签 + 装了模型再算语义）——
    #   "提炼完 / AI 写入要根据关联性划线"就靠这一步；星系不再是一堆孤点。
    link = {}
    try:
        link = ks.auto_link(saved, embed=_embed_fn())
    except Exception:
        link = {"linked": 0, "origin": "auto", "error": traceback.format_exc(limit=1)}
    return {"entry": {
        "id": saved.id, "title": saved.title, "content": saved.content,
        "entry_type": saved.entry_type, "tags": saved.tags or [],
        "project_id": saved.project_id or "",
        "parent_id": saved.parent_id or "",
    }, "linked": link}


def handle_knowledge_delete(params: dict) -> dict:
    ks = _get_knowledge()
    eid = str(params.get("id") or "")
    if not eid:
        raise ValueError("id required")
    ok = ks.delete(eid)
    return {"deleted": ok}


def handle_knowledge_update(params: dict) -> dict:
    ks = _get_knowledge()
    eid = str(params.get("id") or "")
    if not eid:
        raise ValueError("id required")
    changes = {
        k: params[k] for k in ("title", "content", "summary", "entry_type", "tags",
                               "project_id", "source_url", "source_label", "parent_id", "attachments")
        if k in params
    }
    updated = ks.update(eid, changes)
    if not updated:
        return {"updated": False}
    return {"updated": True, "entry": {
        "id": updated.id, "title": updated.title, "content": updated.content,
        "summary": updated.summary, "entry_type": updated.entry_type,
        "tags": updated.tags or [], "project_id": updated.project_id or "",
        "parent_id": updated.parent_id or "", "version": updated.version,
        "created_at": updated.created_at, "updated_at": updated.updated_at,
    }}


# ── 记忆网图（memory_graph.py 的节点/关系 CRUD）──────────────

_graph = None


def _get_graph():
    global _graph
    if _graph is None:
        from core.memory.memory_graph import MemoryGraph
        _graph = MemoryGraph(_get_store())
    return _graph


def handle_memory_graph(params: dict) -> dict:
    """网图 + 长期记忆合并导出：星系里同时显示网图节点与长期记忆（memories 表 ACTIVE）"""
    from core.memory.models import MemoryStatus, MemoryType, ScopeType
    g = _get_graph()
    scope = str(params.get("scope") or "all")
    project_id = str(params.get("project_id") or "")
    result = g.get_graph(scope=scope, project_id=project_id or None)
    nodes = list(result.get("nodes") or [])
    edges = list(result.get("edges") or [])
    # 合并长期记忆（memories 表）：id 用 mem_ 前缀，与网图 mnode_ 区分；用户可在星系管理/删除
    try:
        store = _get_store()
        scope_type = ScopeType.PROJECT if scope == "project" else None
        scope_id = project_id or (_nis_core_scope_id or "")
        conn = store._conn()
        # 0924：加 ORDER BY created_at DESC —— 之前无排序，返回 rowid 升序（最老的排最前），
        # 库里 7/8 月的自动抽取流水会把"今天刚写的记忆"压在几十条之后，用户在前端看不到。
        sql = "SELECT * FROM memory_records WHERE status = ?"
        params2 = [MemoryStatus.ACTIVE.value]
        if scope_type is not None and scope_id:
            sql += " AND scope_type = ? AND scope_id = ?"
            params2 += [scope_type.value, scope_id]
        sql += " ORDER BY created_at DESC, rowid DESC"
        rows = conn.execute(sql, params2).fetchall()
        conn.close()
        _ensure_extra_columns(store)
        mem_nodes = []
        for row in rows:
            d = dict(row)
            content = str(d.get("content") or "")
            src = ""
            try:
                sv = json.loads(d.get("structured_value")) if d.get("structured_value") else {}
                src = str(sv.get("source") or "")
            except Exception:
                src = ""
            try:
                tg0 = json.loads(d.get("tags")) if d.get("tags") else []
                tags0 = [str(t) for t in tg0] if isinstance(tg0, list) else []
            except Exception:
                tags0 = []
            mem_nodes.append({
                "id": str(d.get("id") or ""),
                "title": content.splitlines()[0][:40] if content else "记忆",
                "content": content,
                "summary": str(d.get("summary") or content[:60]),
                # 0924 一期：废除"长期记忆"兜底桶 → 按 memory_type 映射 6 类（偏好/决策/教训/模式/事实/画像）
                "node_type": _map_node_type(d.get("memory_type")),
                "scope": str(d.get("scope_type") or "nis_core"),
                "project_id": str(d.get("scope_id") or ""),
                "tags": tags0 + (["src:" + src] if src else []),
                "enabled": True,
                "md_file": None,
                "md_section": None,
                "source_window": None,
                "source_conversation": None,
                "source_type": str(d.get("source_type") or ""),
                "importance": d.get("importance"),
                "hit_count": d.get("hit_count") or 0,
                "last_hit_at": d.get("last_hit_at") or 0,
                "created_at": d.get("created_at"),
                "updated_at": d.get("updated_at"),
            })
        nodes = mem_nodes + nodes
        # 0924 一期 B：mem 记忆之间的关联边也要进图（get_graph 只回网图节点的边，会把 mem_ 边滤掉）
        try:
            ids2 = {str(n.get("id") or "") for n in nodes}
            seen_e = {str(e.get("id") or "") for e in edges}
            conn2 = store._conn()
            try:
                for er in conn2.execute("SELECT * FROM memory_edges").fetchall():
                    ed = dict(er)
                    eid = str(ed.get("id") or "")
                    if eid in seen_e:
                        continue
                    if str(ed.get("source_node") or "") in ids2 and str(ed.get("target_node") or "") in ids2:
                        edges.append(ed)
                        seen_e.add(eid)
            finally:
                conn2.close()
        except Exception as e2:
            print(f"[memory-bridge] graph merge mem-edges failed: {e2}", flush=True)
    except Exception as e:
        print(f"[memory-bridge] graph merge long-term failed: {e}", flush=True)
    return {"nodes": nodes, "edges": edges}


def handle_memory_node_add(params: dict) -> dict:
    g = _get_graph()
    node_id = g.add_node(
        title=str(params.get("title") or "未命名记忆"),
        content=str(params.get("content") or ""),
        summary=str(params.get("summary") or ""),
        node_type=str(params.get("node_type") or "fact"),
        scope=str(params.get("scope") or "project"),
        project_id=str(params.get("project_id") or "") or None,
        tags=list(params.get("tags") or []),
        source_type=str(params.get("source_type") or ""),
    )
    node = g.get_node(node_id)
    return {"node": node}


def handle_memory_node_update(params: dict) -> dict:
    nid = str(params.get("id") or "")
    # 0924：mem_ 长期记忆也可改 —— 0913「待确认」审核区的「采纳」（清 pending_review 标签）走这里；
    # 此前只认网图节点表，导致提炼统一进记忆表后采纳按钮失灵（回归，已修）。
    if nid.startswith("mem_"):
        store = _get_store()
        _ensure_extra_columns(store)
        if "tags" in params:
            new_tags = [str(t).strip() for t in (params.get("tags") or []) if str(t).strip()][:12]
            _write_extra(store, nid, tags=new_tags)
        ex = _extra_fields(store, nid) or {}
        return {"node": {"id": nid, "tags": ex.get("tags") or []}}
    g = _get_graph()
    if not nid:
        raise ValueError("id required")
    changes = {k: params[k] for k in ("title", "content", "summary", "tags", "node_type")
               if k in params}
    ok = g.update_node(nid, **changes)
    return {"updated": ok, "node": g.get_node(nid) if ok else None}


def handle_memory_node_delete(params: dict) -> dict:
    g = _get_graph()
    nid = str(params.get("id") or "")
    if not nid:
        raise ValueError("id required")
    return {"deleted": g.delete_node(nid)}


def handle_memory_edge_add(params: dict) -> dict:
    g = _get_graph()
    source = str(params.get("source_node") or params.get("source") or "")
    target = str(params.get("target_node") or params.get("target") or "")
    relation = str(params.get("relation") or "related")
    if not source or not target:
        raise ValueError("source_node and target_node required")
    edge_id = g.add_edge(source, target, relation)
    return {"edge_id": edge_id}


def handle_memory_edge_delete(params: dict) -> dict:
    g = _get_graph()
    eid = str(params.get("id") or "")
    if not eid:
        raise ValueError("id required")
    return {"deleted": g.delete_edge(eid)}


def handle_memory_digest(params: dict) -> dict:
    # 0924 二期批6b 核心小抄：命中次数最高的摘要（默认 5）——会话级速查，省一次检索
    store = _get_store()
    _ensure_extra_columns(store)
    n = int(params.get("top_k") or 5)
    conn = store._conn()
    try:
        rows = conn.execute(
            "SELECT id, summary, content, memory_type, hit_count FROM memory_records "
            "WHERE status = 'active' ORDER BY hit_count DESC, updated_at DESC LIMIT ?",
            (max(1, min(n, 10)),)).fetchall()
    finally:
        conn.close()
    items = []
    for r in rows:
        s = r[1] or (r[2] or "")[:60]
        if s:
            items.append({"id": r[0], "summary": s, "memory_type": r[3], "hit_count": r[4] or 0})
    return {"items": items}


HANDLERS = {
    "memory_digest": handle_memory_digest,
    "memory_search": handle_memory_search,
    "memory_store": handle_memory_store,
    "memory_delete": handle_memory_delete,
    "memory_maintenance": handle_memory_maintenance,
    "knowledge_query": handle_knowledge_query,
    "knowledge_list": handle_knowledge_list,
    "knowledge_add": handle_knowledge_add,
    "knowledge_update": handle_knowledge_update,
    "knowledge_delete": handle_knowledge_delete,
    "memory_graph": handle_memory_graph,
    "memory_node_add": handle_memory_node_add,
    "memory_node_update": handle_memory_node_update,
    "memory_node_delete": handle_memory_node_delete,
    "memory_edge_add": handle_memory_edge_add,
    "memory_edge_delete": handle_memory_edge_delete,
}


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    # 预加载（启动即建连，供 Node 侧检测就绪）
    try:
        _get_store()
        _get_knowledge()
    except Exception:
        pass
    print(json.dumps({"ready": True}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            rid = req.get("id")
            params = req.get("params") or {}
            if op == "ping":
                print(json.dumps({"id": rid, "ok": True, "result": {"pong": True}}, ensure_ascii=False), flush=True)
                continue
            handler = HANDLERS.get(op)
            if not handler:
                raise ValueError(f"unknown op: {op}")
            result = handler(params)
            print(json.dumps({"id": rid, "ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({
                "id": rid if 'rid' in locals() else None,
                "ok": False,
                "error": str(e)[:500],
            }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
