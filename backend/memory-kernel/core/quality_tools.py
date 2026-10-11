"""
QualityTools — 代码质量工具（跑测试 / 静态检查）。

给 agent 调用的质量工具，在项目根目录内执行，输出截断避免撑爆上下文。
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from typing import Callable, Optional


def _normalize_win_path(path: str) -> str:
    """把模型可能生成的 Unix 风格盘符路径（/e/foo）转成 Windows 盘符路径（E:/foo）。"""
    if not path:
        return path
    m = re.match(r"^/([a-zA-Z])(/.*)?$", path)
    if m:
        return m.group(1).upper() + ":" + (m.group(2) or "/")
    return path


class QualityTools:
    """跑测试 / lint 工具（中风险，需用户授权）。"""

    def __init__(self, project_root: Optional[Callable[[], Optional[str]]] = None) -> None:
        self._root_getter = project_root or (lambda: os.getcwd())

    def _root(self) -> str:
        r = self._root_getter()
        return os.path.abspath(r) if r else os.getcwd()

    async def run_tests(self, path: str = "", timeout: int = 300) -> str:
        root = self._root()
        cmd = [sys.executable, "-m", "pytest", "-q"]
        p = _normalize_win_path((path or "").strip())
        if p:
            cmd.append(p)
        return await self._run(cmd, root, timeout, "测试")

    async def lint(self, path: str = "", timeout: int = 120) -> str:
        root = self._root()
        p = _normalize_win_path((path or "").strip())
        # 用 venv 自带 python 跑 `python -m ruff`，避免 ruff 不在 PATH 上导致 FileNotFoundError
        for linter in ([sys.executable, "-m", "ruff", "check"], [sys.executable, "-m", "flake8"]):
            cmd = list(linter)
            if p:
                cmd.append(p)
            try:
                out = await self._run(cmd, root, timeout, "静态检查")
                return out
            except FileNotFoundError:
                continue
        return "未安装 ruff / flake8，请先 pip install ruff"

    async def _run(self, cmd: list[str], cwd: str, timeout: int, label: str) -> str:
        # 强制子进程输出 UTF-8（Windows 下 pytest 默认按控制台 GBK 编码，会导致中文乱码）
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except FileNotFoundError:
            raise
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return f"{label}超时（>{timeout}s）"

        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        body = (out + ("\n" + err if err else "")).strip()
        body = body[-4000:] if len(body) > 4000 else body
        status = f"{label}{'通过' if proc.returncode == 0 else '失败'}"
        return f"[{status}，exit={proc.returncode}]\n{body or '（无输出）'}"
