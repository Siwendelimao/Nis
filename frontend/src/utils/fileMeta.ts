/**
 * 文件元信息（扩展名 → 图标/主题色/MIME）——过程块文件 chip（ToolPartBlock）与
 * 产出物弹窗（ToolFilePopup）共用。映射表与 ProducedFilesRow 保持同源一致。
 */

export function basename(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at === -1 ? p : p.slice(at + 1)
}

export function extOf(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** 文件类型图标（扩展名 → 图标 + 主题色） */
const fileIconMap: Array<{ exts: string[]; icon: string; color: string }> = [
  { exts: ['.html', '.htm'], icon: 'fab fa-html5', color: 'text-orange-500' },
  { exts: ['.css'], icon: 'fab fa-css3-alt', color: 'text-blue-500' },
  { exts: ['.js', '.mjs', '.cjs'], icon: 'fab fa-js', color: 'text-yellow-500' },
  { exts: ['.jsx', '.tsx'], icon: 'fab fa-react', color: 'text-cyan-500' },
  { exts: ['.ts'], icon: 'fas fa-code', color: 'text-blue-600' },
  { exts: ['.json'], icon: 'fas fa-code', color: 'text-green-500' },
  { exts: ['.md', '.markdown'], icon: 'fab fa-markdown', color: 'text-gray-600' },
  { exts: ['.py'], icon: 'fab fa-python', color: 'text-blue-400' },
  { exts: ['.java'], icon: 'fab fa-java', color: 'text-red-500' },
  { exts: ['.vue'], icon: 'fab fa-vuejs', color: 'text-green-500' },
  { exts: ['.sql'], icon: 'fas fa-database', color: 'text-blue-400' },
  { exts: ['.yml', '.yaml'], icon: 'fas fa-code', color: 'text-pink-500' },
  { exts: ['.xml'], icon: 'fas fa-code', color: 'text-orange-400' },
  { exts: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'], icon: 'far fa-image', color: 'text-green-500' },
  { exts: ['.pdf'], icon: 'far fa-file-pdf', color: 'text-red-500' },
  { exts: ['.mp4', '.avi', '.mov', '.mkv', '.webm'], icon: 'far fa-file-video', color: 'text-purple-500' },
  { exts: ['.mp3', '.wav', '.flac', '.ogg', '.m4a'], icon: 'far fa-file-audio', color: 'text-pink-500' },
  { exts: ['.doc', '.docx'], icon: 'far fa-file-word', color: 'text-blue-600' },
  { exts: ['.xls', '.xlsx', '.csv'], icon: 'far fa-file-excel', color: 'text-green-600' },
  { exts: ['.ppt', '.pptx'], icon: 'far fa-file-powerpoint', color: 'text-orange-600' },
  { exts: ['.zip', '.rar', '.7z', '.tar', '.gz'], icon: 'far fa-file-archive', color: 'text-yellow-600' },
]

export function metaOf(p: string) {
  return fileIconMap.find(m => m.exts.includes(extOf(p))) || { icon: 'far fa-file-code', color: 'text-gray-500' }
}

/** MIME（按扩展名推断，喂 open-file-viewer） */
export const mimeMap: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar', '.gz': 'application/gzip',
}

/** 看起来像一个文件路径（有扩展名；排除 URL）——拟人化文案「」片段/主参数是否渲染成文件 chip 用 */
export function isFileLike(s: string): boolean {
  const t = s.trim()
  if (!t || t.includes('://')) return false
  return /\.[A-Za-z0-9]{1,10}$/.test(t)
}
