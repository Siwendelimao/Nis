"""
ApiRouter — NIS API 路由层（基于 LiteLLM）。

统一调用 100+ LLM API，自动记录用量和费用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, Awaitable, Callable, Optional

from core.cost_calculator import CostCalculator
from core.model_registry import ModelRegistry
from core.usage_parser import UsageParser
from core.usage_storage import ApiCallRecord, UsageStorage
from core.api_key_vault import ApiKeyVault


class StreamTruncatedError(Exception):
    """流式输出被 max_tokens 上限截断（finish_reason=length）。"""


def _lenient_parse_tool_args(raw: str) -> dict:
    """宽松解析 LLM 工具参数：先修常见的非严格 JSON 问题，再 json.loads；失败返回 {"_raw": raw}。"""
    attempts = [raw]
    stripped = raw.strip()
    # 去除可能包裹的 ```json 围栏
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].lstrip()
        attempts.append(stripped)
    # 尾逗号
    import re
    fixed = re.sub(r",\s*([}\]])", r"\1", stripped)
    if fixed != stripped:
        attempts.append(fixed)
    # 单引号 → 双引号（仅当整串明显是单引号 JSON）
    if "'" in fixed and '"' not in fixed:
        attempts.append(fixed.replace("'", '"'))
    for candidate in attempts:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            continue
    return {"_raw": raw}


def _field(obj, key: str, default=None):
    """从 dict 或 pydantic 对象安全取字段。"""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    try:
        return getattr(obj, key, default)
    except Exception:
        try:
            return obj[key]
        except Exception:
            return default


class ApiRouter:
    """NIS API 路由层（基于 LiteLLM）。"""

    def __init__(
        self,
        registry: ModelRegistry,
        storage: UsageStorage,
        vault: ApiKeyVault,
        usage_callback: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> None:
        self._registry = registry
        self._parser = UsageParser()
        self._calculator = CostCalculator()
        self._storage = storage
        self._vault = vault
        self._usage_callback = usage_callback

    async def call_model(
        self,
        model_id: str,
        messages: list[dict],
        provider: str = "openai",
        api_key: str | None = None,
        api_base: str | None = None,
        project_id: str = "default",
        window_id: str = "default",
        partner_name: str = "NIS",
        **kwargs,
    ) -> dict:
        """统一调用 100+ LLM API。"""
        model_config = self._registry.get(provider, model_id)

        if api_key is None:
            api_key = self._vault.get_key(provider) or os.environ.get(f"{provider.upper()}_API_KEY", "")

        # 自定义供应商（base 指向第三方 /v1）：用 openai provider + api_base，绕开 litellm provider 白名单
        if api_base:
            litellm_model = f"openai/{model_id}"
            completion_kwargs: dict[str, Any] = {
                "model": litellm_model,
                "messages": messages,
                "api_key": api_key,
                "api_base": api_base.rstrip("/"),
            }
        else:
            litellm_model = f"{provider}/{model_id}"
            completion_kwargs = {
                "model": litellm_model,
                "messages": messages,
                "api_key": api_key,
            }
        completion_kwargs.update(kwargs)

        import litellm

        start_ts = time.time()
        response = await litellm.acompletion(**completion_kwargs)
        response_time_ms = int((time.time() - start_ts) * 1000)

        usage = self._parser.parse(response, provider)

        cost = self._calculator.calculate(model_config, usage) if model_config else None

        record = ApiCallRecord(
            call_id=f"call_{uuid.uuid4().hex[:8]}",
            timestamp=time.time(),
            project_id=project_id,
            window_id=window_id,
            model_id=model_id,
            provider=provider,
            partner_name=partner_name,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            cache_hit_tokens=usage.cache_hit_tokens,
            cache_miss_tokens=usage.cache_miss_tokens,
            cache_write_tokens=usage.cache_write_tokens,
            cache_hit_cost=cost.cache_hit_cost if cost else 0.0,
            cache_miss_cost=cost.cache_miss_cost if cost else 0.0,
            output_cost=cost.output_cost if cost else 0.0,
            total_cost=cost.total_cost if cost else 0.0,
            response_time_ms=response_time_ms,
        )
        self._storage.record(record)

        if self._usage_callback is not None:
            try:
                await self._usage_callback()
            except Exception:
                logging.getLogger(__name__).exception("usage_callback 失败")

        if hasattr(response, "model_dump"):
            return response.model_dump()
        return response

    async def stream_chat(
        self,
        model_id: str,
        messages: list[dict],
        provider: str = "openai",
        api_key: str | None = None,
        api_base: str | None = None,
        on_chunk=None,
        on_reasoning=None,
        on_tool_call=None,
        on_tool_detected=None,
        on_usage=None,
        stop_event=None,
        on_finish=None,
        project_id: str = "default",
        window_id: str = "default",
        partner_name: str = "NIS",
        **kwargs,
    ) -> str:
        """流式调用 LLM：边收边把增量文本交给 on_chunk（真流式）。

        on_chunk(delta: str) 在每段增量到达时回调；on_reasoning 接收推理增量（若有）。
        on_tool_call(name, args, call_id): 流式期间收到完整工具调用时回调（解析 delta.tool_calls
        增量累积成完整调用，框架层据此触发权限/询问，对齐 opencode Part 模型）。
        on_usage(dict): 流结束时回调真实用量（prompt/completion/cache_hit/cache_miss/cache_write
        tokens）——供 message.complete 携带，前端展示与缓存命中度量。
        stop_event: asyncio.Event，用户点「停止」时置位 → 提前中断流式。
        on_finish(reason: str | None): 流结束时回调 finish_reason（length=被截断）。
        返回完整文本。
        """
        if api_key is None:
            api_key = self._vault.get_key(provider) or os.environ.get(f"{provider.upper()}_API_KEY", "")

        if api_base:
            litellm_model = f"openai/{model_id}"
            completion_kwargs: dict[str, Any] = {
                "model": litellm_model,
                "messages": messages,
                "api_key": api_key,
                "api_base": api_base.rstrip("/"),
                "stream": True,
            }
        else:
            litellm_model = f"{provider}/{model_id}"
            completion_kwargs = {
                "model": litellm_model,
                "messages": messages,
                "api_key": api_key,
                "stream": True,
            }
        completion_kwargs.update(kwargs)
        # 流式也要拿真实 usage（final chunk 带 usage），用于计费
        completion_kwargs.setdefault("stream_options", {"include_usage": True})

        # 带工具时显式 tool_choice=auto：部分供应商（如 longcat/推理模型）不显式传则不返回 tool_calls
        if completion_kwargs.get("tools"):
            completion_kwargs.setdefault("tool_choice", "auto")

        import litellm

        full = ""
        reasoning = ""
        pending_content: list[str] = []
        reasoning_active = False
        live_stream = False  # 推理阶段结束后进入内容直通流式（不再缓冲）
        finish_reason: str | None = None
        usage_obj = None
        # 工具调用增量累积：index → {"id", "name", "arguments"}；id_to_slot 保证并行调用按 id 归槽
        tool_accumulator: dict[int, dict] = {}
        id_to_slot: dict[str, int] = {}
        emitted_tools: set[str] = set()
        _STREAM_IDLE_TIMEOUT = 120  # 空闲超时：120s 无新 chunk 视为网关断流（思考模型推理停顿可能超 30s，勿改小）
        try:
            stream = await litellm.acompletion(**completion_kwargs)
            # 先取 async 迭代器再 anext：兼容「async for 协议」的 mock（__aiter__ 初始化内部状态）
            _stream_aiter = stream.__aiter__()
            _chunk_no = 0
            while True:
                try:
                    chunk = await asyncio.wait_for(anext(_stream_aiter), timeout=_STREAM_IDLE_TIMEOUT)
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    logging.getLogger(__name__).warning(
                        "[api_router] 流式空闲超时（%s 秒无 chunk），中断流", _STREAM_IDLE_TIMEOUT
                    )
                    finish_reason = "timeout"
                    break
                _chunk_no += 1
                _u = _field(chunk, "usage", None)
                if _u is not None:
                    usage_obj = _u
                # 诊断：打印前 3 个 + 最后 2 个 chunk 的原始字段，排查"正文跑进思考"这类字段错位
                if _chunk_no <= 3:
                    try:
                        _dump = getattr(chunk, "model_dump", None)
                        _raw = _dump() if _dump else str(chunk)
                        logging.getLogger(__name__).info("[stream-dump] #%d %s", _chunk_no, str(_raw)[:400])
                    except Exception:
                        pass
                # 用户点「停止」→ 立即中断
                if stop_event is not None and stop_event.is_set():
                    break
                try:
                    choices = chunk.choices[0]
                    delta = choices.delta
                    content = delta.content
                    reasoning_delta = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                    if getattr(choices, "finish_reason", None) is not None:
                        finish_reason = getattr(choices, "finish_reason", None)
                except (AttributeError, IndexError, KeyError, TypeError):
                    content = None
                    reasoning_delta = None

                # 工具调用增量（litellm delta.tool_calls：index + id + function.name/arguments）
                # 兼容 dict 与 pydantic 对象（litellm 两种都可能给）
                try:
                    delta_tool_calls = getattr(choices.delta, "tool_calls", None) or []
                except (AttributeError, IndexError, KeyError, TypeError):
                    delta_tool_calls = []
                for tc in delta_tool_calls or []:
                    try:
                        index = int(_field(tc, "index", 0))
                    except (TypeError, ValueError):
                        index = 0
                    tc_id = _field(tc, "id", "") or ""
                    fn = _field(tc, "function", None) or {}
                    fn_name = _field(fn, "name", "") or ""
                    fn_args = str(_field(fn, "arguments", "") or "")
                    # 槽匹配优先按 id（index 缺失/重复时的容错，防并行调用串台 T3）：
                    # - id 已见过 → 同一槽（全量重发/增量续传）
                    # - id 未见过 → 认领「同 index 且尚未有 id」的槽（id 迟到场景），否则开新槽
                    # - 无 id → 退回 index 槽（单调用流式主路径）
                    slot_key = index
                    if tc_id:
                        slot_key = id_to_slot.get(tc_id)
                        if slot_key is None:
                            _cand = tool_accumulator.get(index)
                            if _cand is not None and not _cand.get("id"):
                                slot_key = index
                            else:
                                slot_key = max(tool_accumulator.keys(), default=-1) + 1
                            id_to_slot[tc_id] = slot_key
                    slot = tool_accumulator.setdefault(slot_key, {"id": "", "name": "", "arguments": ""})
                    if tc_id:
                        slot["id"] = tc_id
                    if fn_name:
                        slot["name"] = fn_name
                    if fn_args:
                        prev = slot["arguments"]
                        if prev and fn_args.startswith("{") and prev.rstrip().endswith("}"):
                            # 可能"全量重发"式增量（T2）：合并不可解析但增量单独可解析，
                            # 且是同一 call_id 的重发 → 替换（防 {..}{..} 拼接损坏）。
                            # 仅在 { 与 } 交界处做一次解析，正常增量无此边界，无性能损耗。
                            try:
                                json.loads(prev + fn_args)
                                slot["arguments"] = prev + fn_args
                            except (json.JSONDecodeError, TypeError):
                                try:
                                    json.loads(fn_args)
                                except (json.JSONDecodeError, TypeError):
                                    slot["arguments"] = prev + fn_args
                                else:
                                    if tc_id and tc_id == slot.get("id"):
                                        slot["arguments"] = fn_args
                                    else:
                                        slot["arguments"] = prev + fn_args
                        else:
                            slot["arguments"] = prev + fn_args
                    # 工具名一经出现 → 立即通知上层（工具状态/权限卡可提前弹出，不必等整个流结束）
                    if on_tool_detected is not None and fn_name and not slot.get("_detected"):
                        slot["_detected"] = True
                        try:
                            await on_tool_detected(fn_name, slot.get("id") or f"call_{slot_key}", str(slot.get("arguments") or "")[:300])
                        except Exception:
                            pass

                if reasoning_delta:
                    reasoning_active = True
                    reasoning += str(reasoning_delta)
                    if on_reasoning:
                        await on_reasoning(str(reasoning_delta))
                if content:
                    if live_stream:
                        # 已进入内容直通流式 → 立即转发，不缓冲
                        full += content
                        if on_chunk:
                            await on_chunk(content)
                    elif reasoning_active and not reasoning_delta:
                        # 推理阶段已结束（本块只带 content）→ 立即 flush 缓存，再直通
                        live_stream = True
                        for c in pending_content:
                            full += c
                            if on_chunk:
                                await on_chunk(c)
                        pending_content = []
                        full += content
                        if on_chunk:
                            await on_chunk(content)
                    elif reasoning_active:
                        # 推理仍在进行（本块同时带推理增量）→ 先缓存，保证"推理先广播完"
                        pending_content.append(content)
                    else:
                        # 无推理的普通流式 → 直接转发
                        full += content
                        if on_chunk:
                            await on_chunk(content)
        except Exception:
            raise
        # 兜底：流提前结束时仍有未 flush 的缓存 → 一次性输出
        if pending_content and (stop_event is None or not stop_event.is_set()):
            for c in pending_content:
                full += c
                if on_chunk:
                    await on_chunk(c)
        # 流结束：累积的完整工具调用 → on_tool_call 回调（框架层据此执行/授权）
        # 用户已点「停止」→ 丢弃累积的工具调用（停止后不得再执行新操作）
        if on_tool_call is not None and (stop_event is None or not stop_event.is_set()):
            for index in sorted(tool_accumulator.keys()):
                slot = tool_accumulator[index]
                name = (slot.get("name") or "").strip()
                if not name:
                    continue
                call_id = (slot.get("id") or "").strip() or f"call_{index}"
                if call_id in emitted_tools:
                    continue
                emitted_tools.add(call_id)
                raw_args = (slot.get("arguments") or "").strip()
                args: dict = {}
                if raw_args:
                    try:
                        parsed = json.loads(raw_args)
                        if isinstance(parsed, dict):
                            args = parsed
                        else:
                            args = {"_raw": raw_args}
                    except (json.JSONDecodeError, TypeError):
                        # 参数非严格 JSON → 尝试宽松修复（尾逗号/单引号等），仍失败则 _raw 交框架
                        args = _lenient_parse_tool_args(raw_args)
                else:
                    # 只有工具名没有参数（流式截断/异常）→ 标记损坏，框架层不得执行
                    args = {"_raw": ""}
                if "_raw" in args:
                    logging.getLogger(__name__).warning(
                        "[api_router] 工具参数解析失败（finish_reason=%s）name=%s 原始=%s",
                        finish_reason, name, (raw_args or "")[:200],
                    )
                try:
                    await on_tool_call(name, args, call_id)
                except Exception:
                    import traceback
                    logging.getLogger(__name__).exception("on_tool_call 回调失败")
        # 记录 finish_reason（length = 被 max_tokens 截断，前端可提示）
        if on_finish is not None:
            on_finish(finish_reason)
        # 流式结束 → 记录用量（usage 在 final chunk，需 stream_options.include_usage）
        if usage_obj is not None:
            if on_usage is not None:
                try:
                    usage = self._parser.parse({"usage": usage_obj}, provider)
                    on_usage({
                        "prompt_tokens": usage.prompt_tokens,
                        "completion_tokens": usage.completion_tokens,
                        "cache_hit_tokens": usage.cache_hit_tokens,
                        "cache_miss_tokens": usage.cache_miss_tokens,
                        "cache_write_tokens": usage.cache_write_tokens,
                    })
                except Exception:
                    pass
            await self._record_stream_usage(model_id, provider, project_id, window_id, partner_name, usage_obj)
        return full

    async def _record_stream_usage(
        self,
        model_id: str,
        provider: str,
        project_id: str,
        window_id: str,
        partner_name: str,
        usage_obj,
    ) -> None:
        """流式结束后记录用量（复用 call_model 的计费链路）。"""
        try:
            model_config = self._registry.get(provider, model_id)
            usage = self._parser.parse({"usage": usage_obj}, provider)
            cost = self._calculator.calculate(model_config, usage) if model_config else None
            record = ApiCallRecord(
                call_id=f"call_{uuid.uuid4().hex[:8]}",
                timestamp=time.time(),
                project_id=project_id,
                window_id=window_id,
                model_id=model_id,
                provider=provider,
                partner_name=partner_name,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                cache_hit_tokens=usage.cache_hit_tokens,
                cache_miss_tokens=usage.cache_miss_tokens,
                cache_write_tokens=usage.cache_write_tokens,
                cache_hit_cost=cost.cache_hit_cost if cost else 0.0,
                cache_miss_cost=cost.cache_miss_cost if cost else 0.0,
                output_cost=cost.output_cost if cost else 0.0,
                total_cost=cost.total_cost if cost else 0.0,
            )
            self._storage.record(record)
            if self._usage_callback is not None:
                try:
                    await self._usage_callback()
                except Exception:
                    logging.getLogger(__name__).exception("usage_callback 失败")
        except Exception:
            logging.getLogger(__name__).warning("流式用量记录失败", exc_info=True)
