from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional

LlmCallable = Callable[[str], Awaitable[str]]


class OutputValidationError(Exception):
    def __init__(self, message: str, raw_output: str, errors: list[str]):
        super().__init__(message)
        self.raw_output = raw_output
        self.errors = errors


class JsonOutputGuard:
    def __init__(
        self,
        max_retries: int = 2,
        schema: dict = None,
    ) -> None:
        self._max_retries = max_retries
        self._schema = schema

    async def call(
        self,
        llm_fn: LlmCallable,
        prompt: str,
    ) -> dict:
        errors: list[str] = []
        raw_output = ""

        for attempt in range(self._max_retries + 1):
            try:
                raw_output = await llm_fn(prompt)
            except Exception as e:
                if attempt == self._max_retries:
                    raise OutputValidationError(
                        f"LLM 调用失败: {e}", "", [str(e)]
                    )
                continue

            parsed = self._try_parse_json(raw_output)
            if parsed is not None:
                return parsed

            errors.append(self._diagnose_json_error(raw_output))
            prompt = self._build_retry_prompt(raw_output, errors)

        raise OutputValidationError(
            f"{self._max_retries} 次重试后仍无法解析 JSON",
            raw_output,
            errors,
        )

    @staticmethod
    def _try_parse_json(raw: str) -> Optional[dict]:
        if not raw or not raw.strip():
            return None

        raw = raw.strip()

        # 路径 1: ```json 代码块
        m = re.search(r"```json\s*\n?(.*?)\n?```", raw, re.DOTALL | re.IGNORECASE)
        if m:
            return JsonOutputGuard._safe_loads(m.group(1).strip())

        # 路径 2: ``` 无标记代码块
        m = re.search(r"```\s*\n?(.*?)\n?```", raw, re.DOTALL)
        if m:
            return JsonOutputGuard._safe_loads(m.group(1).strip())

        # 路径 3: 裸 { } 包围
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            return JsonOutputGuard._safe_loads(raw[start:end + 1])

        # 路径 4: 全文本
        return JsonOutputGuard._safe_loads(raw)

    @staticmethod
    def _safe_loads(text: str) -> Optional[dict]:
        try:
            result = json.loads(text)
            return result if isinstance(result, dict) else {"output": result}
        except (json.JSONDecodeError, ValueError):
            return None

    @staticmethod
    def _diagnose_json_error(raw: str) -> str:
        if not raw or not raw.strip():
            return "输出为空"

        trimmed = raw.strip()

        if not trimmed.startswith("{"):
            return f"输出不是 JSON 对象，开头为: {trimmed[:50]}..."

        brace_count = 0
        for i, ch in enumerate(trimmed):
            if ch == "{":
                brace_count += 1
            elif ch == "}":
                brace_count -= 1
            if brace_count == 0 and i < len(trimmed) - 1:
                return f"JSON 在第 {i} 字符处提前闭合，后面有额外内容"

        if brace_count > 0:
            return f"JSON 缺少 {brace_count} 个闭合括号"

        try:
            json.loads(trimmed)
        except json.JSONDecodeError as e:
            return f"JSON 解析错误: {e.msg} (行 {e.lineno}, 列 {e.colno})"

        return "未知 JSON 错误"

    @staticmethod
    def _build_retry_prompt(raw_output: str, errors: list[str]) -> str:
        error_text = "\n".join(f"- {e}" for e in errors)
        snippet = raw_output[:300]
        return f"""你之前的输出不是有效的 JSON 对象。

错误详情：
{error_text}

你之前的输出片段：
{snippet}

请严格返回 JSON 对象格式：
1. 最外层必须是 {{ }} 包围的对象
2. 键和字符串值必须用双引号
3. 最后一个字段后不要有逗号
4. 不要输出 JSON 以外的任何文字（包括 ```json 标记）

请重新输出："""


def with_json_guard(max_retries: int = 2) -> Callable:
    def decorator(llm_fn: LlmCallable) -> LlmCallable:
        guard = JsonOutputGuard(max_retries=max_retries)

        async def wrapped(prompt: str) -> str:
            result = await guard.call(llm_fn, prompt)
            return json.dumps(result, ensure_ascii=False)

        return wrapped
    return decorator
