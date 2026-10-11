"""
Checkpoint 检查点与回滚机制。

支持工作区快照创建、恢复、清理，与 Orchestrator 集成实现阶段模式。
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

# ── 阶段状态枚举 ──────────────────────────────────────

from enum import Enum


class StageStatus(str, Enum):
    """阶段执行状态。"""
    PENDING = "pending"
    WAITING_APPROVAL = "waiting_approval"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    ROLLED_BACK = "rolled_back"


# ── Checkpoint 数据模型 ───────────────────────────────

from dataclasses import dataclass, field


@dataclass
class Checkpoint:
    """工作区快照。"""
    checkpoint_id: str
    project_id: str
    node_id: str
    timestamp: datetime
    file_snapshots: dict = field(default_factory=dict)  # 原始路径 → 备份路径


# ── CheckpointManager ─────────────────────────────────

class CheckpointManager:
    """检查点管理器：创建、恢复、清理工作区快照。"""

    def __init__(self, backup_dir: str = ".nis_checkpoints") -> None:
        self._backup_dir = backup_dir
        os.makedirs(backup_dir, exist_ok=True)

    async def create(self, project_path: str, node_id: str) -> Checkpoint:
        """
        创建快照：备份项目目录下所有文件。
        
        Args:
            project_path: 项目工作区路径。
            node_id: 关联的 DAG 节点 ID。
        
        Returns:
            Checkpoint 对象。
        """
        checkpoint_id = f"ckpt_{uuid.uuid4().hex[:8]}"
        backup_subdir = os.path.join(self._backup_dir, checkpoint_id)
        os.makedirs(backup_subdir, exist_ok=True)

        file_snapshots: dict[str, str] = {}
        abs_project = os.path.abspath(project_path)

        if os.path.isdir(abs_project):
            for root, _dirs, files in os.walk(abs_project):
                for fname in files:
                    src = os.path.join(root, fname)
                    rel = os.path.relpath(src, abs_project)
                    dst = os.path.join(backup_subdir, rel)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
                    file_snapshots[src] = dst

        return Checkpoint(
            checkpoint_id=checkpoint_id,
            project_id=abs_project,
            node_id=node_id,
            timestamp=datetime.now(),
            file_snapshots=file_snapshots,
        )

    async def restore(self, checkpoint: Checkpoint) -> bool:
        """
        恢复快照：从备份还原文件到原始路径。
        
        Args:
            checkpoint: 要恢复的 Checkpoint 对象。
        
        Returns:
            是否成功恢复至少一个文件。
        """
        restored = 0
        for src, dst in checkpoint.file_snapshots.items():
            if os.path.exists(dst):
                os.makedirs(os.path.dirname(src), exist_ok=True)
                shutil.copy2(dst, src)
                restored += 1
        return restored > 0

    async def cleanup(self, checkpoint: Checkpoint) -> None:
        """
        清理快照：删除备份目录。
        
        Args:
            checkpoint: 要清理的 Checkpoint 对象。
        """
        backup_subdir = os.path.join(self._backup_dir, checkpoint.checkpoint_id)
        if os.path.isdir(backup_subdir):
            shutil.rmtree(backup_subdir, ignore_errors=True)

    @property
    def size(self) -> int:
        """当前备份目录数量。"""
        return len([d for d in os.listdir(self._backup_dir)
                     if os.path.isdir(os.path.join(self._backup_dir, d))])
