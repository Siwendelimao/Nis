"""
PreviewManager — 预览管理。

管理预览状态、代码历史、回退功能。
"""

from __future__ import annotations

from typing import Optional

from core.data_nis_id import DataNisIdGenerator


class PreviewManager:
    """管理预览状态。"""

    def __init__(self, project_id: str) -> None:
        self.project_id = project_id
        self._current_code: Optional[str] = None
        self._preview_history: list[str] = []
        self._id_generator = DataNisIdGenerator()

    def update_code(self, code: str, inject_ids: bool = True) -> str:
        """更新预览代码。"""
        if inject_ids:
            code = self._id_generator.inject_ids(code)

        self._current_code = code
        self._preview_history.append(code)

        return code

    def get_code(self) -> Optional[str]:
        return self._current_code

    def rollback(self, steps: int = 1) -> Optional[str]:
        """回退到历史版本。"""
        if steps <= 0:
            return self._current_code
        if len(self._preview_history) >= steps:
            self._preview_history = self._preview_history[:-steps]
            self._current_code = self._preview_history[-1] if self._preview_history else None
            return self._current_code
        return None

    @property
    def history_size(self) -> int:
        return len(self._preview_history)

    def clear_history(self) -> None:
        """清空历史。"""
        self._preview_history.clear()
        self._current_code = None
