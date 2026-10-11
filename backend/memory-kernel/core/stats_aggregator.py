"""
StatsAggregator — 统计汇总器。

从 UsageStorage 读取数据并聚合。
"""

from __future__ import annotations

from core.usage_storage import (
    GlobalStats,
    ProjectStats,
    UsageStorage,
    WindowStats,
)


class StatsAggregator:
    """统计汇总器（从 UsageStorage 读取数据并聚合）。"""

    def __init__(self, storage: UsageStorage) -> None:
        self._storage = storage

    async def get_window_stats(self, window_id: str) -> WindowStats:
        return self._storage.get_window_stats(window_id)

    async def get_project_stats(self, project_id: str) -> ProjectStats:
        return self._storage.get_project_stats(project_id)

    async def get_global_stats(self, period: str = "all") -> GlobalStats:
        return self._storage.get_global_stats(period)

    async def reset_stats(self, scope: str, target_id: str | None = None) -> None:
        self._storage.reset_stats(scope, target_id)
