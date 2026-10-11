"""
PermissionManager — 上层策略包装层（Phase 5）。

与 GateKeeper（Phase 1-4）的关系：
- PermissionManager 负责三档模式切换（CONFIRM/SELF_AUDIT/FULL_ACCESS）和目录级授权
- GateKeeper 负责工具级风险分级、HITL 用户确认、参数净化、审计记录
- 二者通过 main.py 装配：PermissionManager 作为上层策略，GateKeeper 作为工具级执行层
- 当 PermissionManager 模式为 CONFIRM 且无匹配授权时，委托给 GateKeeper 处理

装配链路（在 NisEngine.__init__ 中）：
    PolicyEngine → GateKeeper(policy, store, ws_bridge)
    ToolGateway(gate_keeper) → gateway.execute() → gate_keeper.secure_call()
    PermissionManager → 上层模式控制 + 目录级授权检查
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class PermissionMode(str, Enum):
    CONFIRM = "confirm"
    SELF_AUDIT = "self_audit"
    FULL_ACCESS = "full_access"


class PermissionScope(str, Enum):
    ONCE = "once"
    WINDOW = "window"
    PROJECT = "project"


@dataclass
class PermissionGrant:
    path: str
    access: str
    scope: str
    granted_at: float
    window_id: Optional[str] = None
    project_id: Optional[str] = None


@dataclass
class PermissionResult:
    allowed: bool
    needs_prompt: bool = False
    warn_only: bool = False


class PermissionManager:
    def __init__(self, gate_keeper: Any = None) -> None:
        self.grants: list[PermissionGrant] = []
        self.mode: PermissionMode = PermissionMode.CONFIRM
        self._gate_keeper = gate_keeper

    def check_permission(self, path: str, action: str) -> PermissionResult:
        if action == "read":
            return PermissionResult(allowed=True)

        if self.mode == PermissionMode.FULL_ACCESS:
            return PermissionResult(allowed=True)

        if self.mode == PermissionMode.SELF_AUDIT:
            return PermissionResult(allowed=True, warn_only=True)

        for grant in self.grants:
            if path.startswith(grant.path) and grant.access == action:
                return PermissionResult(allowed=True)

        if self._gate_keeper is not None:
            return PermissionResult(allowed=False, needs_prompt=True)

        return PermissionResult(allowed=False, needs_prompt=True)

    async def check_permission_async(self, path: str, action: str, tool_name: str = "", kwargs: dict = None) -> PermissionResult:
        result = self.check_permission(path, action)
        if result.allowed or not self._gate_keeper:
            return result
        try:
            await self._gate_keeper.secure_call(
                window_id="default",
                agent_id="permission_manager",
                tool_name=tool_name or action,
                execute_fn=lambda **kw: None,
                kwargs=kwargs or {},
            )
            return PermissionResult(allowed=True)
        except PermissionError:
            return PermissionResult(allowed=False, needs_prompt=True)
        except Exception:
            return PermissionResult(allowed=False, needs_prompt=True)

    def grant(self, path: str, scope: str, window_id: str = "default") -> PermissionGrant:
        grant = PermissionGrant(
            path=path,
            access="write",
            scope=scope,
            granted_at=time.time(),
            window_id=window_id if scope == "window" else None,
            project_id=window_id if scope == "project" else None,
        )
        self.grants.append(grant)

        if scope == "window":
            self.mode = PermissionMode.FULL_ACCESS

        return grant

    def set_mode(self, mode: PermissionMode) -> None:
        self.mode = mode
