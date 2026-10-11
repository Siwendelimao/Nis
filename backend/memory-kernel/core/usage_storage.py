"""
UsageStorage — 用量存储（SQLite）。

记录每次 API 调用的完整用量和费用数据。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ApiCallRecord:
    """一次 API 调用的完整记录。"""
    call_id: str
    timestamp: float
    project_id: str
    window_id: str
    model_id: str
    provider: str
    partner_name: str

    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    cache_write_tokens: int = 0

    cache_hit_cost: float = 0.0
    cache_miss_cost: float = 0.0
    output_cost: float = 0.0
    total_cost: float = 0.0

    context_used: int = 0
    context_max: int = 0

    request_hash: str = ""
    response_time_ms: int = 0


@dataclass
class WindowStats:
    """窗口级别统计。"""
    total_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    total_cost: float = 0.0
    context_used: int = 0
    context_max: int = 0


@dataclass
class ProjectStats:
    """项目级别统计。"""
    total_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    total_cost: float = 0.0
    window_count: int = 0


@dataclass
class GlobalStats:
    """全局级别统计。"""
    total_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    total_cost: float = 0.0
    project_count: int = 0
    by_model: list[dict] = field(default_factory=list)
    by_project: list[dict] = field(default_factory=list)


class UsageStorage:
    """用量存储（SQLite）。"""

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._db = sqlite3.connect(db_path)
        self._create_table()

    def _create_table(self) -> None:
        self._db.execute("""
            CREATE TABLE IF NOT EXISTS api_calls (
                call_id TEXT PRIMARY KEY,
                timestamp REAL,
                project_id TEXT,
                window_id TEXT,
                model_id TEXT,
                provider TEXT,
                partner_name TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                cache_hit_tokens INTEGER,
                cache_miss_tokens INTEGER,
                cache_write_tokens INTEGER,
                cache_hit_cost REAL,
                cache_miss_cost REAL,
                output_cost REAL,
                total_cost REAL,
                context_used INTEGER,
                context_max INTEGER,
                request_hash TEXT,
                response_time_ms INTEGER
            )
        """)
        self._db.commit()

    def record(self, record: ApiCallRecord) -> None:
        """记录一次调用。"""
        self._db.execute("""
            INSERT OR REPLACE INTO api_calls (
                call_id, timestamp, project_id, window_id, model_id, provider,
                partner_name, prompt_tokens, completion_tokens, cache_hit_tokens,
                cache_miss_tokens, cache_write_tokens, cache_hit_cost, cache_miss_cost,
                output_cost, total_cost, context_used, context_max, request_hash,
                response_time_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            record.call_id, record.timestamp, record.project_id, record.window_id,
            record.model_id, record.provider, record.partner_name,
            record.prompt_tokens, record.completion_tokens, record.cache_hit_tokens,
            record.cache_miss_tokens, record.cache_write_tokens,
            record.cache_hit_cost, record.cache_miss_cost,
            record.output_cost, record.total_cost,
            record.context_used, record.context_max,
            record.request_hash, record.response_time_ms,
        ))
        self._db.commit()

    def get_window_stats(self, window_id: str) -> WindowStats:
        """获取当前窗口统计。"""
        cur = self._db.execute("""
            SELECT
                COUNT(*),
                COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(cache_hit_tokens), 0),
                COALESCE(SUM(total_cost), 0.0),
                COALESCE(MAX(context_used), 0),
                COALESCE(MAX(context_max), 0)
            FROM api_calls WHERE window_id = ?
        """, (window_id,))
        row = cur.fetchone()
        return WindowStats(
            total_calls=row[0],
            prompt_tokens=row[1],
            completion_tokens=row[2],
            cache_hit_tokens=row[3],
            total_cost=row[4],
            context_used=row[5],
            context_max=row[6],
        )

    def get_project_stats(self, project_id: str) -> ProjectStats:
        """获取项目统计。"""
        cur = self._db.execute("""
            SELECT
                COUNT(*),
                COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(cache_hit_tokens), 0),
                COALESCE(SUM(total_cost), 0.0),
                COUNT(DISTINCT window_id)
            FROM api_calls WHERE project_id = ?
        """, (project_id,))
        row = cur.fetchone()
        return ProjectStats(
            total_calls=row[0],
            prompt_tokens=row[1],
            completion_tokens=row[2],
            cache_hit_tokens=row[3],
            total_cost=row[4],
            window_count=row[5],
        )

    def get_global_stats(self, period: str = "all") -> GlobalStats:
        """获取全局统计。"""
        where_clause = ""
        params: tuple = ()

        if period == "day":
            import time
            cutoff = time.time() - 86400
            where_clause = "WHERE timestamp > ?"
            params = (cutoff,)
        elif period == "week":
            import time
            cutoff = time.time() - 604800
            where_clause = "WHERE timestamp > ?"
            params = (cutoff,)
        elif period == "month":
            import time
            cutoff = time.time() - 2592000
            where_clause = "WHERE timestamp > ?"
            params = (cutoff,)

        cur = self._db.execute(f"""
            SELECT
                COUNT(*),
                COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(cache_hit_tokens), 0),
                COALESCE(SUM(total_cost), 0.0),
                COUNT(DISTINCT project_id)
            FROM api_calls {where_clause}
        """, params)
        row = cur.fetchone()

        cur2 = self._db.execute(f"""
            SELECT model_id,
                   MAX(provider),
                   COUNT(*),
                   COALESCE(SUM(prompt_tokens + completion_tokens), 0),
                   COALESCE(SUM(total_cost), 0.0),
                   COALESCE(SUM(prompt_tokens), 0),
                   COALESCE(SUM(cache_hit_tokens), 0)
            FROM api_calls {where_clause}
            GROUP BY model_id ORDER BY 5 DESC
        """, params)
        by_model = [
            {"name": r[0], "provider": r[1], "calls": r[2], "tokens": r[3], "cost": r[4],
             "prompt_tokens": r[5], "cache_hit_tokens": r[6]}
            for r in cur2.fetchall()
        ]

        cur3 = self._db.execute(f"""
            SELECT project_id, SUM(total_cost) as cost
            FROM api_calls {where_clause}
            GROUP BY project_id ORDER BY cost DESC
        """, params)
        by_project = [{"name": r[0], "cost": r[1]} for r in cur3.fetchall()]

        return GlobalStats(
            total_calls=row[0],
            prompt_tokens=row[1],
            completion_tokens=row[2],
            cache_hit_tokens=row[3],
            total_cost=row[4],
            project_count=row[5],
            by_model=by_model,
            by_project=by_project,
        )

    def reset_stats(self, scope: str, target_id: str | None = None) -> None:
        """重置统计。"""
        if scope == "window":
            self._db.execute("DELETE FROM api_calls WHERE window_id = ?", (target_id,))
        elif scope == "project":
            self._db.execute("DELETE FROM api_calls WHERE project_id = ?", (target_id,))
        elif scope == "all":
            self._db.execute("DELETE FROM api_calls")
        self._db.commit()

    def get_hourly_trend(self, hours: int = 24) -> list[dict]:
        """获取按小时聚合的 Token 消耗趋势。"""
        import time
        cutoff = time.time() - hours * 3600
        cur = self._db.execute("""
            SELECT
                strftime('%H', timestamp, 'unixepoch', 'localtime') as hour,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
                COALESCE(SUM(total_cost), 0.0) as cost,
                COUNT(*) as calls
            FROM api_calls
            WHERE timestamp > ?
            GROUP BY hour
            ORDER BY hour ASC
        """, (cutoff,))
        return [
            {"hour": r[0], "tokens": r[1], "cost": r[2], "calls": r[3]}
            for r in cur.fetchall()
        ]

    def close(self) -> None:
        """关闭数据库连接。"""
        self._db.close()
