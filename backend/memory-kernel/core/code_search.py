"""
Code Search — 代码搜索能力（正则搜索 + 符号搜索）。

集成路径：ToolGateway → GateKeeper → CodeSearch → rg / tree-sitter
"""

from __future__ import annotations

import asyncio
import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class SearchResult:
    """搜索结果。"""
    file: str
    line: int
    column: int
    content: str
    symbol_name: Optional[str] = None
    symbol_type: Optional[str] = None


class CodeSearch:
    """代码搜索：正则搜索（ripgrep）+ 符号搜索（tree-sitter）。"""

    def __init__(self, rg_path: str = "rg") -> None:
        self._rg_path = rg_path
        self._parsers: dict[str, object] = {}
        self._init_parsers()

    def _init_parsers(self) -> None:
        """初始化 tree-sitter 语言解析器。"""
        try:
            from tree_sitter import Language, Parser
            self._parser_cls = Parser
            self._lang_cls = Language
            self._init_language("py", "tree_sitter_python")
            self._init_language("js", "tree_sitter_javascript")
            self._init_language("jsx", "tree_sitter_javascript")
            self._init_language("ts", "tree_sitter_javascript")
            self._init_language("tsx", "tree_sitter_javascript")
            self._init_language("rs", "tree_sitter_rust")
            self._init_language("go", "tree_sitter_go")
        except ImportError:
            self._parser_cls = None
            self._lang_cls = None

    def _init_language(self, ext: str, module_name: str) -> None:
        """加载单个语言解析器。"""
        try:
            mod = __import__(module_name, fromlist=["language"])
            lang = self._lang_cls(mod.language())
            self._parsers[ext] = self._parser_cls(lang)
        except (ImportError, AttributeError):
            pass

    def get_parser(self, file_path: str) -> Optional[object]:
        """获取文件对应的 tree-sitter 解析器。"""
        ext = file_path.rsplit(".", 1)[-1] if "." in file_path else ""
        return self._parsers.get(ext)

    async def execute(
        self,
        query: str,
        search_type: str = "regex",
        cwd: str = ".",
        file_pattern: str = "*",
        max_results: int = 50,
    ) -> list[SearchResult]:
        """
        执行代码搜索。

        Args:
            query: 搜索查询（正则表达式或符号名）。
            search_type: "regex" 或 "symbol"。
            cwd: 搜索根目录。
            file_pattern: 文件过滤模式。
            max_results: 最大结果数。

        Returns:
            SearchResult 列表。
        """
        if search_type == "regex":
            return await self._regex_search(query, cwd, file_pattern, max_results)
        elif search_type == "symbol":
            return await self._symbol_search(query, cwd, file_pattern)
        else:
            raise ValueError(f"未知搜索类型: {search_type}")

    async def _regex_search(
        self, query: str, cwd: str, file_pattern: str, max_results: int
    ) -> list[SearchResult]:
        """通过 ripgrep 执行正则搜索。"""
        cmd = [
            self._rg_path,
            "--line-number",
            "--column",
            "--no-heading",
            "--color", "never",
            "--max-count", str(max_results),
            "-e", query,
            "--glob", file_pattern,
            cwd,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return _parse_rg_output(stdout.decode("utf-8", errors="replace"))

    async def _symbol_search(
        self, symbol_name: str, cwd: str, file_pattern: str
    ) -> list[SearchResult]:
        """通过 tree-sitter 搜索符号定义。"""
        if not self._parsers:
            return []
        results: list[SearchResult] = []
        for file_path in _glob_files(cwd, file_pattern):
            ext = file_path.rsplit(".", 1)[-1] if "." in file_path else ""
            parser = self._parsers.get(ext)
            if parser is None:
                continue
            symbols = await asyncio.to_thread(
                self._parse_file_symbols, parser, file_path, symbol_name
            )
            results.extend(symbols)
        return results

    def _parse_file_symbols(
        self, parser, file_path: str, symbol_name: str
    ) -> list[SearchResult]:
        """在线程池中执行的同步符号解析。"""
        try:
            source = Path(file_path).read_bytes()
        except (OSError, IOError):
            return []
        tree = parser.parse(source)
        return _extract_symbols(tree.root_node, source, symbol_name, file_path)


def _parse_rg_output(output: str) -> list[SearchResult]:
    """解析 ripgrep 输出（兼容 Windows 路径）。"""
    results = []
    for line in output.strip().splitlines():
        if not line:
            continue
        # Windows 路径以 X:\ 开头，需特殊处理
        if len(line) > 2 and line[1] == ":" and line[2] == "\\":
            # 去掉盘符 X: 前缀，按 ":line:column:content" 解析
            path_body = line[2:]
            parts = path_body.split(":", 3)
            if len(parts) < 4:
                continue
            try:
                results.append(SearchResult(
                    file=line[:2] + parts[0],
                    line=int(parts[1]),
                    column=int(parts[2]),
                    content=parts[3],
                ))
            except (ValueError, IndexError):
                continue
        else:
            # Unix 路径：无盘符，直接 split
            parts = line.split(":", 3)
            if len(parts) < 4:
                continue
            try:
                results.append(SearchResult(
                    file=parts[0],
                    line=int(parts[1]),
                    column=int(parts[2]),
                    content=parts[3],
                ))
            except (ValueError, IndexError):
                continue
    return results


def _glob_files(cwd: str, pattern: str) -> list[str]:
    """获取匹配模式的文件列表。"""
    results = []
    for root, _dirs, files in os.walk(cwd):
        for fname in files:
            if fnmatch.fnmatch(fname, pattern):
                results.append(os.path.join(root, fname))
    return results


def _extract_symbols(node, source: bytes, symbol_name: str, file_path: str) -> list[SearchResult]:
    """递归提取匹配的符号定义。"""
    results = []
    symbol_types = {
        "function_definition", "function_declaration", "method_definition",
        "class_definition", "class_declaration",
        "function_item", "struct_item", "impl_item", "type_declaration",
    }
    if node.type in symbol_types:
        name = _get_node_name(node, source)
        if name == symbol_name:
            line = node.start_point[0] + 1
            column = node.start_point[1] + 1
            content = source[node.start_byte:node.end_byte].decode("utf-8", errors="replace").split("\n")[0]
            results.append(SearchResult(
                file=file_path,
                line=line,
                column=column,
                content=content,
                symbol_name=name,
                symbol_type=node.type,
            ))
    for child in node.children:
        results.extend(_extract_symbols(child, source, symbol_name, file_path))
    return results


def _get_node_name(node, source: bytes) -> str:
    """获取符号节点名称。"""
    for child in node.children:
        if child.type == "identifier":
            return source[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
        if child.type == "name":
            return source[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
    return ""
