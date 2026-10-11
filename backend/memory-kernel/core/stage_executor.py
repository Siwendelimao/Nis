"""
Stage Executor — 阶段执行器。

管理 DAG 的阶段确认流程：挂起等待用户决定，拒绝/超时自动回滚。
复用 Stage 2.5 的 StageStatus 枚举和 CheckpointManager。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

import networkx as nx

from core.checkpoint import CheckpointManager, StageStatus


class StageExecutor:
    """阶段执行器：管理 DAG 的阶段确认流程。"""

    def __init__(
        self,
        checkpoint_mgr: Optional[CheckpointManager] = None,
        ws_server: Any = None,
    ) -> None:
        self._checkpoint_mgr = checkpoint_mgr or CheckpointManager()
        self._ws_server = ws_server

    async def execute_with_stages(
        self,
        dag: dict,
        project_path: str,
        user_confirm_callback: Callable[..., Awaitable[bool]],
        timeout: float = 60.0,
    ) -> Dict[str, Any]:
        """
        执行含阶段确认的 DAG。
        
        Args:
            dag: DAG JSON {"nodes": [...], "edges": [...]}
            project_path: 项目工作区路径
            user_confirm_callback: 用户确认回调 async def(node, stage_info) -> bool
            timeout: 等待用户确认的超时秒数
        
        Returns:
            {node_id: {"status": str, "output": Any}}
        """
        graph = nx.DiGraph()
        nodes: Dict[str, dict] = {}
        stage_status: Dict[str, StageStatus] = {}

        for n in dag.get("nodes", []):
            nid = n["id"]
            nodes[nid] = {
                "id": nid,
                "skill": n.get("skill", "general"),
                "description": n.get("description", ""),
                "args": dict(n.get("args", {})),
                "status": "PENDING",
                "output": None,
            }
            graph.add_node(nid)

        for e in dag.get("edges", []):
            graph.add_edge(e["from"], e["to"])

        pending: Set[str] = set(nodes.keys())
        completed: Set[str] = set()
        failed: Set[str] = set()

        while pending:
            ready = self._find_ready(graph, pending, completed, failed)
            self._block_downstream(nodes, graph, pending, failed)
            if not ready:
                break

            for nid in ready:
                node = nodes[nid]
                requires_approval = node["args"].get("require_stage_approval", False)

                if requires_approval:
                    stage_status[nid] = StageStatus.WAITING_APPROVAL
                    ckpt = await self._checkpoint_mgr.create(project_path, nid)

                    stage_info = {
                        "description": node["description"],
                        "skill": node["skill"],
                    }

                    try:
                        is_approved = await asyncio.wait_for(
                            user_confirm_callback(node, stage_info), timeout=timeout
                        )
                    except asyncio.TimeoutError:
                        is_approved = False

                    if is_approved:
                        stage_status[nid] = StageStatus.EXECUTING
                        try:
                            node["status"] = "SUCCESS"
                            node["output"] = f"Executed {node['skill']}"
                            stage_status[nid] = StageStatus.COMPLETED
                            completed.add(nid)
                            pending.discard(nid)
                            await self._checkpoint_mgr.cleanup(ckpt)
                        except Exception:
                            node["status"] = "FAILED"
                            failed.add(nid)
                            pending.discard(nid)
                            stage_status[nid] = StageStatus.FAILED
                            await self._checkpoint_mgr.restore(ckpt)
                            await self._checkpoint_mgr.cleanup(ckpt)
                    else:
                        node["status"] = "BLOCKED"
                        failed.add(nid)
                        pending.discard(nid)
                        stage_status[nid] = StageStatus.BLOCKED
                        await self._checkpoint_mgr.restore(ckpt)
                        await self._checkpoint_mgr.cleanup(ckpt)
                        stage_status[nid] = StageStatus.ROLLED_BACK
                else:
                    stage_status[nid] = StageStatus.EXECUTING
                    try:
                        node["status"] = "SUCCESS"
                        node["output"] = f"Executed {node['skill']}"
                        stage_status[nid] = StageStatus.COMPLETED
                        completed.add(nid)
                        pending.discard(nid)
                    except Exception:
                        node["status"] = "FAILED"
                        failed.add(nid)
                        pending.discard(nid)
                        stage_status[nid] = StageStatus.FAILED

        return nodes

    @staticmethod
    def _find_ready(
        graph: nx.DiGraph, pending: Set[str], completed: Set[str], failed: Set[str]
    ) -> Set[str]:
        return {
            nid
            for nid in pending
            if all(pred in completed for pred in graph.predecessors(nid))
            and not any(pred in failed for pred in graph.predecessors(nid))
        }

    @staticmethod
    def _block_downstream(
        nodes: Dict[str, dict], graph: nx.DiGraph, pending: Set[str], failed: Set[str]
    ) -> None:
        """递归阻塞所有下游节点。"""
        while True:
            newly_blocked = {
                nid
                for nid in pending
                if any(pred in failed for pred in graph.predecessors(nid))
            }
            if not newly_blocked:
                break
            for nid in newly_blocked:
                nodes[nid]["status"] = "BLOCKED"
                pending.discard(nid)
                failed.add(nid)
