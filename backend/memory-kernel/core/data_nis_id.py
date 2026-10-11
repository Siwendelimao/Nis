"""
DataNisIdGenerator — data-nis-id 注入器。

给 AI 生成的 HTML 元素注入唯一标识，用于前端圈选标注。
"""

from __future__ import annotations

import re
from typing import Optional


IMPORTANT_TAGS = frozenset([
    "button", "input", "a", "form", "img",
    "h1", "h2", "h3", "nav", "header", "footer",
    "section", "main", "aside", "select", "textarea",
    "label", "table", "video", "audio", "canvas",
])

# 与前端 RightPanel.injectNisIds 完全一致的叶子元素正则（预览页/标签内容/元素选择三方 id 必须同源）
_LEAF_TAGS_RE = re.compile(
    r"<(button|input|a|img|select|textarea|label|h1|h2|h3|h4|h5|h6|li|td|th|span|strong|em|code|blockquote|caption)\b([^>]*)>",
    re.IGNORECASE,
)


def inject_leaf_ids(html_code: str) -> str:
    """按前端同款规则给「叶子/小元素」注入 data-nis-id（nis-0, nis-1…，跳过已有）。

    预览页（本地 HTTP 服务）、WORKSPACE_FILE 内容、前端 currentFileContent() 必须用同一套，
    否则元素选择拿到的选择器在标签内容里找不到对应元素。
    """
    if not html_code:
        return html_code
    counter = 0

    def _rep(match):
        nonlocal counter
        attrs = match.group(2)
        if re.search(r"data-nis-id\s*=", attrs):
            return match.group(0)
        out = f"<{match.group(1)} data-nis-id=\"nis-{counter}\"{attrs}>"
        counter += 1
        return out

    return _LEAF_TAGS_RE.sub(_rep, html_code)


class DataNisIdGenerator:
    """给 AI 生成的 HTML 元素注入唯一标识。"""

    def inject_ids(self, html_code: str) -> str:
        """解析 HTML，给重要元素加 data-nis-id。

        优先使用 BeautifulSoup，不可用时回退到正则注入。
        """
        try:
            from bs4 import BeautifulSoup
            return self._inject_with_bs4(html_code, BeautifulSoup)
        except ImportError:
            return self._inject_with_regex(html_code)

    def _inject_with_bs4(self, html_code: str, BeautifulSoup) -> str:
        soup = BeautifulSoup(html_code, "html.parser")
        counter = 0

        for tag in soup.find_all(True):
            if self._is_important(tag):
                tag["data-nis-id"] = f"nis-{counter:04d}"
                counter += 1

        return str(soup)

    def _inject_with_regex(self, html_code: str) -> str:
        """正则回退方案：给开标签注入 data-nis-id。"""
        counter = 0
        pattern = re.compile(
            r"<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?>)", re.IGNORECASE
        )

        def replacer(match):
            nonlocal counter
            tag_name = match.group(1).lower()
            attrs = match.group(2)

            if "data-nis-id" in attrs:
                return match.group(0)

            is_important = tag_name in IMPORTANT_TAGS
            if not is_important:
                is_important = bool(
                    re.search(r'\bid\s*=', attrs)
                    or re.search(r'\bclass\s*=', attrs)
                    or re.search(r'\brole\s*=', attrs)
                )

            if not is_important:
                return match.group(0)

            nis_id = f"nis-{counter:04d}"
            counter += 1
            return f"<{tag_name} data-nis-id=\"{nis_id}\"{attrs}"

        return pattern.sub(replacer, html_code)

    def _is_important(self, tag) -> bool:
        """判断元素是否需要标注 ID。"""
        if tag.name in IMPORTANT_TAGS:
            return True
        if tag.get("id"):
            return True
        if tag.get("class"):
            return True
        if tag.get("role"):
            return True
        return False

    def extract_ids(self, html_code: str) -> list[str]:
        """从 HTML 中提取所有 data-nis-id 值。"""
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_code, "html.parser")
            return [tag["data-nis-id"] for tag in soup.find_all(attrs={"data-nis-id": True})]
        except ImportError:
            return re.findall(r'data-nis-id="(nis-\d{4})"', html_code)
