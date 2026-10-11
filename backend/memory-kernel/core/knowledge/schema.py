from __future__ import annotations

import sqlite3


_KNOWLEDGE_SQL = """
CREATE TABLE IF NOT EXISTS knowledge_entries (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    summary         TEXT NOT NULL DEFAULT '',
    entry_type      TEXT NOT NULL DEFAULT 'doc',
    tags             TEXT NOT NULL DEFAULT '[]',
    project_id      TEXT NOT NULL DEFAULT '',
    source_url      TEXT NOT NULL DEFAULT '',
    source_label    TEXT NOT NULL DEFAULT '',
    parent_id       TEXT NOT NULL DEFAULT '',
    attachments     TEXT NOT NULL DEFAULT '[]',
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_kb_type ON knowledge_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_kb_title ON knowledge_entries(title);

/* 条目之间的「关联」（0919 新增）：星系里的星桥就是它。
   以前前端是"同 tag 就画线"的演示逻辑（而 AI 写入的条目都带同两个系统 tag → 全连一起）。
   现在关系存库、由写入侧自动判定（字面/标签 + 可选语义），前端只负责画。 */
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    relation    TEXT NOT NULL DEFAULT 'related',   -- related / uses / similar / manual
    score       REAL NOT NULL DEFAULT 0,           -- 相关度 0~1（画线粗细/亮度用）
    origin      TEXT NOT NULL DEFAULT 'auto',      -- auto(字面/标签) / embed(语义) / manual
    created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_rel_source ON knowledge_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_kb_rel_target ON knowledge_relations(target_id);

/* 条目向量（0919）：有嵌入模型时写入，用于"语义关联"（字面不像但意思相关）。
   没装模型就整表为空，字面/标签那条路照旧工作。 */
CREATE TABLE IF NOT EXISTS knowledge_vectors (
    entry_id    TEXT PRIMARY KEY,
    dim         INTEGER NOT NULL,
    vec         BLOB NOT NULL,
    updated_at  REAL NOT NULL
);

/* 小状态表（0919）：例如"老条目补关联是否已跑过"这种一次性开关。 */
CREATE TABLE IF NOT EXISTS knowledge_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
"""

# 说明：关系的"同一对只留一条"在代码里做（store.add_relation 先查后插），
# 不用表达式唯一索引 —— SQLite 的表达式索引容易踩兼容坑，且方向（source→target）本身有意义。

_KNOWLEDGE_FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title,
    content,
    tags,
    content='knowledge_entries',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO knowledge_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;
"""


def init_knowledge_db(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(_KNOWLEDGE_SQL)
    conn.executescript(_KNOWLEDGE_FTS_SQL)
    _migrate_knowledge_table(conn)
    conn.commit()
    conn.close()


def _migrate_knowledge_table(conn: sqlite3.Connection) -> None:
    """迁移 knowledge_entries：新增 parent_id / attachments 列（树形分类 + 附件）"""
    existing = conn.execute("PRAGMA table_info(knowledge_entries)").fetchall()
    col_names = {row[1] for row in existing}
    if "parent_id" not in col_names:
        conn.execute("ALTER TABLE knowledge_entries ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''")
    if "attachments" not in col_names:
        conn.execute("ALTER TABLE knowledge_entries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
    if "summary" not in col_names:
        conn.execute("ALTER TABLE knowledge_entries ADD COLUMN summary TEXT NOT NULL DEFAULT ''")
    if "source_label" not in col_names:
        conn.execute("ALTER TABLE knowledge_entries ADD COLUMN source_label TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_kb_parent ON knowledge_entries(parent_id)")
