from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Optional

from core.question import Question, QuestionAnswer

logger = logging.getLogger(__name__)


class QuestionManager:
    def __init__(self) -> None:
        self._queue: deque[Question] = deque()
        self._active: Optional[Question] = None
        self._answers: dict[str, QuestionAnswer] = {}
        self._waiting_future: Optional[asyncio.Future] = None

    @property
    def has_pending(self) -> bool:
        return len(self._queue) > 0 or self._active is not None

    @property
    def active_question(self) -> Optional[Question]:
        return self._active

    @property
    def pending_count(self) -> int:
        return len(self._queue)

    def enqueue(self, question: Question) -> None:
        self._queue.append(question)
        logger.info("Question enqueued: %s (%s)", question.question_id, question.question[:50])

    def enqueue_batch(self, questions: list[Question]) -> None:
        for q in questions:
            self.enqueue(q)

    async def get_next(self) -> Optional[Question]:
        if self._queue:
            self._active = self._queue.popleft()
            logger.info("Active question: %s", self._active.question_id)
            return self._active
        self._active = None
        return None

    async def wait_for_answer(
        self, question_id: str, timeout: int = 300
    ) -> QuestionAnswer:
        if question_id in self._answers:
            return self._answers.pop(question_id)

        loop = asyncio.get_event_loop()
        self._waiting_future = loop.create_future()

        try:
            answer = await asyncio.wait_for(self._waiting_future, timeout=timeout)
            return answer
        except asyncio.TimeoutError:
            logger.warning("Question %s timed out after %ds", question_id, timeout)
            question = self._active
            if question is None:
                for q in self._queue:
                    if q.question_id == question_id:
                        question = q
                        break
            default_answer = ""
            if question:
                default_answer = question.default_option
            return QuestionAnswer(
                question_id=question_id,
                selected=[default_answer] if default_answer else [],
                is_timeout=True,
            )
        finally:
            self._waiting_future = None

    def submit_answer(self, answer: QuestionAnswer) -> bool:
        self._answers[answer.question_id] = answer

        if self._waiting_future is not None and not self._waiting_future.done():
            self._waiting_future.set_result(answer)
            logger.info("Answer submitted for %s", answer.question_id)
            return True

        logger.info("Answer stored for %s (no active waiter)", answer.question_id)
        return True

    def cancel_all(self) -> None:
        self._queue.clear()
        self._active = None
        if self._waiting_future is not None and not self._waiting_future.done():
            self._waiting_future.cancel()
            self._waiting_future = None
        logger.info("All questions cancelled")
