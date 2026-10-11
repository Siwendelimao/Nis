from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class QuestionOption:
    id: str
    label: str
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
        }


@dataclass
class Question:
    question: str
    question_id: str = ""
    options: list[QuestionOption] = field(default_factory=list)
    multiple: bool = False
    allow_custom: bool = True
    default_option: str = ""
    timeout_seconds: int = 300

    def __post_init__(self) -> None:
        if not self.question_id:
            self.question_id = f"q_{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> dict:
        return {
            "type": "QUESTION",
            "question_id": self.question_id,
            "question": self.question,
            "options": [opt.to_dict() for opt in self.options],
            "multiple": self.multiple,
            "allow_custom": self.allow_custom,
            "default_option": self.default_option,
            "timeout_seconds": self.timeout_seconds,
        }


@dataclass
class QuestionAnswer:
    question_id: str
    selected: list[str] = field(default_factory=list)
    custom_input: str = ""
    is_timeout: bool = False

    def to_dict(self) -> dict:
        return {
            "type": "QUESTION_ANSWER",
            "question_id": self.question_id,
            "selected": self.selected,
            "custom_input": self.custom_input,
            "is_timeout": self.is_timeout,
        }

    @property
    def effective_answer(self) -> str:
        if self.custom_input:
            return self.custom_input
        if self.selected:
            return self.selected[0]
        return ""


@dataclass
class NotificationAction:
    id: str
    label: str

    def to_dict(self) -> dict:
        return {"id": self.id, "label": self.label}


@dataclass
class SystemNotification:
    title: str
    message: str
    notification_id: str = ""
    level: str = "info"
    task_id: str = ""
    actions: list[NotificationAction] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.notification_id:
            self.notification_id = f"n_{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> dict:
        return {
            "type": "SYSTEM_NOTIFICATION",
            "notification_id": self.notification_id,
            "level": self.level,
            "title": self.title,
            "message": self.message,
            "task_id": self.task_id,
            "actions": [a.to_dict() for a in self.actions],
        }
