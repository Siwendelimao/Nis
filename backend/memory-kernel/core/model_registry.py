"""
ModelRegistry — 模型注册。

预置主流模型价格配置，支持用户自定义添加。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from core.cost_calculator import ModelPricing


@dataclass
class CustomModel:
    """用户自定义模型。"""
    model_id: str
    name: str
    input_price: float
    output_price: float
    cache_mode: str = "price"
    cache_hit_price: float = 0.0
    cache_write_multiplier: float = 0.0
    cache_hit_multiplier: float = 0.0
    max_context: int = 0
    capabilities: list[str] = field(default_factory=list)


class ModelRegistry:
    """模型注册（预置+自定义）。"""

    def __init__(self) -> None:
        self._models: dict[str, ModelPricing] = {}
        self._load_builtin_models()

    def _load_builtin_models(self) -> None:
        """加载预置模型价格。"""
        builtin = [
            ModelPricing(
                model_id="deepseek-chat",
                provider="deepseek",
                name="DeepSeek Chat",
                input_price=1.00,
                output_price=2.00,
                cache_hit_price=0.10,
                cache_mode="price",
                max_context=64000,
                capabilities=["text"],
            ),
            ModelPricing(
                model_id="deepseek-reasoner",
                provider="deepseek",
                name="DeepSeek Reasoner",
                input_price=4.00,
                output_price=16.00,
                cache_hit_price=1.00,
                cache_mode="price",
                max_context=64000,
                capabilities=["text", "reasoning"],
            ),
            ModelPricing(
                model_id="gpt-4o",
                provider="openai",
                name="GPT-4o",
                input_price=3.75,
                output_price=15.00,
                cache_write_multiplier=1.25,
                cache_hit_multiplier=0.10,
                cache_mode="multiplier",
                max_context=128000,
                capabilities=["text", "image"],
            ),
            ModelPricing(
                model_id="claude-3-5-sonnet",
                provider="anthropic",
                name="Claude 3.5 Sonnet",
                input_price=3.75,
                output_price=18.75,
                cache_write_multiplier=1.25,
                cache_hit_multiplier=0.10,
                cache_mode="multiplier",
                max_context=200000,
                capabilities=["text", "image", "reasoning"],
            ),
            ModelPricing(
                model_id="gemini-2.0-flash",
                provider="google",
                name="Gemini 2.0 Flash",
                input_price=1.50,
                output_price=6.00,
                cache_mode="none",
                max_context=1000000,
                capabilities=["text", "image"],
            ),
        ]
        for m in builtin:
            self._models[f"{m.provider}:{m.model_id}"] = m

    def register(self, model: ModelPricing) -> None:
        key = f"{model.provider}:{model.model_id}"
        self._models[key] = model

    def get(self, provider: str, model_id: str) -> Optional[ModelPricing]:
        return self._models.get(f"{provider}:{model_id}")

    def list_models(self, provider: str | None = None) -> list[ModelPricing]:
        if provider:
            return [m for m in self._models.values() if m.provider == provider]
        return list(self._models.values())

    def register_from_custom(self, custom: CustomModel, provider_name: str) -> ModelPricing:
        """将 CustomModel 转换为 ModelPricing 并注册。"""
        pricing = ModelPricing(
            model_id=custom.model_id,
            provider=provider_name,
            name=custom.name,
            input_price=custom.input_price,
            output_price=custom.output_price,
            cache_mode=custom.cache_mode,
            cache_hit_price=custom.cache_hit_price,
            cache_write_multiplier=custom.cache_write_multiplier,
            cache_hit_multiplier=custom.cache_hit_multiplier,
            max_context=custom.max_context,
            capabilities=custom.capabilities,
        )
        self.register(pricing)
        return pricing
