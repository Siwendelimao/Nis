"""NIS Knowledge — 附件本地存储（图片/视频/文档存软件数据目录专属文件夹）

附件文件落在 {data_dir}/knowledge_attachments/{entry_id}/{uuid}.{ext}，
知识库条目 attachments[].url 存相对路径（相对附件根目录），
通过 resolve_url() 还原成绝对路径取文件。
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Optional

# 附件类型 → 文件扩展名白名单
ALLOWED_EXT: dict[str, set[str]] = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"},
    "video": {".mp4", ".webm", ".ogg", ".mov", ".mkv", ".m3u8"},
    "doc": {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".md", ".txt", ".zip"},
}

DEFAULT_EXT: dict[str, str] = {
    "image": ".png",
    "video": ".mp4",
    "doc": ".pdf",
}


class KnowledgeAttachmentStore:
    """知识库附件存储（基于本地文件系统）"""

    def __init__(self, data_dir: str) -> None:
        self._root = Path(data_dir) / "knowledge_attachments"
        self._root.mkdir(parents=True, exist_ok=True)

    def _rel_to_abs(self, rel_path: str) -> Path:
        """相对路径 → 绝对路径（防目录穿越）"""
        # 只允许根目录下的文件
        abs_path = (self._root / rel_path).resolve()
        if not str(abs_path).startswith(str(self._root.resolve())):
            raise ValueError(f"非法附件路径: {rel_path}")
        return abs_path

    @staticmethod
    def _ext_for(name: str, att_type: str) -> str:
        """根据文件名取扩展名；不在白名单则回落默认扩展名"""
        ext = Path(name).suffix.lower()
        allowed = ALLOWED_EXT.get(att_type, set())
        if allowed and ext not in allowed:
            ext = DEFAULT_EXT.get(att_type, "")
        return ext

    def save(self, entry_id: str, att_type: str, filename: str, data: bytes) -> str:
        """保存附件，返回相对路径（如 kb_xxx/att_ab12.png）"""
        if att_type not in ALLOWED_EXT:
            raise ValueError(f"不支持的附件类型: {att_type}")
        entry_dir = self._root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        ext = self._ext_for(filename, att_type)
        fname = f"att_{uuid.uuid4().hex[:12]}{ext}"
        path = entry_dir / fname
        path.write_bytes(data)
        # 统一正斜杠相对路径（跨平台存储）
        return str(Path(entry_id) / fname).replace("\\", "/")

    def load(self, rel_path: str) -> Optional[bytes]:
        """读取附件内容（相对路径）"""
        abs_path = self._rel_to_abs(rel_path)
        if abs_path.exists():
            return abs_path.read_bytes()
        return None

    def resolve_url(self, rel_path: str) -> str:
        """相对路径 → 文件绝对路径（前端经 WS 取内容用）"""
        return str(self._rel_to_abs(rel_path))

    def delete(self, rel_path: str) -> bool:
        """删除单个附件"""
        try:
            abs_path = self._rel_to_abs(rel_path)
        except ValueError:
            return False
        if abs_path.exists() and abs_path.is_file():
            abs_path.unlink()
            return True
        return False

    def delete_entry(self, entry_id: str) -> bool:
        """删除某条目全部附件（级联删除条目时调用）"""
        safe = str(entry_id or "").strip()
        # ★0927 netfix：entry_id 必须是纯名（防 '..' / 路径分隔符穿越导致 rmtree 越界删目录）
        if (not safe) or safe in (".", "..") or any(c in safe for c in ("/", "\\", "\x00")):
            return False
        entry_dir = (self._root / safe).resolve()
        root_resolved = self._root.resolve()
        if entry_dir != root_resolved and root_resolved not in entry_dir.parents:
            return False
        if entry_dir.exists():
            import shutil
            shutil.rmtree(entry_dir)
            return True
        return False

    def list(self, entry_id: str) -> list[str]:
        """某条目下的附件相对路径列表"""
        entry_dir = self._root / entry_id
        if not entry_dir.exists():
            return []
        return [str(p.relative_to(self._root)).replace("\\", "/") for p in entry_dir.iterdir() if p.is_file()]
