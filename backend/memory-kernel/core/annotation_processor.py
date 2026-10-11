"""
AnnotationProcessor — 标注处理。

处理用户在预览上的圈选标注，调用 AI 精准修复代码。

v2.0 新增: Tag 标签系统 + process_command() 支持多轮对话场景。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional


@dataclass
class Annotation:
    """用户标注（保留，向后兼容）。"""
    element_id: str
    comment: str
    position: dict = field(default_factory=dict)


@dataclass
class AnnotationResult:
    """标注处理结果（保留，向后兼容）。"""
    fixed_code: str
    annotations_resolved: list[str]
    prompt_used: str


@dataclass
class Tag:
    """用户在画板上创建的标注标签。

    支持 4 种类型:
    - element: DOM 元素选择（通过 data-nis-id 定位）
    - region: 矩形区域框选
    - freehand: 自由绘制圈选
    - image: 图片区域选择
    """
    tag_id: str = ""
    tag_type: str = "element"          # element | region | freehand | image
    label: str = ""                    # 显示名称（如 "按钮"、"区域"）

    # 元素选择
    element_id: str = ""               # data-nis-id（element 类型）

    # 区域选择
    region: dict = field(default_factory=dict)       # {x, y, w, h}

    # 画笔
    points: list = field(default_factory=list)       # [{x, y}, ...]

    # 图片
    image_src: str = ""
    image_region: dict = field(default_factory=dict)

    # 视觉信息
    position: dict = field(default_factory=dict)     # 在预览中的位置
    color: str = "#1890ff"             # 高亮颜色

    def __post_init__(self) -> None:
        if not self.tag_id:
            self.tag_id = f"tag_{uuid.uuid4().hex[:8]}"

    def to_display_string(self) -> str:
        """转为输入框显示文本。"""
        if self.tag_type == "element":
            return f"{self.label}/{self.element_id}"
        elif self.tag_type == "region":
            r = self.region
            x1 = r.get('x', 0)
            y1 = r.get('y', 0)
            x2 = x1 + r.get('w', 0)
            y2 = y1 + r.get('h', 0)
            return f"区域({x1},{y1}~{x2},{y2})"
        elif self.tag_type == "image":
            return "图片区域"
        elif self.tag_type == "freehand":
            return "自由区域"
        return self.label

    def to_context_string(self) -> str:
        """转为 AI 上下文描述。"""
        if self.tag_type == "element":
            return f"HTML 元素 [{self.element_id}] <{self.label}> 位置:{self.position}"
        elif self.tag_type == "region":
            r = self.region
            x = r.get('x', 0)
            y = r.get('y', 0)
            w = r.get('w', 0)
            h = r.get('h', 0)
            return f"屏幕区域 左上角({x},{y}) 大小{w}x{h}"
        elif self.tag_type == "image":
            return f"图片区域 src={self.image_src} region={self.image_region}"
        elif self.tag_type == "freehand":
            return f"自由绘制区域 顶点数={len(self.points)}"
        return ""

    def to_dict(self) -> dict:
        """序列化为字典（前端通信）。"""
        return {
            "tag_id": self.tag_id,
            "tag_type": self.tag_type,
            "label": self.label,
            "element_id": self.element_id,
            "region": self.region,
            "points": self.points,
            "image_src": self.image_src,
            "image_region": self.image_region,
            "position": self.position,
            "color": self.color,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Tag:
        """从字典反序列化。"""
        return cls(
            tag_id=data.get("tag_id", ""),
            tag_type=data.get("tag_type", "element"),
            label=data.get("label", ""),
            element_id=data.get("element_id", ""),
            region=data.get("region", {}),
            points=data.get("points", []),
            image_src=data.get("image_src", ""),
            image_region=data.get("image_region", {}),
            position=data.get("position", {}),
            color=data.get("color", "#1890ff"),
        )

    def to_db_row(self) -> dict:
        """转为数据库行（dict/list 字段 JSON 序列化）。"""
        import json
        return {
            "tag_id": self.tag_id,
            "tag_type": self.tag_type,
            "label": self.label,
            "element_id": self.element_id,
            "region": json.dumps(self.region, ensure_ascii=False),
            "points": json.dumps(self.points, ensure_ascii=False),
            "image_src": self.image_src,
            "image_region": json.dumps(self.image_region, ensure_ascii=False),
            "position": json.dumps(self.position, ensure_ascii=False),
            "color": self.color,
            "created_at": time.time(),
        }

    @classmethod
    def from_db_row(cls, row: dict) -> Tag:
        """从数据库行反序列化（JSON 字段解析）。"""
        import json
        return cls(
            tag_id=row.get("tag_id", ""),
            tag_type=row.get("tag_type", "element"),
            label=row.get("label", ""),
            element_id=row.get("element_id", ""),
            region=json.loads(row.get("region", "{}") or "{}"),
            points=json.loads(row.get("points", "[]") or "[]"),
            image_src=row.get("image_src", ""),
            image_region=json.loads(row.get("image_region", "{}") or "{}"),
            position=json.loads(row.get("position", "{}") or "{}"),
            color=row.get("color", "#1890ff"),
        )


@dataclass
class CommandRequest:
    """用户指令请求。"""
    command: str = ""                  # 自然语言指令
    tags: list[Tag] = field(default_factory=list)      # 关联的标签
    current_code: str = ""             # 当前内容
    preview_type: str = "html"         # html | text | image


@dataclass
class CommandResponse:
    """AI 修改响应。"""
    success: bool = False
    fixed_code: str = ""               # 修改后的内容
    modified_elements: list[str] = field(default_factory=list)  # 被修改的元素 ID
    description: str = ""              # AI 做了什么的描述
    prompt_used: str = ""              # 实际使用的 prompt
    error: str = ""


LlmCallable = Callable[[str], Awaitable[str]]


class AnnotationProcessor:
    """处理用户标注。

    v2.0 新增 process_command() 支持标签化指令 + 多轮对话场景。
    原有 process() 方法保留不变，向后兼容。
    """

    def __init__(self, llm_fn: LlmCallable | None = None) -> None:
        self._llm = llm_fn

    # ── 原有方法（保留，向后兼容）──────────────────────

    async def process(
        self,
        annotations: list[Annotation],
        current_code: str,
    ) -> AnnotationResult:
        """根据标注修复代码。"""
        annotation_desc = self._build_annotation_desc(annotations)

        prompt = f"""用户指出了以下问题：

{annotation_desc}

当前代码：
```html
{current_code}
```

请修复这些问题，返回完整的新 HTML 代码。
只修改标注的问题，不要改动其他部分。
保持所有 data-nis-id 不变。
"""

        fixed_code = current_code
        if self._llm is not None:
            fixed_code = await self._llm(prompt)

        fixed_code = self._verify_ids(current_code, fixed_code)

        return AnnotationResult(
            fixed_code=fixed_code,
            annotations_resolved=[ann.element_id for ann in annotations],
            prompt_used=prompt,
        )

    def _build_annotation_desc(self, annotations: list[Annotation]) -> str:
        """把标注转成 AI 能理解的描述。"""
        lines = []
        for ann in annotations:
            lines.append(f"- 元素 [data-nis-id={ann.element_id}]: {ann.comment}")
            if ann.position:
                pos = ann.position
                lines.append(
                    f"  位置: 左上({pos.get('x', '?')},{pos.get('y', '?')}) "
                    f"大小{pos.get('w', '?')}x{pos.get('h', '?')}"
                )
        return "\n".join(lines)

    def _verify_ids(self, original_code: str, fixed_code: str) -> str:
        """验证修复后的代码保留了所有 data-nis-id。"""
        from core.data_nis_id import DataNisIdGenerator

        original_ids = set(DataNisIdGenerator().extract_ids(original_code))
        fixed_ids = set(DataNisIdGenerator().extract_ids(fixed_code))

        missing = original_ids - fixed_ids
        if missing:
            fixed_code = self._restore_missing_ids(fixed_code, missing)

        return fixed_code

    def _restore_missing_ids(self, code: str, missing_ids: set[str]) -> str:
        """尝试恢复缺失的 data-nis-id。"""
        for nis_id in missing_ids:
            if nis_id not in code:
                if "</body>" in code:
                    code = code.replace(
                        "</body>",
                        f'<!-- missing {nis_id} -->\n</body>',
                        1,
                    )
                else:
                    code = f"{code}\n<!-- missing {nis_id} -->"
        return code

    # ── v2.0 新增方法（标签化指令）─────────────────────

    async def process_command(
        self,
        request: CommandRequest,
    ) -> CommandResponse:
        """处理标签化指令。

        Args:
            request: 包含指令、标签、当前内容的请求

        Returns:
            CommandResponse: 修改结果
        """
        prompt = ""
        try:
            # 1. 构建 AI 上下文
            context = self._build_context(request)

            # 2. 构建 prompt
            prompt = self._build_prompt(request, context)

            # 3. 调用 LLM
            fixed_code = request.current_code
            if self._llm is not None:
                fixed_code = await self._llm(prompt)

            # 4. 验证结果
            fixed_code = self._verify_result(request, fixed_code)

            # 5. 收集被修改的元素
            modified = [t.element_id for t in request.tags if t.element_id]

            # 6. 生成描述
            tag_labels = ", ".join(t.to_display_string() for t in request.tags)
            description = f"已处理: {tag_labels} → {request.command}"

            return CommandResponse(
                success=True,
                fixed_code=fixed_code,
                modified_elements=modified,
                description=description,
                prompt_used=prompt,
            )
        except Exception as e:
            return CommandResponse(
                success=False,
                fixed_code=request.current_code,
                error=str(e)[:500],
                prompt_used=prompt,
            )

    def _build_context(self, request: CommandRequest) -> str:
        """构建 AI 上下文。"""
        parts = []

        # 标签上下文
        for tag in request.tags:
            parts.append(tag.to_context_string())

        return "\n".join(parts)

    def _build_prompt(self, request: CommandRequest, context: str) -> str:
        """根据 preview_type 选择 prompt 模板。"""
        if request.preview_type == "html":
            return self._html_prompt(request, context)
        elif request.preview_type == "text":
            return self._text_prompt(request, context)
        elif request.preview_type == "image":
            return self._image_prompt(request, context)
        else:
            return self._html_prompt(request, context)

    def _html_prompt(self, request: CommandRequest, context: str) -> str:
        """HTML 修改 prompt。"""
        tag_desc = "\n".join(
            f"- {t.to_context_string()}" for t in request.tags
        ) if request.tags else "(无特定元素，全局修改)"

        return f"""用户对以下元素执行操作：

{tag_desc}

指令：{request.command}

当前 HTML：
```html
{request.current_code}
```

要求：
1. 只修改标签关联的元素，不要改动其他部分
2. 保持所有 data-nis-id 不变
3. 返回完整的新 HTML 代码
"""

    def _text_prompt(self, request: CommandRequest, context: str) -> str:
        """文本修改 prompt。"""
        tag_desc = "\n".join(
            f"- {t.to_context_string()}" for t in request.tags
        ) if request.tags else "(无特定区域，全局修改)"

        return f"""用户对以下区域执行操作：

{tag_desc}

指令：{request.command}

当前内容：
{request.current_code}

要求：
1. 只修改标签关联的部分，不要改动其他内容
2. 保持整体结构和格式
3. 返回完整的修改后内容
"""

    def _image_prompt(self, request: CommandRequest, context: str) -> str:
        """图片修改 prompt。"""
        tag_desc = "\n".join(
            f"- {t.to_context_string()}" for t in request.tags
        ) if request.tags else "(整张图片)"

        return f"""用户对图片以下区域执行操作：

{tag_desc}

指令：{request.command}

请描述如何修改该区域，返回修改描述（图片编辑需要调用外部工具）。"""

    def _verify_result(self, request: CommandRequest, fixed_code: str) -> str:
        """验证修复结果。"""
        if request.preview_type == "html":
            return self._verify_ids(request.current_code, fixed_code)
        return fixed_code
