"""
Tool Gateway — 统一工具入口。

所有工具调用（MCP/Skills/电脑控制）必须经过 Gateway，无例外。
Gateway 负责：调用路由、权限校验、参数净化、结果格式化、审计记录。
"""

from __future__ import annotations

import os
import re
from typing import Any, Awaitable, Callable, Optional

from permission.gate_keeper import GateKeeper


def normalize_win_path(path: str) -> str:
    """把模型可能生成的 Unix 风格盘符路径（/e/foo）转成 Windows 盘符路径（E:/foo）。

    推理模型常把 E:\\foo 写成 /e/foo 或 /e/foo/bar，直接 os.path.abspath 会解析到错误位置。
    """
    if not path:
        return path
    m = re.match(r"^/([a-zA-Z])(/.*)?$", path)
    if m:
        return m.group(1).upper() + ":" + (m.group(2) or "/")
    return path


class ToolGateway:
    """统一工具入口：所有工具调用的唯一通道。"""

    def __init__(
        self,
        gate_keeper: GateKeeper,
        project_path: Optional[Any] = None,
    ) -> None:
        self._gate_keeper = gate_keeper
        self._tools: dict[str, Callable[..., Awaitable[Any]]] = {}
        # project_path 可为字符串（固定根）或可调用对象（动态取当前项目根，缺省 None）
        self._project_path = project_path

    def _current_project_path(self) -> Optional[str]:
        if self._project_path is None:
            return None
        if callable(self._project_path):
            v = self._project_path()
            return os.path.abspath(v) if v else None
        return os.path.abspath(self._project_path)

    def register_tool(self, name: str, executor: Callable[..., Awaitable[Any]]) -> None:
        """注册工具到 Gateway。"""
        self._tools[name] = executor

    async def execute(
        self,
        window_id: str,
        agent_id: str,
        tool_name: str,
        kwargs: dict,
        task_id: Optional[str] = None,
        on_card: Optional[Callable[[dict], Awaitable[None]]] = None,
        on_execute: Optional[Callable[[], Awaitable[None]]] = None,
        pre_authorized: Any = None,
        card_meta: Optional[dict] = None,
        executor_override: Optional[Callable[..., Awaitable[Any]]] = None,
    ) -> Any:
        """
        执行工具调用。
        
        流程：
        1. 查找已注册工具
        2. 参数净化（路径规范化）
        3. 调用 GateKeeper.secure_call
        4. 返回结果

        on_card：弹权限卡时回调；on_execute：真正开始执行时回调
        （先询问权限、授权后才开始工作）。
        pre_authorized：#13 预授权结果（检测到工具调用时已弹卡）——非 None 时跳过二次弹卡。
        card_meta：附加权限卡展示元数据（如 content_preview 内容预览），透传给 gate_keeper。
        executor_override：覆盖注册的 executor（两阶段写入时传入 commit 阶段执行器）。
        """
        if tool_name not in self._tools and executor_override is None:
            raise ValueError(f"未注册的工具: {tool_name}")

        executor = executor_override or self._tools[tool_name]
        clean_kwargs = self._normalize_kwargs(tool_name, kwargs)

        return await self._gate_keeper.secure_call(
            window_id=window_id,
            agent_id=agent_id,
            tool_name=tool_name,
            execute_fn=executor,
            kwargs=clean_kwargs,
            task_id=task_id,
            on_card=on_card,
            on_execute=on_execute,
            pre_authorized=pre_authorized,
            card_meta=card_meta,
        )

    def _normalize_kwargs(self, tool_name: str, kwargs: dict) -> dict:
        """根据工具类型净化参数。"""
        clean = dict(kwargs)
        if "path" in clean:
            clean["path"] = self._sanitize_path(clean["path"])
        if "save_path" in clean:
            clean["save_path"] = self._sanitize_path(clean["save_path"])
        return clean

    def _sanitize_path(self, path: str) -> str:
        """
        路径净化：
        - 先把模型可能生成的 Unix 风格盘符（/e/foo）转成 Windows 盘符（E:/foo）
        - 相对路径以项目根（如有）为基准解析，否则以当前工作目录为基准
        - 绝对路径原样返回（是否越界由具体工具自己判断：只读工具放行，写工具拦截）
        """
        path = normalize_win_path(path)
        root = self._current_project_path()
        if root and not os.path.isabs(path):
            return os.path.abspath(os.path.join(root, path))
        return os.path.abspath(path)

    @property
    def registered_tools(self) -> list[str]:
        """已注册工具列表。"""
        return list(self._tools.keys())
