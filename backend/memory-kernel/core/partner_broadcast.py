"""伙伴任务追踪与 WebSocket 广播。

职责：
- 追踪每个伙伴的任务执行状态（开始/推理/进展/完成）。
- 将状态变化广播到 WebSocket，供前端渲染聊天气泡。
- 通过 WsBroadcaster 协议与上层解耦，可独立测试。

消息类型：
- PARTNER_TASK_START：伙伴开始执行任务
- PARTNER_REASONING：伙伴的推理过程
- PARTNER_WORK_PROGRESS：伙伴的工作进展
- PARTNER_TASK_COMPLETE：伙伴完成任务
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

WsBroadcaster = Callable[[dict], Awaitable[None]]

_AVATAR_MAP: dict[str, str] = {
    "VisualPainter (视觉生成专家)": "🎨",
    "Luna (代码编写大师)": "🌙",
    "Hermes (资深搜索伙伴)": "🔍",
    "GeneralAssistant": "🤖",
}


@dataclass
class PartnerTask:
    """伙伴任务信息。"""

    task_id: str
    partner_name: str
    description: str
    status: str = "PENDING"
    files_modified: list[str] = field(default_factory=list)

    @property
    def avatar(self) -> str:
        return _AVATAR_MAP.get(self.partner_name, "🤖")


class PartnerTaskTracker:
    """追踪伙伴执行状态并广播到 WebSocket。

    Args:
        ws_broadcaster: WebSocket 广播函数，签名 async def(msg: dict) -> None。
                       为 None 时广播静默跳过（零依赖模式）。
    """

    def __init__(
        self,
        ws_broadcaster: Optional[WsBroadcaster] = None,
    ) -> None:
        self._ws: Optional[WsBroadcaster] = ws_broadcaster
        self._active_tasks: dict[str, PartnerTask] = {}

    @property
    def active_task_count(self) -> int:
        return len(self._active_tasks)

    async def on_partner_start(
        self,
        partner_name: str,
        task: dict,
    ) -> None:
        """伙伴开始执行任务。

        Args:
            partner_name: 伙伴名称。
            task: 任务信息，至少包含 "id" 和 "description"。
        """
        task_id = task.get("id", f"task_{id(task)}")
        partner_task = PartnerTask(
            task_id=task_id,
            partner_name=partner_name,
            description=task.get("description", ""),
            status="RUNNING",
        )
        self._active_tasks[task_id] = partner_task

        await self._broadcast({
            "type": "PARTNER_TASK_START",
            "partner_name": partner_name,
            "partner_avatar": partner_task.avatar,
            "task_id": task_id,
            "description": task.get("description", ""),
        })

    async def on_partner_reasoning(
        self,
        partner_name: str,
        task_id: str,
        reasoning: str,
    ) -> None:
        """伙伴的推理过程。

        Args:
            partner_name: 伙伴名称。
            task_id: 任务 ID。
            reasoning: 推理内容文本。
        """
        await self._broadcast({
            "type": "PARTNER_REASONING",
            "partner_name": partner_name,
            "task_id": task_id,
            "content": reasoning,
        })

    async def on_partner_progress(
        self,
        partner_name: str,
        task_id: str,
        action: str,
        detail: Optional[dict] = None,
    ) -> None:
        """伙伴的工作进展。

        Args:
            partner_name: 伙伴名称。
            task_id: 任务 ID。
            action: 当前动作描述（如 "编辑文件"、"搜索资料"）。
            detail: 额外的详情字段（如 file、status、progress）。
        """
        msg: dict = {
            "type": "PARTNER_WORK_PROGRESS",
            "partner_name": partner_name,
            "task_id": task_id,
            "action": action,
        }
        if detail:
            msg.update(detail)
        await self._broadcast(msg)

    async def on_partner_complete(
        self,
        partner_name: str,
        task_id: str,
        result: str,
        files_modified: Optional[list[str]] = None,
    ) -> None:
        """伙伴完成任务。

        Args:
            partner_name: 伙伴名称。
            task_id: 任务 ID。
            result: 执行结果描述。
            files_modified: 修改的文件列表。
        """
        task = self._active_tasks.get(task_id)
        files = files_modified if files_modified is not None else (
            task.files_modified if task else []
        )

        await self._broadcast({
            "type": "PARTNER_TASK_COMPLETE",
            "partner_name": partner_name,
            "task_id": task_id,
            "result": result,
            "files_modified": files,
        })
        self._active_tasks.pop(task_id, None)

    async def _broadcast(self, message: dict) -> None:
        """广播消息到 WebSocket。

        如果未配置 broadcaster，则静默跳过。
        """
        if self._ws is None:
            return
        try:
            await self._ws(message)
        except Exception:
            logger.warning("PartnerTaskTracker 广播失败: %s", message.get("type"))
