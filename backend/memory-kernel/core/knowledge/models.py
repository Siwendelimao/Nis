from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class KnowledgeEntry:
    id: str = ""
    title: str = ""
    content: str = ""
    summary: str = ""
    entry_type: str = "doc"
    tags: list[str] = field(default_factory=list)
    project_id: str = ""
    source_url: str = ""
    source_label: str = ""
    parent_id: str = ""
    # 附件：[{id, type(image/video/doc/link), name, url}]，url 为 dataURL 或 http 链接
    attachments: list[dict] = field(default_factory=list)
    version: int = 1
    created_at: float = 0.0
    updated_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"kb_{uuid.uuid4().hex[:12]}"
        if not self.created_at:
            self.created_at = time.time()
        if not self.updated_at:
            self.updated_at = self.created_at

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "summary": self.summary,
            "entry_type": self.entry_type,
            "tags": self.tags,
            "project_id": self.project_id,
            "source_url": self.source_url,
            "source_label": self.source_label,
            "parent_id": self.parent_id,
            "attachments": self.attachments,
            "version": self.version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> KnowledgeEntry:
        return cls(
            id=data.get("id", ""),
            title=data.get("title", ""),
            content=data.get("content", ""),
            summary=data.get("summary", ""),
            entry_type=data.get("entry_type", "doc"),
            tags=data.get("tags", []),
            project_id=data.get("project_id", ""),
            source_url=data.get("source_url", ""),
            source_label=data.get("source_label", ""),
            parent_id=data.get("parent_id", ""),
            attachments=data.get("attachments", []),
            version=data.get("version", 1),
            created_at=data.get("created_at", 0.0),
            updated_at=data.get("updated_at", 0.0),
        )
