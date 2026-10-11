"""
LoopExecutor — 通用 Loop 引擎（Phase 5）。

与 Orchestrator（Phase 1-4）的关系：
- Orchestrator 负责 DAG 拓扑排序 + 并行调度（基于 GraphEngine）
- LoopExecutor 负责单个伙伴的执行→验收→修正循环（最多 3 轮）
- 二者分工不同：Orchestrator 管「谁先谁后」，LoopExecutor 管「做不好怎么办」
- 集成方式：Orchestrator 执行每个节点时，可调用 LoopExecutor 处理需要审计的伙伴

协作流程：
    Orchestrator.load_task_graph(dag) → 拓扑排序
    → 对每个就绪节点调用 LoopExecutor.execute(partner, task, auditor)
    → LoopExecutor 内部循环：执行 → 验收 → 修正 → 再执行
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from partners.base import LoopContext, LoopResult, Output, PartnerPlugin

logger = logging.getLogger(__name__)

AuditCallable = Callable[[Output, Any], Awaitable["AuditReport"]]


@dataclass
class AuditReport:
    passed: bool
    feedback: str
    issues: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if self.passed:
            return "通过"
        return self.feedback[:200] if self.feedback else "未通过"


class LoopExecutor:
    MAX_ROUNDS = 3

    async def execute(
        self,
        partner: PartnerPlugin,
        task: Any,
        auditor: AuditCallable,
    ) -> LoopResult:
        context = LoopContext(task=task)
        audit_report = AuditReport(passed=False, feedback="", issues=[])

        for round_num in range(1, self.MAX_ROUNDS + 1):
            context.round = round_num

            try:
                output = await partner.execute(context)
            except Exception as e:
                logger.error("伙伴 %s 第 %d 轮执行异常: %s", partner.name, round_num, e)
                context = context.with_specific_errors([str(e)])
                continue

            if Auditor.should_skip_audit(output, task):
                return LoopResult(
                    status="SUCCESS",
                    output=output,
                    rounds=round_num,
                    audit_report=None,
                    skipped_audit=True,
                )

            try:
                audit_report = await auditor(output, task)
            except Exception as e:
                logger.error("Auditor 验收异常: %s", e)
                audit_report = AuditReport(
                    passed=False,
                    feedback=f"验收过程异常: {e}",
                    issues=[],
                )

            if audit_report.passed:
                return LoopResult(
                    status="SUCCESS",
                    output=output,
                    rounds=round_num,
                    audit_report=audit_report,
                )

            context = context.with_specific_errors(audit_report.issues)

        return LoopResult(
            status="STUCK",
            output=output,
            rounds=self.MAX_ROUNDS,
            audit_report=audit_report,
            stuck_reason=audit_report.summary if audit_report else "未知原因",
        )


class Auditor:
    SKIP_AUDIT_RULES = {
        "image": True,
        "single_file_edit": True,
        "document": True,
        "multi_file": False,
        "security_code": False,
    }

    RULE_REGISTRY: dict[str, Callable] = {}

    @staticmethod
    def should_skip_audit(output: Output, task: Any) -> bool:
        output_type = output.output_type
        if Auditor.SKIP_AUDIT_RULES.get(output_type, False):
            return True
        if any(f.endswith((".auth.py", ".security.py", ".crypto.py")) for f in output.files_modified):
            return False
        if output_type == "code" and len(output.files_modified) <= 1:
            return True
        return False

    async def verify(self, output: Output, task: Any) -> AuditReport:
        rules = getattr(task, "acceptance_rules", [])
        issues = []

        for rule in rules:
            rule_type = rule.get("type", "") if isinstance(rule, dict) else getattr(rule, "type", "")
            checker = Auditor.RULE_REGISTRY.get(rule_type)
            if checker is None:
                issues.append(f"未知规则类型: {rule_type}")
                continue
            if checker:
                result = await checker(output, rule) if callable(checker) else None
                if result and not result:
                    issues.append(f"规则 {rule_type} 未通过")

        if not issues:
            return AuditReport(passed=True, feedback="全部规则通过")

        return AuditReport(passed=False, feedback="; ".join(issues), issues=issues)
