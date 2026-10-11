"""
Diff Editor — 精确/模糊 Patch 编辑能力。

集成路径：ToolGateway → GateKeeper → DiffEditor → 文件读写
"""

from __future__ import annotations

import difflib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class PatchResult:
    """Patch 应用结果。"""
    file: str
    success: bool
    mode: str
    replacements: int
    error: Optional[str] = None


class DiffEditor:
    """精确/模糊 Patch 编辑器。"""

    def __init__(self) -> None:
        pass

    async def execute(
        self,
        patches: list[dict],
        cwd: str = ".",
    ) -> list[PatchResult]:
        """
        应用一组 patch。

        Args:
            patches: patch 列表，每个 patch 格式：
                {
                    "file": "path/to/file.py",
                    "old_text": "原始文本",
                    "new_text": "替换文本",
                    "mode": "precise" | "fuzzy"
                }
            cwd: 工作目录。

        Returns:
            PatchResult 列表。
        """
        results = []
        for patch in patches:
            file_path = os.path.join(cwd, patch["file"])
            mode = patch.get("mode", "precise")
            try:
                content = Path(file_path).read_text(encoding="utf-8")
                if mode == "fuzzy":
                    new_content, count = self._apply_fuzzy(content, patch["old_text"], patch["new_text"])
                else:
                    new_content, count = self._apply_precise(content, patch["old_text"], patch["new_text"])
                if count > 0:
                    Path(file_path).write_text(new_content, encoding="utf-8")
                results.append(PatchResult(file=patch["file"], success=True, mode=mode, replacements=count))
            except Exception as e:
                results.append(PatchResult(file=patch["file"], success=False, mode=mode, replacements=0, error=str(e)))
        return results

    def _apply_precise(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """精确匹配替换。"""
        if old_text not in content:
            return content, 0
        result = content.replace(old_text, new_text, 1)
        return result, 1

    def _apply_fuzzy(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """模糊匹配替换（4 级递进）。"""
        strategies = [
            self._fuzzy_strip,
            self._fuzzy_line_ws,
            self._fuzzy_all_ws,
            self._fuzzy_sequence_match,
        ]
        for strategy in strategies:
            result, count = strategy(content, old_text, new_text)
            if count > 0:
                return result, count
        return content, 0

    def _fuzzy_strip(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """Level 1: 去除首尾空白后匹配。"""
        stripped = old_text.strip()
        if stripped not in content:
            return content, 0
        result = content.replace(stripped, new_text, 1)
        return result, 1

    def _fuzzy_line_ws(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """Level 2: 忽略行尾空白后匹配。"""
        old_lines = old_text.splitlines(True)
        content_lines = content.splitlines(True)
        stripped_old = [line.rstrip() + "\n" for line in old_lines]
        stripped_content = [line.rstrip() + "\n" for line in content_lines]
        joined_old = "".join(stripped_old)
        joined_content = "".join(stripped_content)
        if joined_old not in joined_content:
            return content, 0
        idx = joined_content.index(joined_old)
        # 在原始 content 中定位对应的行范围进行替换
        prefix = joined_content[:idx]
        prefix_lines = prefix.count("\n")
        old_line_count = joined_old.count("\n")
        before = "".join(content_lines[:prefix_lines])
        after = "".join(content_lines[prefix_lines + old_line_count:])
        result = before + new_text + after
        return result, 1

    def _fuzzy_all_ws(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """Level 3: 完全忽略空白（移除所有空白后匹配）。"""
        import re
        def remove_ws(s: str) -> str:
            return re.sub(r'\s+', '', s)
        bare_old = remove_ws(old_text)
        bare_content = remove_ws(content)
        if bare_old not in bare_content:
            return content, 0
        # 在 bare_content 中找到匹配位置，映射回原始 content
        bare_idx = bare_content.index(bare_old)
        # 将 bare 索引映射回原始 content 索引
        orig_start = None
        orig_end = None
        bare_pos = 0
        for i, ch in enumerate(content):
            if ch.isspace():
                continue
            if bare_pos == bare_idx and orig_start is None:
                orig_start = i
            if bare_pos == bare_idx + len(bare_old) - 1:
                orig_end = i + 1
                break
            bare_pos += 1
        if orig_start is None:
            return content, 0
        if orig_end is None:
            orig_end = len(content)
        result = content[:orig_start] + new_text + content[orig_end:]
        return result, 1

    def _fuzzy_sequence_match(self, content: str, old_text: str, new_text: str) -> tuple[str, int]:
        """Level 4: difflib SequenceMatcher 最佳块匹配。"""
        matcher = difflib.SequenceMatcher(None, content, old_text)
        match = matcher.find_longest_match(0, len(content), 0, len(old_text))
        if match.size < len(old_text) * 0.5:
            return content, 0
        result = content[:match.a] + new_text + content[match.a + match.size:]
        return result, 1
