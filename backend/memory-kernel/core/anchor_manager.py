from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from core.project_git import ProjectGit, GitNotAvailableError, check_git_availability
from core.anchor_snapshot import AnchorSnapshot, Anchor

logger = logging.getLogger(__name__)


class AnchorNotFoundError(Exception):
    pass


class RollbackError(Exception):
    pass


class GitUnavailableError(Exception):
    pass


@dataclass
class RollbackResult:
    success: bool
    anchor: Anchor
    restored_files: int = 0
    restored_messages: int = 0
    error: Optional[str] = None


class AnchorManager:
    def __init__(self, project_path: str) -> None:
        self.project_path = os.path.abspath(project_path)
        self.anchor_dir = os.path.join(project_path, ".nis_anchors")
        os.makedirs(self.anchor_dir, exist_ok=True)

        if not check_git_availability():
            logger.warning("Git 不可用，锚点功能将受限")
            self.git = None
        else:
            try:
                self.git = ProjectGit(project_path)
            except GitNotAvailableError:
                logger.warning("Git 初始化失败，锚点功能将受限")
                self.git = None

        self.snapshot = AnchorSnapshot(self.anchor_dir)
        self._anchors: dict[str, Anchor] = {}
        self._load_index()

    def _load_index(self) -> None:
        index_path = os.path.join(self.anchor_dir, "anchors.json")
        if os.path.exists(index_path):
            import json
            try:
                with open(index_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for item in data:
                    self._anchors[item["anchor_id"]] = Anchor(**item)
            except (json.JSONDecodeError, TypeError):
                pass

    def _save_index(self) -> None:
        import json
        index_path = os.path.join(self.anchor_dir, "anchors.json")
        data = [
            {
                "anchor_id": a.anchor_id,
                "project_id": a.project_id,
                "title": a.title,
                "created_at": a.created_at,
                "bubble_id": a.bubble_id,
                "git_commit": a.git_commit,
                "snapshot_path": a.snapshot_path,
                "file_count": a.file_count,
                "conversation_length": a.conversation_length,
            }
            for a in self._anchors.values()
        ]
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def list_anchors(self) -> list[Anchor]:
        return list(self._anchors.values())

    def get_anchor(self, anchor_id: str) -> Optional[Anchor]:
        return self._anchors.get(anchor_id)

    def create_anchor(
        self,
        title: str,
        bubble_id: str,
        conversation: list[dict] | None = None,
        task_state: Any = None,
    ) -> Anchor:
        anchor_id = f"anchor_{uuid.uuid4().hex[:6]}"
        snapshot_path = self.snapshot.create_snapshot_dir(anchor_id)

        git_commit = ""
        if self.git:
            git_commit = self.git.snapshot()

        files = self.snapshot.save_files(snapshot_path, self.project_path)
        self.snapshot.save_conversation(snapshot_path, conversation or [])
        self.snapshot.save_task_state(snapshot_path, task_state.__dict__ if task_state and hasattr(task_state, '__dict__') else task_state)
        self.snapshot.save_memory(snapshot_path, {})

        anchor = Anchor(
            anchor_id=anchor_id,
            project_id=self.project_path,
            title=title,
            created_at=time.time(),
            bubble_id=bubble_id,
            git_commit=git_commit,
            snapshot_path=snapshot_path,
            file_count=len(files),
            conversation_length=len(conversation or []),
        )
        self._anchors[anchor_id] = anchor
        self._save_index()
        return anchor

    async def rollback(self, anchor_id: str) -> RollbackResult:
        anchor = self._anchors.get(anchor_id)
        if not anchor:
            raise AnchorNotFoundError(f"锚点 {anchor_id} 不存在")

        if not self.git:
            raise GitUnavailableError("Git 不可用，无法执行回滚")

        safety_anchor = await self._create_safety_anchor(anchor)

        try:
            self.git.restore(anchor.git_commit)
            restored_files = self.snapshot.restore_files(anchor.snapshot_path, self.project_path)
            conversation = self.snapshot.load_conversation(anchor.snapshot_path)

            await self.delete_anchor(safety_anchor.anchor_id)

            return RollbackResult(
                success=True,
                anchor=anchor,
                restored_files=restored_files,
                restored_messages=len(conversation),
            )
        except Exception as e:
            logger.error("回滚失败，恢复到安全锚点: %s", e)
            try:
                self.git.restore(safety_anchor.git_commit)
                await self.delete_anchor(safety_anchor.anchor_id)
            except Exception as recovery_error:
                logger.critical("安全锚点恢复也失败: %s", recovery_error)
            raise RollbackError(f"回滚失败并已恢复: {e}")

    async def _create_safety_anchor(self, target_anchor: Anchor) -> Anchor:
        current_conversation = []
        current_task = None
        try:
            current_conversation = self.snapshot.load_conversation(target_anchor.snapshot_path)
        except Exception:
            pass

        return self.create_anchor(
            title=f"[安全备份] 回滚到 {target_anchor.title}",
            bubble_id=target_anchor.bubble_id,
            conversation=current_conversation,
            task_state=current_task,
        )

    async def delete_anchor(self, anchor_id: str) -> bool:
        anchor = self._anchors.get(anchor_id)
        if not anchor:
            return False
        self.snapshot.cleanup(anchor.snapshot_path)
        del self._anchors[anchor_id]
        self._save_index()
        return True

    def get_bubble_id(self, anchor_id: str) -> Optional[str]:
        anchor = self._anchors.get(anchor_id)
        return anchor.bubble_id if anchor else None
