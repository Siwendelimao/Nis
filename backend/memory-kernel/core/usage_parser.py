"""
UsageParser — 用量解析器。

从 LiteLLM 返回的 ModelResponse 对象或 dict 中解析 token 用量。
兼容两种输入格式：
- dict：直接字段访问
- ModelResponse 对象：通过 model_dump() 转换为 dict 后访问
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class TokenUsage:
    """单次 API 调用的 token 用量。"""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    cache_write_tokens: int = 0


class UsageParser:
    """从 AI 返回数据中解析 token 用量（兼容 LiteLLM ModelResponse 对象）。"""

    @staticmethod
    def _safe_get(obj: Any, key: str, default: Any = None) -> Any:
        """兼容 dict 和 ModelResponse 对象的属性访问。"""
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    @staticmethod
    def parse(response: Any, provider: str = "") -> TokenUsage:
        """解析不同厂商的 usage 数据。

        Args:
            response: LiteLLM 返回的 ModelResponse 对象或 dict
            provider: 厂商名称
        """
        if hasattr(response, "model_dump"):
            response = response.model_dump()

        usage = UsageParser._safe_get(response, "usage", {}) or {}
        # usage/details/prompt_tokens_details 可能是 pydantic 对象（LiteLLM 包装类）→ 统一转 dict
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump()
        if not isinstance(usage, dict):
            usage = {}
        details = UsageParser._safe_get(usage, "details", {}) or {}
        if hasattr(details, "model_dump"):
            details = details.model_dump()
        if not isinstance(details, dict):
            details = {}
        pt_details = UsageParser._safe_get(usage, "prompt_tokens_details", {}) or {}
        if hasattr(pt_details, "model_dump"):
            pt_details = pt_details.model_dump()
        if not isinstance(pt_details, dict):
            pt_details = {}

        prompt_tokens = UsageParser._safe_get(usage, "prompt_tokens", 0)
        completion_tokens = UsageParser._safe_get(usage, "completion_tokens", 0)

        cache_hit_tokens = (
            UsageParser._safe_get(usage, "prompt_cache_hit_tokens") or
            UsageParser._safe_get(details, "prompt_cache_hit_tokens") or
            UsageParser._safe_get(usage, "cache_read_input_tokens") or
            UsageParser._safe_get(details, "cache_read_input_tokens") or
            # OpenAI 兼容格式：usage.prompt_tokens_details.cached_tokens
            pt_details.get("cached_tokens") or
            UsageParser._safe_get(details, "cached_tokens") or
            0
        )

        cache_write_tokens = (
            UsageParser._safe_get(usage, "cache_creation_input_tokens") or
            UsageParser._safe_get(details, "cache_creation_input_tokens") or
            UsageParser._safe_get(details, "cache_creation") or
            0
        )

        cache_miss_tokens = max(prompt_tokens - cache_hit_tokens, 0)

        return TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cache_hit_tokens=cache_hit_tokens,
            cache_miss_tokens=cache_miss_tokens,
            cache_write_tokens=cache_write_tokens,
        )
