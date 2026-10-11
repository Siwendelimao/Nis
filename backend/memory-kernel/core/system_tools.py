"""SystemTools — 系统级工具（纯 Python，不依赖 Rust MCP 网关）。

截图 / 剪贴板读 / 剪贴板写 / 系统通知 / 窗口控制（Windows）。
供 gateway 注册为 LLM 可见工具（system 插件）。
"""

from __future__ import annotations

import base64
import io
import logging

logger = logging.getLogger(__name__)


class SystemTools:
    """系统工具集（Windows）。"""

    async def screenshot(self, **kwargs) -> str:
        """截取当前屏幕，返回 dataURL（JPEG，压缩缩放到合理尺寸）。"""
        try:
            from PIL import ImageGrab
            img = ImageGrab.grab()
            if img is None:
                return "截图失败：屏幕不可用（可能运行在无桌面会话）"
            # 压缩：限制最长边 1600，转 JPEG 质量 75，避免几 MB 的 PNG 拖慢渲染
            img = img.convert("RGB")
            w, h = img.size
            max_side = 1600
            if max(w, h) > max_side:
                scale = max_side / max(w, h)
                img = img.resize((int(w * scale), int(h * scale)))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=75)
            return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as e:
            logger.warning("[system] 截图失败: %s", e)
            return f"截图失败：{e}"

    async def clipboard_read(self, **kwargs) -> str:
        """读取剪贴板文本。"""
        try:
            import win32clipboard
            win32clipboard.OpenClipboard()
            try:
                data = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
            finally:
                win32clipboard.CloseClipboard()
            return str(data or "")
        except Exception as e:
            logger.warning("[system] 读取剪贴板失败: %s", e)
            return f"读取剪贴板失败：{e}"

    async def clipboard_write(self, content: str = "", **kwargs) -> str:
        """写入剪贴板文本。"""
        try:
            import win32clipboard
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, str(content or ""))
            finally:
                win32clipboard.CloseClipboard()
            return "已写入剪贴板"
        except Exception as e:
            logger.warning("[system] 写入剪贴板失败: %s", e)
            return f"写入剪贴板失败：{e}"

    async def notify(self, title: str = "Nis", message: str = "", **kwargs) -> str:
        """发送 Windows 系统通知（气泡提醒）。"""
        try:
            import subprocess
            t = str(title or "Nis").replace("'", "''")
            m = str(message or "").replace("'", "''")
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "Add-Type -AssemblyName System.Drawing; "
                "$n = New-Object System.Windows.Forms.NotifyIcon; "
                "$n.Icon = [System.Drawing.SystemIcons]::Information; "
                f"$n.BalloonTipTitle = '{t}'; "
                f"$n.BalloonTipText = '{m}'; "
                "$n.Visible = $true; "
                "$n.ShowBalloonTip(4000)"
            )
            subprocess.Popen(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                shell=False,
            )
            return "已发送系统通知"
        except Exception as e:
            logger.warning("[system] 发送通知失败: %s", e)
            return f"发送通知失败：{e}"

    async def window_control(self, action: str = "", **kwargs) -> str:
        """窗口控制：minimize_all 最小化全部 / restore 恢复。"""
        try:
            import win32gui
            import win32con
            act = str(action or "").strip().lower()
            if act in ("minimize_all", "minimize"):
                win32gui.ShowWindow(win32gui.GetDesktopWindow(), win32con.SW_MINIMIZE)
                return "已最小化所有窗口"
            if act in ("restore", "restore_all"):
                win32gui.ShowWindow(win32gui.GetDesktopWindow(), win32con.SW_RESTORE)
                return "已恢复窗口"
            return "未知操作（支持 minimize_all / restore）"
        except Exception as e:
            logger.warning("[system] 窗口控制失败: %s", e)
            return f"窗口控制失败：{e}"
