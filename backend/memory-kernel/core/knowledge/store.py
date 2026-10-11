from __future__ import annotations

import json
import sqlite3
import time
from typing import Optional

from core.knowledge.models import KnowledgeEntry
from core.knowledge.schema import init_knowledge_db

# 字面相似（复用记忆库那套：LCS + 关键 token，中文短文本友好，**不依赖模型**）
from core.memory.text_utils import text_similarity

# ── 自动关联的参数（0919）───────────────────────────────────────────
#   AI 写入时固定塞的两个系统标签 —— **不参与**"相关性"判定，
#   否则所有 AI 写入的条目都共享它们 → 全连成一张网，等于没连。
_SYSTEM_TAGS = {"pending_review", "from_knowledge_add"}
# 字面相关阈值（比"查重"的 0.45 低：要的是"相关"不是"重复"）
_TITLE_SIM_THRESHOLD = 0.34
# 语义相关阈值（与记忆库 _EMBED_SIM_THRESHOLD 一致）
_EMBED_SIM_THRESHOLD = 0.6
# 一条新条目最多连几条
_MAX_LINKS = 5
# 每次写入最多补算多少条老条目的向量（懒补齐，别让一次写入卡住）
_BACKFILL_MAX = 30


def _link_text(title: str, summary: str, content: str, long: bool = False) -> str:
    """用于相似度比较的短文本。

    ★ **不要拿整篇正文去比**：text_similarity 是 LCS（O(n·m)），几万字的正文会当场卡住。
      字面比较用「标题 + 摘要（缺则正文前 400 字）」；语义嵌入（long=True）才多带一点正文。
    """
    t = str(title or "")
    s = str(summary or "").strip()
    c = str(content or "").strip()
    body = s if s else c[:400]
    if long:
        return (t + "\n" + body + "\n" + c[:800]).strip()
    return (t + "\n" + body).strip()


def _json_list(raw) -> list:
    """库里 tags 存的是 JSON 字符串；容错成 list。"""
    if isinstance(raw, list):
        return raw
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except Exception:
        return []


def _escape_fts(text: str) -> str:
    """FTS5 查询转义：把整段查询按空白分词，每个词用双引号包裹（含特殊字符如 c++/c#/a+b 也能安全匹配）。"""
    t = (text or "").strip()
    if not t:
        return t
    words = t.split()
    if len(words) > 1:
        return " OR ".join(f'"{w.replace(chr(34), chr(34)*2)}"' for w in words)
    return f'"{t.replace(chr(34), chr(34)*2)}"'


def _search_keywords(text: str) -> list[str]:
    """把查询拆成检索关键词（提高中文命中率）：
    - 英文/数字词原样（小写）
    - 中文连续段：≤3 字整体；>3 字取整段 + 全部 2-gram（避免整句 LIKE 精确匹配导致漏检）
    """
    import re as _re
    out: list[str] = []
    seen: set[str] = set()
    for seg in _re.findall(r'[\u4e00-\u9fff]+|[A-Za-z0-9]+', text):
        if _re.fullmatch(r'[\u4e00-\u9fff]+', seg):
            cands = [seg] if len(seg) <= 3 else [seg] + [seg[i:i + 2] for i in range(len(seg) - 1)]
        else:
            cands = [seg.lower()]
        for c in cands:
            if c and len(c) >= 2 and c not in seen:
                seen.add(c)
                out.append(c)
    return out


class KnowledgeStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        init_knowledge_db(db_path)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def add(self, entry: KnowledgeEntry) -> KnowledgeEntry:
        if not entry.id:
            entry.id = f"kb_{__import__('uuid').uuid4().hex[:12]}"
        now = time.time()
        entry.created_at = now
        entry.updated_at = now

        conn = self._conn()
        conn.execute(
            """INSERT INTO knowledge_entries
               (id, title, content, summary, entry_type, tags, project_id, source_url, source_label, parent_id, attachments, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry.id, entry.title, entry.content, entry.summary, entry.entry_type,
                json.dumps(entry.tags, ensure_ascii=False),
                entry.project_id, entry.source_url, entry.source_label, entry.parent_id,
                json.dumps(entry.attachments, ensure_ascii=False),
                entry.version,
                entry.created_at, entry.updated_at,
            ),
        )
        conn.commit()
        conn.close()
        return entry

    def get(self, entry_id: str) -> Optional[KnowledgeEntry]:
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM knowledge_entries WHERE id = ?", (entry_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return self._row_to_entry(row)

    def update(self, entry_id: str, changes: dict) -> Optional[KnowledgeEntry]:
        entry = self.get(entry_id)
        if not entry:
            return None

        allowed = {"title", "content", "summary", "entry_type", "tags", "source_url", "source_label", "parent_id", "attachments"}
        set_clauses = []
        params = []
        for key, value in changes.items():
            if key in allowed:
                set_clauses.append(f"{key} = ?")
                if key in ("tags", "attachments"):
                    params.append(json.dumps(value, ensure_ascii=False))
                else:
                    params.append(value)

        if not set_clauses:
            return entry

        entry.version += 1
        set_clauses.append("version = ?")
        params.append(entry.version)
        set_clauses.append("updated_at = ?")
        params.append(time.time())
        params.append(entry_id)

        conn = self._conn()
        conn.execute(
            f"UPDATE knowledge_entries SET {', '.join(set_clauses)} WHERE id = ?",
            params,
        )
        conn.commit()
        conn.close()
        return self.get(entry_id)

    def delete(self, entry_id: str) -> bool:
        conn = self._conn()
        cursor = conn.execute(
            "DELETE FROM knowledge_entries WHERE id = ?", (entry_id,)
        )
        # 顺手清掉它的关联与向量，别留孤儿（星系里会画到不存在的节点）
        conn.execute(
            "DELETE FROM knowledge_relations WHERE source_id = ? OR target_id = ?",
            (entry_id, entry_id),
        )
        conn.execute("DELETE FROM knowledge_vectors WHERE entry_id = ?", (entry_id,))
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    # ── 关联 / 自动建边（0919 新增）──────────────────────────────────────
    #  与记忆库 core/memory/upsert.py::_auto_link 同一思路：先字面/标签，再语义。
    #  ★ 为什么字面比较**只用标题+摘要**：text_similarity 是 LCS（O(n·m)），
    #    知识库正文可能几万字，直接喂正文会当场卡住 —— 短文本才是它的适用场景。
    #  ★ 系统标签（AI 写入固定塞的那两个）**不参与**相关性判定，
    #    否则所有 AI 写入的条目会因为共享标签而全连成一张网。

    def add_relation(
        self,
        source_id: str,
        target_id: str,
        relation: str = "related",
        score: float = 0.0,
        origin: str = "auto",
    ) -> bool:
        """建一条关联。同一对（不分方向）+ 同一关系只留一条；返回是否**新建**。"""
        if not source_id or not target_id or source_id == target_id:
            return False
        conn = self._conn()
        row = conn.execute(
            """SELECT id FROM knowledge_relations
               WHERE relation = ?
                 AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))""",
            (relation, source_id, target_id, target_id, source_id),
        ).fetchone()
        if row:
            conn.close()
            return False
        conn.execute(
            """INSERT INTO knowledge_relations (id, source_id, target_id, relation, score, origin, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                f"kr_{__import__('uuid').uuid4().hex[:12]}",
                source_id, target_id, relation, float(score), origin, time.time(),
            ),
        )
        conn.commit()
        conn.close()
        return True

    def list_relations(self) -> list[dict]:
        """全部关联（星系画线用；条目数上千也才几千条，一次给前端够用）。"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT source_id, target_id, relation, score, origin FROM knowledge_relations"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # ── 向量（语义关联用；没装嵌入模型时整表为空）────────────────────────

    def save_vector(self, entry_id: str, vec: list[float]) -> bool:
        if not entry_id or not vec:
            return False
        import array as _array
        blob = _array.array("f", [float(x) for x in vec]).tobytes()
        conn = self._conn()
        conn.execute(
            """INSERT INTO knowledge_vectors (entry_id, dim, vec, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(entry_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at""",
            (entry_id, len(vec), blob, time.time()),
        )
        conn.commit()
        conn.close()
        return True

    def load_vectors(self) -> dict:
        """{entry_id: tuple[float, ...]}（一次全读，避免逐条开连接）"""
        import array as _array
        out: dict = {}
        conn = self._conn()
        rows = conn.execute("SELECT entry_id, dim, vec FROM knowledge_vectors").fetchall()
        conn.close()
        for r in rows:
            a = _array.array("f")
            a.frombytes(r["vec"])
            out[r["entry_id"]] = tuple(a)
        return out

    @staticmethod
    def _cosine(a: tuple, b: tuple) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = na = nb = 0.0
        for x, y in zip(a, b):
            dot += x * y
            na += x * x
            nb += y * y
        if na <= 0 or nb <= 0:
            return 0.0
        return dot / ((na ** 0.5) * (nb ** 0.5))

    # ── 小状态（一次性开关）──────────────────────────────────────────

    def get_meta(self, key: str, default: str = "") -> str:
        conn = self._conn()
        row = conn.execute("SELECT value FROM knowledge_meta WHERE key = ?", (key,)).fetchone()
        conn.close()
        return str(row["value"]) if row else default

    def set_meta(self, key: str, value: str) -> None:
        conn = self._conn()
        conn.execute(
            "INSERT INTO knowledge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
        conn.commit()
        conn.close()

    def backfill_relations(self, embed=None, limit: int = 150) -> int:
        """给**已有**条目补关联（升级/新装后第一次打开知识库时跑一次）。

        写入侧（auto_link）只解决"以后"；库里已经有条目了，不补的话它们永远是一堆孤点。
        用 limit 兜住耗时：只补最近 limit 条。已存在的边会被 add_relation 自动跳过。
        返回新建边数。
        """
        try:
            rows = [e for e in self.list_all(limit=limit) if e.entry_type != "folder"]
        except Exception:
            return 0
        if len(rows) < 2:
            return 0
        made = 0
        for e in rows:
            try:
                r = self.auto_link(e, embed=embed)
                made += int(r.get("linked") or 0)
            except Exception:
                continue
        return made

    def auto_link(self, entry: KnowledgeEntry, embed=None, max_links: int = _MAX_LINKS) -> dict:
        """新条目落库后自动建关联边。返回 {'linked': n, 'origin': 'auto'|'embed'|'mixed'}。

        embed: 可选的嵌入函数 `text -> list[float]`（装了 bge-small-zh 才有）。
               给了它就会额外做语义关联，并顺手给缺向量的候选**补向量**（每次最多 _BACKFILL_MAX 条，
               慢慢补齐，不在一次写入里卡太久）。
        """
        if not entry or not entry.id:
            return {"linked": 0, "origin": "auto"}
        conn = self._conn()
        rows = conn.execute(
            """SELECT id, title, summary, content, tags FROM knowledge_entries
               WHERE id != ? AND entry_type != 'folder'
               ORDER BY updated_at DESC LIMIT 400""",
            (entry.id,),
        ).fetchall()
        conn.close()
        if not rows:
            return {"linked": 0, "origin": "auto"}

        mine_tags = {str(t) for t in (entry.tags or [])} - _SYSTEM_TAGS
        mine_key = _link_text(entry.title, entry.summary, entry.content)

        linked = 0
        auto_linked = 0
        for r in rows:
            if linked >= max_links:
                break
            other_tags = set(_json_list(r["tags"])) - _SYSTEM_TAGS
            shared = mine_tags & other_tags
            other_key = _link_text(r["title"], r["summary"], r["content"])
            sim = text_similarity(mine_key, other_key)
            if shared or sim >= _TITLE_SIM_THRESHOLD:
                score = max(sim, 0.5 if shared else 0.0)
                if self.add_relation(entry.id, r["id"], "related", min(1.0, score), "auto"):
                    linked += 1
                    auto_linked += 1

        # 语义关联（字面做不到的："猪肉 / 大白菜 / 鱼腥草"都是食物）
        embed_linked = 0
        if embed is not None and linked < max_links:
            try:
                vecs = self.load_vectors()
                mine_vec = vecs.get(entry.id)
                if mine_vec is None:
                    raw = embed(_link_text(entry.title, entry.summary, entry.content, long=True))
                    if raw:
                        self.save_vector(entry.id, raw)
                        mine_vec = tuple(float(x) for x in raw)
                        vecs[entry.id] = mine_vec
                if mine_vec:
                    backfill = 0
                    for r in rows:
                        if linked >= max_links:
                            break
                        rid = r["id"]
                        rv = vecs.get(rid)
                        if rv is None:
                            if backfill >= _BACKFILL_MAX:
                                continue
                            backfill += 1
                            raw = embed(_link_text(r["title"], r["summary"], r["content"], long=True))
                            if not raw:
                                continue
                            self.save_vector(rid, raw)
                            rv = tuple(float(x) for x in raw)
                            vecs[rid] = rv
                        if self._cosine(mine_vec, rv) >= _EMBED_SIM_THRESHOLD:
                            if self.add_relation(entry.id, rid, "related", min(1.0, self._cosine(mine_vec, rv)), "embed"):
                                linked += 1
                                embed_linked += 1
            except Exception:
                pass  # 语义这条线失败不影响字面关联

        if auto_linked and embed_linked:
            origin = "mixed"
        elif embed_linked:
            origin = "embed"
        else:
            origin = "auto"
        return {"linked": linked, "origin": origin}

    def list_all(
        self,
        project_id: str = "",
        entry_type: str = "",
        tag: str = "",
        parent_id: str = "",
        limit: int = 100,
    ) -> list[KnowledgeEntry]:
        conditions = []
        params: list = []

        if project_id:
            conditions.append("project_id = ?")
            params.append(project_id)
        if entry_type:
            conditions.append("entry_type = ?")
            params.append(entry_type)
        if tag:
            conditions.append("tags LIKE ?")
            params.append(f'%"{tag}"%')
        if parent_id:
            conditions.append("parent_id = ?")
            params.append(parent_id)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        conn = self._conn()
        rows = conn.execute(
            f"SELECT * FROM knowledge_entries {where} ORDER BY updated_at DESC LIMIT ?",
            params + [limit],
        ).fetchall()
        conn.close()
        return [self._row_to_entry(row) for row in rows]

    def children_of(self, parent_id: str) -> list[KnowledgeEntry]:
        """某分类下的直接子节点（含子分类 folder）"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM knowledge_entries WHERE parent_id = ? ORDER BY updated_at DESC",
            (parent_id,),
        ).fetchall()
        conn.close()
        return [self._row_to_entry(row) for row in rows]

    def subtree_ids(self, entry_id: str) -> list[str]:
        """某节点（含分类）下所有条目 id（递归，不含自身）；用于级联删除"""
        out: list[str] = []
        visited: set[str] = set()

        def walk(pid: str) -> None:
            if pid in visited:
                return
            visited.add(pid)
            conn = self._conn()
            rows = conn.execute(
                "SELECT id, entry_type FROM knowledge_entries WHERE parent_id = ?",
                (pid,),
            ).fetchall()
            conn.close()
            for row in rows:
                out.append(row["id"])
                if row["entry_type"] == "folder":
                    walk(row["id"])

        walk(entry_id)
        return out

    def search(self, text: str, project_id: str = "", top_k: int = 5) -> list[dict]:
        if not text or not text.strip():
            return []

        conn = self._conn()
        conditions = []
        params: list = []

        if project_id:
            conditions.append("project_id = ?")
            params.append(project_id)

        where_prefix = f"{' AND '.join(conditions)} AND " if conditions else ""

        import re as _re
        has_chinese = bool(_re.search(r'[\u4e00-\u9fff]', text))

        if has_chinese:
            # 中文：拆关键词做 OR LIKE（含 2-gram），避免整句 LIKE 精确匹配漏检
            kws = _search_keywords(text) or [text.strip()]
            or_parts = " OR ".join("(title LIKE ? OR content LIKE ? OR tags LIKE ?)" for _ in kws)
            or_params: list = []
            for k in kws:
                p = f"%{k}%"
                or_params += [p, p, p]
            rows = conn.execute(
                f"""
                SELECT *, 1.0 as score
                FROM knowledge_entries
                WHERE {where_prefix} ({or_parts})
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                params + or_params + [top_k],
            ).fetchall()
        else:
            try:
                safe_text = _escape_fts(text)
                rows = conn.execute(
                    f"""
                    SELECT k.*, bm25(knowledge_fts) as score
                    FROM knowledge_fts f
                    JOIN knowledge_entries k ON k.rowid = f.rowid
                    WHERE {where_prefix} knowledge_fts MATCH ?
                    ORDER BY score
                    LIMIT ?
                    """,
                    params + [safe_text, top_k],
                ).fetchall()
            except Exception:
                pattern = f"%{text}%"
                rows = conn.execute(
                    f"""
                    SELECT *, 1.0 as score
                    FROM knowledge_entries
                    WHERE {where_prefix} (title LIKE ? OR content LIKE ?)
                    ORDER BY updated_at DESC
                    LIMIT ?
                    """,
                    params + [pattern, pattern, top_k],
                ).fetchall()

        conn.close()
        results = []
        for row in rows:
            entry = self._row_to_entry(row)
            results.append({
                "entry": entry.to_dict(),
                "score": -row["score"],
            })
        return results

    def export_data(self) -> dict:
        """导出全部知识条目（JSON，供备份/换机迁移）"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM knowledge_entries ORDER BY created_at",
        ).fetchall()
        conn.close()
        return {
            "version": "1.0",
            "exported_at": time.time(),
            "entries": [self._row_to_entry(row).to_dict() for row in rows],
        }

    def import_data(self, data: dict, overwrite: bool = False) -> dict:
        """导入知识条目（从导出文件恢复）；overwrite=True 时先清空"""
        result = {"imported": 0, "skipped": 0, "errors": []}
        entries = data.get("entries") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            result["errors"].append("缺少 entries 数组")
            return result

        if overwrite:
            conn = self._conn()
            conn.execute("DELETE FROM knowledge_entries")
            conn.commit()
            conn.close()

        existing = {e.id for e in self.list_all(limit=100000)}
        for raw in entries:
            if not isinstance(raw, dict) or not raw.get("id"):
                result["skipped"] += 1
                continue
            if raw["id"] in existing and not overwrite:
                result["skipped"] += 1
                continue
            try:
                self.add(KnowledgeEntry.from_dict(raw))
                existing.add(raw["id"])
                result["imported"] += 1
            except Exception as e:
                result["errors"].append(f"{raw.get('id')}: {e}")
        return result

    @staticmethod
    def _row_to_entry(row: sqlite3.Row) -> KnowledgeEntry:
        return KnowledgeEntry(
            id=row["id"],
            title=row["title"],
            content=row["content"],
            summary=row["summary"],
            entry_type=row["entry_type"],
            tags=json.loads(row["tags"]) if row["tags"] else [],
            project_id=row["project_id"],
            source_url=row["source_url"],
            source_label=row["source_label"],
            parent_id=row["parent_id"],
            attachments=json.loads(row["attachments"]) if row["attachments"] else [],
            version=row["version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
