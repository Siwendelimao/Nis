"""
Repo Map — 代码地图：符号提取 + 引用图 + PageRank 排名。

用于 LeaderAgent 代码感知规划，注入真实代码符号上下文。
"""

from __future__ import annotations

import asyncio
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import networkx as nx

from core.code_search import CodeSearch


@dataclass
class SymbolInfo:
    """代码符号信息。"""
    name: str
    qualified_name: str  # "file_path::symbol_name"
    symbol_type: str     # "function", "class", "method"
    file: str
    line: int
    references: int = 0
    pagerank: float = 0.0


class RepoMap:
    """代码地图：提取符号 → 构建引用图 → PageRank 排名 → token 预算截断。"""

    def __init__(self, code_search: Optional[CodeSearch] = None, max_tokens: int = 2000) -> None:
        self._code_search = code_search or CodeSearch()
        self._max_tokens = max_tokens

    async def build(self, cwd: str, file_pattern: str = "*.py") -> list[SymbolInfo]:
        """构建代码地图。"""
        symbols = await self._extract_symbols(cwd, file_pattern)
        if not symbols:
            return []
        await self._build_call_graph(cwd, symbols, file_pattern)
        self._compute_pagerank(symbols)
        symbols.sort(key=lambda s: s.pagerank, reverse=True)
        return self._apply_token_budget(symbols)

    async def _extract_symbols(self, cwd: str, file_pattern: str) -> list[SymbolInfo]:
        """提取所有符号定义（使用 tree-sitter 直接解析）。"""
        from fnmatch import fnmatch
        symbols = []
        for root, _dirs, files in os.walk(cwd):
            for fname in files:
                if not fnmatch(fname, file_pattern):
                    continue
                file_path = os.path.join(root, fname)
                parser = self._code_search.get_parser(file_path)
                if parser is None:
                    continue
                try:
                    source = await asyncio.to_thread(Path(file_path).read_bytes)
                    tree = await asyncio.to_thread(parser.parse, source)
                    rel_path = os.path.relpath(file_path, cwd)
                    file_symbols = self._extract_symbols_from_tree(
                        tree.root_node, source, rel_path
                    )
                    symbols.extend(file_symbols)
                except Exception:
                    continue
        return symbols

    def _extract_symbols_from_tree(self, node, source: bytes, rel_path: str) -> list[SymbolInfo]:
        """递归提取 tree 中的符号定义。"""
        symbols = []
        symbol_types = {
            "function_definition", "function_declaration", "method_definition",
            "class_definition", "class_declaration",
            "function_item", "struct_item", "impl_item", "type_declaration",
        }
        if node.type in symbol_types:
            name = self._get_node_name(node, source)
            if name:
                qualified = f"{rel_path}::{name}"
                symbols.append(SymbolInfo(
                    name=name,
                    qualified_name=qualified,
                    symbol_type=node.type,
                    file=rel_path,
                    line=node.start_point[0] + 1,
                ))
        for child in node.children:
            symbols.extend(self._extract_symbols_from_tree(child, source, rel_path))
        return symbols

    @staticmethod
    def _get_node_name(node, source: bytes) -> Optional[str]:
        """获取符号节点名称。"""
        for child in node.children:
            if child.type in ("identifier", "name"):
                return source[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
        return None

    async def _build_call_graph(self, cwd: str, symbols: list[SymbolInfo], file_pattern: str = "*.py") -> None:
        """构建真实的调用关系图（解析 AST 中的 call 节点，记录 caller_qname→callee_qname）。"""
        from fnmatch import fnmatch
        symbol_names = {sym.name for sym in symbols}
        name_to_qualified = {sym.name: sym.qualified_name for sym in symbols}
        call_counts: dict[str, int] = defaultdict(int)
        call_edges: list[tuple[str, str]] = []
        for root, _dirs, files in os.walk(cwd):
            for fname in files:
                if not fnmatch(fname, file_pattern):
                    continue
                file_path = os.path.join(root, fname)
                parser = self._code_search.get_parser(file_path)
                if parser is None:
                    continue
                try:
                    source = Path(file_path).read_bytes()
                    tree = parser.parse(source)
                    rel_path = os.path.relpath(file_path, cwd)
                    file_syms = [s for s in symbols if s.file == rel_path]
                    symbol_spans = [(s.line, self._get_symbol_end_line(tree.root_node, s.name, source), s.name) for s in file_syms]
                    self._find_calls_with_context(
                        tree.root_node, source, symbol_names, call_counts, call_edges, symbol_spans, name_to_qualified
                    )
                except Exception:
                    continue
        for sym in symbols:
            sym.references = call_counts.get(sym.name, 0)
        self._call_edges = call_edges

    @staticmethod
    def _get_symbol_end_line(node, target_name: str, source: bytes) -> int:
        """获取符号定义的结束行。"""
        symbol_types = {
            "function_definition", "function_declaration", "method_definition",
            "class_definition", "class_declaration",
            "function_item", "struct_item", "impl_item", "type_declaration",
        }
        if node.type in symbol_types:
            for child in node.children:
                if child.type in ("identifier", "name"):
                    name = source[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
                    if name == target_name:
                        return node.end_point[0] + 1
        for child in node.children:
            result = RepoMap._get_symbol_end_line(child, target_name, source)
            if result > 0:
                return result
        return 0

    @staticmethod
    def _find_calls_with_context(
        node, source: bytes,
        symbol_names: set[str],
        call_counts: dict[str, int],
        call_edges: list[tuple[str, str]],
        symbol_spans: list[tuple[int, int, str]],
        name_to_qualified: dict[str, str],
    ) -> None:
        """递归查找 call 节点，记录 caller_qname→callee_qname 关系。"""
        call_node_types = {"call", "call_expression", "function_call"}
        if node.type in call_node_types:
            call_name = RepoMap._get_call_name(node, source)
            if call_name and call_name in symbol_names:
                call_counts[call_name] += 1
                call_line = node.start_point[0] + 1
                caller_name = RepoMap._find_containing_symbol(call_line, symbol_spans)
                if caller_name and caller_name != call_name:
                    caller_q = name_to_qualified.get(caller_name)
                    callee_q = name_to_qualified.get(call_name)
                    if caller_q and callee_q:
                        call_edges.append((caller_q, callee_q))
        for child in node.children:
            RepoMap._find_calls_with_context(child, source, symbol_names, call_counts, call_edges, symbol_spans, name_to_qualified)

    @staticmethod
    def _find_containing_symbol(call_line: int, symbol_spans: list[tuple[int, int, str]]) -> Optional[str]:
        """根据行号找到包含该 call 的符号名。"""
        for start, end, name in symbol_spans:
            if end > 0 and start <= call_line <= end:
                return name
            elif start <= call_line:
                return name
        return None

    @staticmethod
    def _get_call_name(node, source: bytes) -> Optional[str]:
        """获取调用节点的函数名（修复 #6：attribute 取最后一个 identifier）。"""
        for child in node.children:
            if child.type == "identifier":
                return source[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
            if child.type == "attribute":
                identifiers = [sub for sub in child.children if sub.type == "identifier"]
                if identifiers:
                    last = identifiers[-1]
                    return source[last.start_byte:last.end_byte].decode("utf-8", errors="replace")
        return None

    def _compute_pagerank(self, symbols: list[SymbolInfo]) -> None:
        """基于真实调用关系计算 PageRank。"""
        G = nx.DiGraph()
        valid_qnames = {sym.qualified_name for sym in symbols}
        for qname in valid_qnames:
            G.add_node(qname)
        edges = getattr(self, '_call_edges', [])
        for caller_q, callee_q in edges:
            if caller_q in valid_qnames and callee_q in valid_qnames and caller_q != callee_q:
                G.add_edge(caller_q, callee_q)
        if len(G) == 0:
            return
        try:
            pr = nx.pagerank(G, alpha=0.85)
        except nx.PowerIterationFailedConvergence:
            pr = {qname: 1.0 / len(G) for qname in G.nodes()}
        for sym in symbols:
            sym.pagerank = pr.get(sym.qualified_name, 0.0)

    def _apply_token_budget(self, symbols: list[SymbolInfo]) -> list[SymbolInfo]:
        """按 token 预算截断符号列表。"""
        if not symbols:
            return []
        avg_token_per_symbol = 50
        max_symbols = max(1, self._max_tokens // avg_token_per_symbol)
        return symbols[:max_symbols]
