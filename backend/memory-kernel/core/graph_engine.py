"""
GraphEngine — 动态图执行引擎。

支持条件路由、循环重试、状态累积、检查点。
被 Orchestrator 以装饰器模式包装，对外保持 API 兼容。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

import networkx as nx

PredicateFn = Callable[[Any], bool]

SkillCallable = Callable[..., Awaitable[Any]]


@dataclass
class EdgeConfig:
    """边配置。"""
    from_node: str
    to_node: str
    predicate: Optional[PredicateFn] = None


@dataclass
class NodeConfig:
    """节点配置。"""
    node_id: str
    skill: str
    description: str
    args: dict = field(default_factory=dict)
    max_retries: int = 0
    retry_delay: float = 0.0


@dataclass
class GraphState:
    """图执行状态（可序列化）。"""
    nodes: dict[str, dict]
    edges: list[tuple[str, str]]
    context: dict[str, Any]
    timestamp: str
    node_configs: dict[str, dict] = field(default_factory=dict)


class GraphEngine:
    """动态图执行引擎：条件路由 + 循环重试 + 状态累积 + 检查点。"""

    MAX_MODIFICATIONS = 10

    def __init__(self) -> None:
        self._graph: nx.DiGraph = nx.DiGraph()
        self._nodes: dict[str, NodeConfig] = {}
        self._edges: list[EdgeConfig] = []
        self._state: dict[str, dict] = {}
        self._context: dict[str, Any] = {}
        self._modification_count: int = 0

    @property
    def graph(self) -> nx.DiGraph:
        """只读访问底层图结构。"""
        return self._graph

    def get_nodes(self) -> dict[str, NodeConfig]:
        """获取所有节点配置（只读副本）。"""
        return dict(self._nodes)

    def get_edges(self) -> list[EdgeConfig]:
        """获取所有边配置（只读副本）。"""
        return list(self._edges)

    def add_node(self, config: NodeConfig) -> None:
        if config.node_id in self._nodes:
            raise ValueError(f"节点 {config.node_id} 已存在")
        self._nodes[config.node_id] = config
        self._graph.add_node(config.node_id)

    def add_edge(self, config: EdgeConfig) -> None:
        if config.from_node not in self._nodes:
            raise ValueError(f"起始节点 {config.from_node} 不存在")
        if config.to_node not in self._nodes:
            raise ValueError(f"目标节点 {config.to_node} 不存在")
        self._edges.append(config)
        self._graph.add_edge(config.from_node, config.to_node)

    def add_node_runtime(self, config: NodeConfig) -> None:
        if self._modification_count >= self.MAX_MODIFICATIONS:
            return
        if config.node_id in self._nodes:
            return
        self._nodes[config.node_id] = config
        self._graph.add_node(config.node_id)
        self._modification_count += 1

    def add_edge_runtime(self, config: EdgeConfig) -> None:
        if self._modification_count >= self.MAX_MODIFICATIONS:
            return
        if config.from_node not in self._nodes or config.to_node not in self._nodes:
            return
        self._edges.append(config)
        self._graph.add_edge(config.from_node, config.to_node)
        self._modification_count += 1

    def remove_node_runtime(self, node_id: str) -> None:
        if self._modification_count >= self.MAX_MODIFICATIONS:
            return
        if node_id not in self._nodes:
            return
        self._state[node_id] = {"status": "SKIPPED", "output": None, "skipped": True}
        self._modification_count += 1

    def get_modification_count(self) -> int:
        return self._modification_count

    def set_retry(self, node_id: str, max_retries: int, delay: float = 0.0) -> None:
        if node_id not in self._nodes:
            raise ValueError(f"节点 {node_id} 不存在")
        self._nodes[node_id].max_retries = max_retries
        self._nodes[node_id].retry_delay = delay

    async def execute_node(
        self, node_id: str, skill_fn: SkillCallable, **kwargs: Any
    ) -> tuple[Any, bool]:
        config = self._nodes[node_id]
        max_attempts = config.max_retries + 1
        for attempt in range(max_attempts):
            try:
                output = await skill_fn(**kwargs)
                self._state[node_id] = {
                    "status": "SUCCESS",
                    "output": output,
                    "error": None,
                    "retries": attempt,
                }
                return output, True
            except Exception as e:
                if attempt < max_attempts - 1:
                    if config.retry_delay > 0:
                        await asyncio.sleep(config.retry_delay)
                    continue
                self._state[node_id] = {
                    "status": "FAILED",
                    "output": None,
                    "error": str(e),
                    "retries": attempt,
                }
                return None, False

    def get_ready_nodes(self, completed_node: str) -> list[str]:
        ready: list[str] = []
        for edge in self.get_edges():
            if edge.from_node != completed_node:
                continue
            if edge.predicate is None:
                ready.append(edge.to_node)
            else:
                output = self._state.get(completed_node, {}).get("output")
                try:
                    if edge.predicate(output):
                        ready.append(edge.to_node)
                except Exception:
                    pass
        return ready

    def get_state(self, node_id: str) -> Optional[dict]:
        return self._state.get(node_id)

    def set_context(self, key: str, value: Any) -> None:
        self._context[key] = value

    def get_context(self, key: str) -> Any:
        return self._context.get(key)

    def get_node_output(self, node_id: str) -> Any:
        return self._state.get(node_id, {}).get("output")

    def checkpoint(self) -> GraphState:
        return GraphState(
            nodes={nid: dict(state) for nid, state in self._state.items()},
            edges=[(e.from_node, e.to_node) for e in self.get_edges()],
            context=dict(self._context),
            timestamp=datetime.now().isoformat(),
            node_configs={
                nid: {
                    "node_id": c.node_id,
                    "skill": c.skill,
                    "description": c.description,
                    "args": c.args,
                    "max_retries": c.max_retries,
                    "retry_delay": c.retry_delay,
                }
                for nid, c in self._nodes.items()
            },
        )

    def restore(self, state: GraphState) -> None:
        self._state = {nid: dict(data) for nid, data in state.nodes.items()}
        self._context = dict(state.context)
        for nid, cfg in state.node_configs.items():
            if nid not in self._nodes:
                self.add_node(NodeConfig(**cfg))


