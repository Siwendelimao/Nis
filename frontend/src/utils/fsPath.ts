/**
 * ★ 0921z：路径小工具（前端）。
 *
 * 背景：项目 root_path = 工作区目录，**必须是绝对路径**。
 * 历史 bug 就是这儿出的——新建项目时用浏览器 API 选目录（`showDirectoryPicker` 给 `handle.name`、
 * `webkitdirectory` 给 `webkitRelativePath`），浏览器安全沙箱**给不了绝对路径**，
 * 于是 root_path 存成 `chat_20260921_141903` 这种目录名，被按后端进程 cwd 解析 → 同名工作区两份。
 *
 * 判定口径与后端 `backend/projectPaths.ts` 的 `isAbsolutePath` **保持一致**（两头都改才算改）。
 */
export function isAbsolutePath(p: string): boolean {
  const s = String(p || '').trim()
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true // Windows 盘符：D:\ / D:/
  if (/^[a-zA-Z]:$/.test(s)) return true // 罕见：只写盘符
  if (s.startsWith('\\\\') || s.startsWith('//')) return true // UNC：\\server\share
  return s.startsWith('/') // POSIX
}
