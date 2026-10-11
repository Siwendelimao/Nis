"""
IntelligentRouter — 两级智能路由器。

第一级：SemanticRouter 正则快速路径（<1ms）
第二级：LLM 语义路由（处理歧义输入）

可解释性：每条路由结果含 reason 字段。
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from agents.semantic_router import RouteType, SemanticRouter

LlmCallable = Callable[[str], Awaitable[str]]

_EN_VERBS = ['make', 'create', 'build', 'write', 'fix', 'add', 'update',
             'delete', 'remove', 'implement', 'develop', 'design', 'deploy',
             'test', 'refactor', 'optimize', 'generate']
_EN_VERB_PATTERN = re.compile(
    r'\b(' + '|'.join(_EN_VERBS) + r')\b', re.IGNORECASE
)

_ZH_VERBS = {'创建', '修改', '删除', '更新', '实现', '开发', '设计',
             '编写', '生成', '构建', '部署', '测试', '修复', '优化', '重构'}


@dataclass
class RouteResult:
    """路由结果（可解释）。"""
    route_type: RouteType
    context: dict[str, Any]
    reason: str
    fast_path: bool
    confidence: float


@dataclass
class LlmRouteResult:
    """LLM 路由结果。"""
    route_type: RouteType
    context: dict[str, Any]
    reason: str
    confidence: float


class IntelligentRouter:
    """两级智能路由器。"""

    def __init__(
        self,
        semantic_router: SemanticRouter,
        llm_router: Optional[LlmRouter] = None,
        ambiguity_threshold: float = 0.6,
    ) -> None:
        self._fast = semantic_router
        self._llm = llm_router
        self._ambiguity_threshold = ambiguity_threshold

    async def route(self, user_input: str) -> RouteResult:
        """两级路由入口（异步，支持 LLM 降级）。"""
        route_type, context = self._fast.route(user_input)
        reason = self._build_fast_reason(route_type, context)
        confidence = 1.0

        if route_type == RouteType.SIMPLE_CHAT and self._is_ambiguous(user_input):
            if self._llm is not None:
                llm_result = await self._llm.classify(user_input)
                if llm_result.confidence >= self._ambiguity_threshold:
                    return RouteResult(
                        route_type=llm_result.route_type,
                        context=llm_result.context,
                        reason=llm_result.reason,
                        fast_path=False,
                        confidence=llm_result.confidence,
                    )
                else:
                    fallback_confidence = min(1.0, 0.5 + (1.0 - llm_result.confidence))
                    reason += f"（LLM 置信度 {llm_result.confidence:.2f} < {self._ambiguity_threshold}，回退 SIMPLE_CHAT）"
                    return RouteResult(
                        route_type=RouteType.SIMPLE_CHAT,
                        context=context,
                        reason=reason,
                        fast_path=False,
                        confidence=fallback_confidence,
                    )

        return RouteResult(
            route_type=route_type,
            context=context,
            reason=reason,
            fast_path=True,
            confidence=confidence,
        )

    def _build_fast_reason(self, route_type: RouteType, context: dict) -> str:
        """从快速路径结果构建可解释的路由原因。"""
        action = context.get('action', '')
        companion_id = context.get('companion_id', '')
        skill_name = context.get('skill_name', '')
        raw = context.get('raw', '')

        if route_type == RouteType.COMPANION_SWITCH:
            return f"检测到 @{companion_id} 语法"
        elif route_type == RouteType.NATIVE_MCP:
            return f"命中 MCP 动作关键词: {action}"
        elif route_type == RouteType.SKILL_DIRECT:
            return f"检测到 /skill 命令: {skill_name}"
        elif route_type == RouteType.MEMORY_QUERY:
            return "命中记忆检索关键词"
        elif route_type == RouteType.LLM_PLAN:
            if context.get('plan_mode', False):
                return "显式 /plan 命令"
            word_count = len(raw.split())
            return f"复杂任务（{word_count} 词 / 命中关键词）"
        else:
            return "无特殊模式命中，兜底对话"

    def _is_ambiguous(self, user_input: str) -> bool:
        """判断输入是否有歧义（需要 LLM 进一步分类）。"""
        words = user_input.split()
        if len(words) < 8 or len(words) > 25:
            return False

        if _EN_VERB_PATTERN.search(user_input):
            return True

        return any(verb in user_input for verb in _ZH_VERBS)


class LlmRouter:
    """LLM 语义路由器：处理歧义输入。"""

    _CLASSIFY_PROMPT = """你是一个路由分类器。根据用户输入，判断应该路由到哪个子系统。

路由类型：
- COMPANION_SWITCH: @伙伴名 的消息
- NATIVE_MCP: 截图/剪贴板/文件操作/系统通知
- SKILL_DIRECT: /skill 命令
- MEMORY_QUERY: 记忆检索（你还记得/上次/之前）
- LLM_PLAN: 复杂任务（需要多步骤规划）
- SIMPLE_CHAT: 简单闲聊/问答

只返回 JSON，不要输出其他内容：
{{"route": "路由类型", "reason": "一句话路由原因", "confidence": 0.0-1.0}}

用户输入：{user_input}"""

    _VALID_ROUTES = {e.name for e in RouteType}

    def __init__(self, model_router: LlmCallable) -> None:
        self._model = model_router

    async def classify(self, user_input: str) -> LlmRouteResult:
        """LLM 分类歧义输入。"""
        prompt = self._CLASSIFY_PROMPT.format(user_input=user_input)
        try:
            raw = await asyncio.wait_for(self._model(prompt), timeout=5.0)
            parsed = self._parse_json(raw)
            if parsed:
                route_type = self._parse_route_type(parsed.get("route", "SIMPLE_CHAT"))
                reason = parsed.get("reason", "LLM 分类")
                confidence = float(parsed.get("confidence", 0.5))
                return LlmRouteResult(
                    route_type=route_type,
                    context={"raw": user_input},
                    reason=f"[LLM] {reason}",
                    confidence=min(max(confidence, 0.0), 1.0),
                )
        except (asyncio.TimeoutError, Exception):
            pass
        return LlmRouteResult(
            route_type=RouteType.SIMPLE_CHAT,
            context={"raw": user_input},
            reason="[LLM] 超时/异常，回退 SIMPLE_CHAT",
            confidence=0.0,
        )

    @staticmethod
    def _parse_json(raw: str) -> Optional[dict]:
        """从 LLM 响应中提取 JSON 对象。"""
        if not raw:
            return None
        m = re.search(r"```json\s*(\{.*?\})\s*```", raw, re.DOTALL)
        if m:
            return LlmRouter._safe_loads(m.group(1))
        m = re.search(r"```\s*(\{.*?\})\s*```", raw, re.DOTALL)
        if m:
            return LlmRouter._safe_loads(m.group(1))
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            return LlmRouter._safe_loads(m.group(0))
        return LlmRouter._safe_loads(raw)

    @staticmethod
    def _safe_loads(text: str) -> Optional[dict]:
        """安全的 json.loads 包装。"""
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return None

    @staticmethod
    def _parse_route_type(route_str: str) -> RouteType:
        """解析路由类型字符串为 RouteType 枚举。"""
        if route_str in LlmRouter._VALID_ROUTES:
            return RouteType[route_str]
        return RouteType.SIMPLE_CHAT
