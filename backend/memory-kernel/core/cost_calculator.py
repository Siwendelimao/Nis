"""
CostCalculator — 费用计算器。

支持三种缓存计费模式：
- price：DeepSeek / LongCat 模式（缓存命中单独定价）
- multiplier：Anthropic / OpenAI 模式（缓存有倍数）
- none：无缓存（如 Gemini 2.0）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from core.usage_parser import TokenUsage


@dataclass
class ModelPricing:
    """一个模型的计费配置。"""
    model_id: str
    provider: str
    name: str = ""
    logo_url: str = ""

    input_price: float = 0.0
    output_price: float = 0.0
    cache_hit_price: float = 0.0

    cache_write_multiplier: float = 0.0
    cache_hit_multiplier: float = 0.0

    capabilities: list[str] = field(default_factory=list)
    max_context: int = 0

    cache_mode: str = "price"


@dataclass
class CostBreakdown:
    """费用明细。"""
    cache_hit_cost: float = 0.0
    cache_miss_cost: float = 0.0
    output_cost: float = 0.0
    total_cost: float = 0.0


class CostCalculator:
    """费用计算器，支持不同厂商的计费规则。"""

    def calculate(self, pricing: ModelPricing, usage: TokenUsage) -> CostBreakdown:
        """计算一次调用的费用。"""
        if pricing.cache_mode == "price":
            return self._calc_price_mode(pricing, usage)
        elif pricing.cache_mode == "multiplier":
            return self._calc_multiplier_mode(pricing, usage)
        else:
            return self._calc_no_cache(pricing, usage)

    def _calc_price_mode(self, pricing: ModelPricing, usage: TokenUsage) -> CostBreakdown:
        """DeepSeek 模式：缓存命中单独定价。"""
        cache_hit_cost = (usage.cache_hit_tokens / 1_000_000) * pricing.cache_hit_price
        cache_miss_cost = (usage.cache_miss_tokens / 1_000_000) * pricing.input_price
        output_cost = (usage.completion_tokens / 1_000_000) * pricing.output_price

        return CostBreakdown(
            cache_hit_cost=cache_hit_cost,
            cache_miss_cost=cache_miss_cost,
            output_cost=output_cost,
            total_cost=cache_hit_cost + cache_miss_cost + output_cost,
        )

    def _calc_multiplier_mode(self, pricing: ModelPricing, usage: TokenUsage) -> CostBreakdown:
        """Anthropic 模式：缓存有倍数。"""
        base_input_cost = (usage.prompt_tokens / 1_000_000) * pricing.input_price
        cache_write_cost = (usage.cache_write_tokens / 1_000_000) * pricing.input_price * (pricing.cache_write_multiplier - 1)
        cache_hit_discount = (usage.cache_hit_tokens / 1_000_000) * pricing.input_price * (1 - pricing.cache_hit_multiplier)
        output_cost = (usage.completion_tokens / 1_000_000) * pricing.output_price

        return CostBreakdown(
            cache_hit_cost=cache_hit_discount,
            cache_miss_cost=base_input_cost + cache_write_cost,
            output_cost=output_cost,
            total_cost=base_input_cost + cache_write_cost - cache_hit_discount + output_cost,
        )

    def _calc_no_cache(self, pricing: ModelPricing, usage: TokenUsage) -> CostBreakdown:
        """无缓存模式（如 Gemini 2.0）。"""
        input_cost = (usage.prompt_tokens / 1_000_000) * pricing.input_price
        output_cost = (usage.completion_tokens / 1_000_000) * pricing.output_price

        return CostBreakdown(
            cache_hit_cost=0.0,
            cache_miss_cost=input_cost,
            output_cost=output_cost,
            total_cost=input_cost + output_cost,
        )
