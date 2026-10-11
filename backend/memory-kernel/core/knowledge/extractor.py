"""NIS Knowledge — AI 提炼（结构化抽取）

把一段文字 / URL 内容交给 LLM，抽取成知识库固定格式字段：
    { title, summary, content, entry_type, tags[], source_label }
字段与 KnowledgeEntry 对齐；entry_type 走白名单。

LLM 不可用 / 输出非 JSON / 解析失败 → 返回最小兜底结构，
保证前端永远能拿到可回填的对象。
"""

from __future__ import annotations

import json
import re
from typing import Awaitable, Callable, Optional

# entry_type 白名单（与前端 TYPE_OPTIONS / 后端默认一致）
ALLOWED_TYPES = {"doc", "manual", "note", "reference"}

DEFAULT_PROMPT = """你是 NIS 的知识库提炼官。把下面的内容提炼成结构化的知识条目。

必须返回一个 JSON 对象，且以下 6 个字段缺一不可：
1. title：简洁标题（15 字内）
2. summary：一句话摘要（30 字内，概括本文最核心的一点）
3. content：提炼后的正文要点（保留关键信息，100~400 字）
4. entry_type：只能是以下之一 {allowed}
5. tags：2~5 个主题标签（中文，如 ["前端", "Vue"]；实在提炼不出就填一个能概括主题的词）
6. source_label：内容来源说明（如"某博主"/"某网站"/"官方文档"；无法判断时填"用户提供"）

只输出一个 JSON 对象，不要任何解释、代码围栏或多余文字，格式：
{{"title": "...", "summary": "...", "content": "...", "entry_type": "doc", "tags": ["...", "..."], "source_label": "..."}}

内容：
{content}
"""


class AIExtractor:
    """基于 LLM 的知识条目结构化抽取"""

    def __init__(self, llm_fn: Optional[Callable] = None) -> None:
        self._llm_fn = llm_fn
        self._last_error = ""

    def set_llm(self, llm_fn: Callable) -> None:
        """注入 llm_fn（prompt → str）"""
        self._llm_fn = llm_fn

    def has_llm(self) -> bool:
        return self._llm_fn is not None

    async def extract(self, content: str, source_type: str = "text") -> dict:
        """抽取内容 → 结构化字段。任何失败都返回兜底结构（绝不抛异常）。"""
        self._last_error = ""
        text = (content or "").strip()
        if not text:
            return self._fallback(text)

        if not self._llm_fn:
            return self._fallback(text)

        prompt = DEFAULT_PROMPT.format(
            content=text[:6000],
            allowed="/".join(sorted(ALLOWED_TYPES)),
        )
        try:
            raw = await self._llm_fn(prompt)
        except Exception as e:
            self._last_error = str(e)[:200]
            return self._fallback(text)

        parsed = self._parse_json(raw)
        if parsed is None:
            self._last_error = "模型未返回有效 JSON"
            return self._fallback(text)
        return self._normalize(parsed, text)

    # ── 解析 ──────────────────────────────────
    @staticmethod
    def _parse_json(raw: str) -> Optional[dict]:
        """从 LLM 输出提取 JSON 对象（容错：去掉围栏、取第一个 {…}）"""
        if not raw:
            return None
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _normalize(parsed: dict, original: str) -> dict:
        """字段清洗 + 白名单约束"""
        title = str(parsed.get("title") or "").strip()[:60]
        summary = str(parsed.get("summary") or "").strip()[:120]
        content = str(parsed.get("content") or "").strip()
        entry_type = str(parsed.get("entry_type") or "").strip()
        tags = parsed.get("tags") or []
        if isinstance(tags, str):
            # 部分模型把 tags 返回成字符串（逗号/顿号分隔）而非数组，这里兜底拆分
            tags = [t for t in re.split(r"[,，、;；]", tags) if t.strip()]
        if not isinstance(tags, list):
            tags = []
        tags = [str(t).strip()[:20] for t in tags if str(t).strip()][:6]
        source_label = str(parsed.get("source_label") or "").strip()[:60]

        if entry_type not in ALLOWED_TYPES:
            entry_type = "doc"
        if not title:
            title = (original or "未命名条目")[:60]
        if not content:
            content = (original or "")[:400]
        # 兜底：LLM 没给摘要时从正文截取，保证表单"摘要"字段有值
        if not summary:
            summary = content[:60]

        return {
            "title": title,
            "summary": summary,
            "content": content,
            "entry_type": entry_type,
            "tags": tags,
            "source_label": source_label,
        }

    @staticmethod
    def _fallback(content: str) -> dict:
        """兜底：无 LLM / 解析失败时，用原文前 60 字作标题、前 400 字作内容"""
        text = (content or "").strip()
        return {
            "title": (text or "未命名条目")[:60],
            "summary": "",
            "content": text[:400],
            "entry_type": "doc",
            "tags": [],
            "source_label": "",
        }


async def extract_knowledge(llm_fn: Optional[Callable], content: str) -> dict:
    """便捷入口：构造 extractor 并抽取"""
    extractor = AIExtractor(llm_fn)
    return await extractor.extract(content)
