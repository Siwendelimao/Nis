from __future__ import annotations

import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class Snapshot:
    files: dict[str, str] = field(default_factory=dict)
    conversation: list[dict] = field(default_factory=list)
    task_state: Optional[dict] = None
    memory_snapshot: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)


@dataclass
class Anchor:
    anchor_id: str
    project_id: str
    title: str
    created_at: float
    bubble_id: str
    git_commit: str
    snapshot_path: str
    file_count: int = 0
    conversation_length: int = 0


class AnchorSnapshot:
    def __init__(self, snapshot_base_dir: str) -> None:
        self._base_dir = snapshot_base_dir
        os.makedirs(snapshot_base_dir, exist_ok=True)

    def create_snapshot_dir(self, anchor_id: str) -> str:
        path = os.path.join(self._base_dir, anchor_id)
        os.makedirs(path, exist_ok=True)
        return path

    def save_files(self, snapshot_path: str, project_path: str) -> dict[str, str]:
        files = {}
        if not os.path.isdir(project_path):
            return files
        files_dir = os.path.join(snapshot_path, "files")
        os.makedirs(files_dir, exist_ok=True)
        for root, _dirs, fnames in os.walk(project_path):
            for fname in fnames:
                if fname.startswith(".nis_"):
                    continue
                src = os.path.join(root, fname)
                rel = os.path.relpath(src, project_path)
                dst = os.path.join(files_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                files[rel] = dst
        return files

    def load_files(self, snapshot_path: str) -> dict[str, str]:
        files = {}
        files_dir = os.path.join(snapshot_path, "files")
        if not os.path.isdir(files_dir):
            return files
        for root, _dirs, fnames in os.walk(files_dir):
            for fname in fnames:
                src = os.path.join(root, fname)
                rel = os.path.relpath(src, files_dir)
                files[rel] = src
        return files

    def save_conversation(self, snapshot_path: str, conversation: list[dict]) -> None:
        path = os.path.join(snapshot_path, "conversation.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(conversation, f, ensure_ascii=False, indent=2)

    def load_conversation(self, snapshot_path: str) -> list[dict]:
        path = os.path.join(snapshot_path, "conversation.json")
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_task_state(self, snapshot_path: str, task_state: Optional[dict]) -> None:
        path = os.path.join(snapshot_path, "task_state.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(task_state, f, ensure_ascii=False, indent=2)

    def load_task_state(self, snapshot_path: str) -> Optional[dict]:
        path = os.path.join(snapshot_path, "task_state.json")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_memory(self, snapshot_path: str, memory: dict) -> None:
        path = os.path.join(snapshot_path, "memory_state.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(memory, f, ensure_ascii=False, indent=2)

    def load_memory(self, snapshot_path: str) -> dict:
        path = os.path.join(snapshot_path, "memory_state.json")
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def restore_files(self, snapshot_path: str, target_path: str) -> int:
        files = self.load_files(snapshot_path)
        restored = 0
        for rel, src in files.items():
            dst = os.path.join(target_path, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            restored += 1
        return restored

    def cleanup(self, snapshot_path: str) -> None:
        if os.path.isdir(snapshot_path):
            shutil.rmtree(snapshot_path, ignore_errors=True)
