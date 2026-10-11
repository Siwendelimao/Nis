from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from core.knowledge.models import KnowledgeEntry


def parse_markdown_file(filepath: str) -> Optional[KnowledgeEntry]:
    path = Path(filepath)
    if not path.exists():
        return None

    content = path.read_text(encoding="utf-8")
    title = _extract_title(content) or path.stem
    tags = _extract_tags(content)
    entry_type = _detect_type(content, path.suffix)

    return KnowledgeEntry(
        title=title,
        content=content,
        entry_type=entry_type,
        tags=tags,
    )


def parse_markdown_text(text: str, title: str = "") -> KnowledgeEntry:
    if not title:
        title = _extract_title(text) or "未命名文档"
    tags = _extract_tags(text)
    entry_type = _detect_type(text, "")

    return KnowledgeEntry(
        title=title,
        content=text,
        entry_type=entry_type,
        tags=tags,
    )


def import_markdown_dir(dir_path: str, project_id: str = "") -> list[KnowledgeEntry]:
    entries = []
    dir_path = Path(dir_path)
    if not dir_path.is_dir():
        return entries

    for md_file in dir_path.glob("**/*.md"):
        entry = parse_markdown_file(str(md_file))
        if entry:
            entry.project_id = project_id
            entries.append(entry)

    return entries


def _extract_title(content: str) -> str:
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _extract_tags(content: str) -> list[str]:
    tags = []
    for line in content.split("\n"):
        line = line.strip()
        if line.lower().startswith("tags:"):
            raw = line[5:].strip()
            tags = [t.strip() for t in raw.split(",") if t.strip()]
            break
        elif line.lower().startswith("标签:"):
            raw = line[3:].strip()
            tags = [t.strip() for t in raw.split(",") if t.strip()]
            break
    return tags


def _detect_type(content: str, suffix: str) -> str:
    lower = content.lower()
    if "api" in lower and ("endpoint" in lower or "接口" in lower):
        return "api_doc"
    if "faq" in lower or "常见问题" in lower:
        return "faq"
    if "规范" in lower or "standard" in lower:
        return "standard"
    if "tutorial" in lower or "教程" in lower:
        return "tutorial"
    return "doc"
