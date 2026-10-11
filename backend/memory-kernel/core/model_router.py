"""
MultiModelRouter — 多模型路由器。

支持 4 档推理级别：
- fast (轻度): gpt-4o-mini, 快速简单任务
- deep (中度): claude-sonnet, 日常任务
- heavy (重度): claude-sonnet, 深度推理 + 多轮自查
- burning (烧脑): claude-sonnet, 拉满参数 + 多轮验证

每档独立控制: 模型、温度、Token上限、推理轮数、超时时间。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional


class ThinkingMode(str, Enum):
    """推理级别枚举。"""
    FAST = "fast"          # 轻度
    DEEP = "deep"          # 中度
    HEAVY = "heavy"        # 重度
    BURNING = "burning"    # 烧脑


class ReasoningConfig:
    """单档推理配置。"""

    def __init__(
        self,
        model: str,
        temperature: float,
        max_tokens: int,
        top_p: float,
        rounds: int,
        timeout: int,
    ):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.rounds = rounds
        self.timeout = timeout

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "top_p": self.top_p,
            "rounds": self.rounds,
            "timeout": self.timeout,
        }


class ModelRouter:
    """多模型路由器。"""

    # 4 档推理配置
    REASONING_CONFIG: Dict[ThinkingMode, ReasoningConfig] = {
        ThinkingMode.FAST: ReasoningConfig(
            model="gpt-4o-mini",
            temperature=0.3,
            max_tokens=2048,
            top_p=0.9,
            rounds=1,
            timeout=15,
        ),
        ThinkingMode.DEEP: ReasoningConfig(
            model="claude-sonnet-4-20250514",
            temperature=0.5,
            max_tokens=4096,
            top_p=0.95,
            rounds=1,
            timeout=30,
        ),
        ThinkingMode.HEAVY: ReasoningConfig(
            model="claude-sonnet-4-20250514",
            temperature=0.7,
            max_tokens=8192,
            top_p=0.95,
            rounds=2,
            timeout=60,
        ),
        ThinkingMode.BURNING: ReasoningConfig(
            model="claude-sonnet-4-20250514",
            temperature=0.9,
            max_tokens=16384,
            top_p=0.99,
            rounds=3,
            timeout=120,
        ),
    }

    # 前端档位 → 模式映射
    LEVEL_TO_MODE: Dict[str, ThinkingMode] = {
        "fast": ThinkingMode.FAST,
        "deep": ThinkingMode.DEEP,
        "heavy": ThinkingMode.HEAVY,
        "burning": ThinkingMode.BURNING,
        "light": ThinkingMode.FAST,
        "medium": ThinkingMode.DEEP,
        "high": ThinkingMode.HEAVY,
        "brain-burning": ThinkingMode.BURNING,
    }

    @classmethod
    def get_config(cls, mode: ThinkingMode) -> ReasoningConfig:
        """获取推理配置。"""
        return cls.REASONING_CONFIG.get(mode, cls.REASONING_CONFIG[ThinkingMode.DEEP])

    @classmethod
    def get_config_by_level(cls, level: str) -> ReasoningConfig:
        """通过前端档位字符串获取配置。"""
        mode = cls.LEVEL_TO_MODE.get(level, ThinkingMode.DEEP)
        return cls.get_config(mode)

    async def select_model(self, mode: ThinkingMode) -> str:
        """根据推理级别选择模型。"""
        config = self.get_config(mode)
        return config.model

    async def route(
        self,
        messages: List[Dict[str, str]],
        mode: ThinkingMode,
        **kwargs: Any,
    ) -> str:
        """路由到对应模型执行。"""
        config = self.get_config(mode)
        return (
            f"[{config.model}] temp={config.temperature} "
            f"tokens={config.max_tokens} rounds={config.rounds}"
        )

    async def auto_select(self, task_description: str) -> ThinkingMode:
        """根据任务描述自动选择推理级别。"""
        desc = task_description.lower()
        if any(kw in desc for kw in ["快速", "简单", "fast", "simple"]):
            return ThinkingMode.FAST
        if any(kw in desc for kw in ["分析", "规划", "研究", "架构", "analyze", "plan", "design"]):
            return ThinkingMode.HEAVY
        if any(kw in desc for kw in ["代码", "编程", "code", "programming"]):
            return ThinkingMode.DEEP
        return ThinkingMode.DEEP
