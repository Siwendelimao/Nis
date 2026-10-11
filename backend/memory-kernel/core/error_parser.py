"""
Error Parser — 错误解析器：从错误输出中提取结构化信息。

支持 Python Traceback、Shell 命令错误、编译错误等多种格式。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class StructuredError:
    """结构化错误信息。"""
    error_type: str
    message: str
    file: Optional[str]
    line: Optional[int]
    column: Optional[int]
    context: str


class ErrorParser:
    """错误解析器：提取文件/行号/列号/错误类型。"""

    _TRACEBACK_PATTERN = re.compile(
        r'File "([^"]+)", line (\d+).*?\n\s*(?:[^\n]*\n)*\s*(\w+Error):\s*(.+)',
        re.DOTALL,
    )
    _SHELL_ERROR_PATTERN = re.compile(
        r"^([^:]+):(\d+):\s*(.+)",
        re.MULTILINE,
    )
    _COMPILE_ERROR_PATTERN = re.compile(
        r"^([^:]+):(\d+):(\d+):\s*(error|warning)[:\[]?(\w+)?[\]:]?\s*(.+)",
        re.MULTILINE,
    )

    @staticmethod
    def parse(error_output: str) -> list[StructuredError]:
        """解析错误输出，提取结构化错误信息。"""
        if not error_output or not error_output.strip():
            return []
        errors = ErrorParser._parse_traceback(error_output)
        if errors:
            return errors
        errors = ErrorParser._parse_compile_error(error_output)
        if errors:
            return errors
        errors = ErrorParser._parse_shell_error(error_output)
        if errors:
            return errors
        return [StructuredError(
            error_type="UnknownError",
            message=error_output.strip()[:200],
            file=None,
            line=None,
            column=None,
            context=error_output,
        )]

    @staticmethod
    def _parse_traceback(error_output: str) -> list[StructuredError]:
        """解析 Python Traceback。"""
        errors = []
        for match in ErrorParser._TRACEBACK_PATTERN.finditer(error_output):
            file = match.group(1)
            line = int(match.group(2))
            error_type = match.group(3)
            message = match.group(4).strip()
            errors.append(StructuredError(
                error_type=error_type,
                message=message,
                file=file,
                line=line,
                column=None,
                context=match.group(0),
            ))
        return errors

    @staticmethod
    def _parse_shell_error(error_output: str) -> list[StructuredError]:
        """解析 Shell 命令错误。"""
        errors = []
        for match in ErrorParser._SHELL_ERROR_PATTERN.finditer(error_output):
            file = match.group(1)
            line = int(match.group(2))
            message = match.group(3).strip()
            errors.append(StructuredError(
                error_type="ShellError",
                message=message,
                file=file,
                line=line,
                column=None,
                context=match.group(0),
            ))
        return errors

    @staticmethod
    def _parse_compile_error(error_output: str) -> list[StructuredError]:
        """解析编译错误（Rust/C/Go 等）。"""
        errors = []
        for match in ErrorParser._COMPILE_ERROR_PATTERN.finditer(error_output):
            file = match.group(1)
            line = int(match.group(2))
            column = int(match.group(3))
            error_type = match.group(5) or match.group(4)
            message = match.group(6).strip()
            errors.append(StructuredError(
                error_type=error_type,
                message=message,
                file=file,
                line=line,
                column=column,
                context=match.group(0),
            ))
        return errors
