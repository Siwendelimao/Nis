import { defineStore } from 'pinia'
import { ref } from 'vue'

interface FileNode {
  name: string
  type: 'folder' | 'file'
  icon?: string
  children?: FileNode[]
}

interface PreviewContent {
  type: 'html' | 'image'
  content: string
}

/**
 * 工作空间 store —— 为后端对接预留
 *
 * 后端对接协议（WebSocket）：
 *   Server → Client: WORKSPACE_LIST   { project_id?, files: FileNode[] }  工作区文件树
 *   Client → Server: WORKSPACE_OPEN   { name: string }        请求打开文件内容
 *   Server → Client: WORKSPACE_FILE   { name, type, content } 文件内容
 *
 * 作用域规则（项目级）：
 *   - 文件树按项目隔离：key = project_id（分身项目），'' = 本体全局工作区
 *   - 聊天窗口（非项目）不展示工作空间文件（右侧栏隐藏该区块）
 *   - 项目窗口展示项目自己的文件树
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const filesByProject = ref<Record<string, FileNode[]>>({})
  const loadingFile = ref<string | null>(null)
  const fileCache = ref<Record<string, PreviewContent>>({})

  /** 某项目（或全局 ''）的文件树 */
  function filesFor(projectId: string): FileNode[] {
    return filesByProject.value[projectId || ''] || []
  }

  /** 由后端 WORKSPACE_LIST 消息调用，更新文件树（project_id 缺省落到全局） */
  function setFiles(tree: FileNode[], projectId = '') {
    filesByProject.value[projectId] = tree
  }

  /**
   * 请求打开文件。返回文件内容（命中缓存时），否则返回 null。
   * 返回 null 时，调用方需要向后端发送 WORKSPACE_OPEN 请求。
   */
  function openFile(name: string): PreviewContent | null {
    loadingFile.value = name
    if (fileCache.value[name]) {
      loadingFile.value = null
      return fileCache.value[name]
    }
    return null
  }

  /** 由后端 WORKSPACE_FILE 消息调用，写入并缓存文件内容 */
  function setFileContent(name: string, type: 'html' | 'image', content: string) {
    fileCache.value[name] = { type, content }
    if (loadingFile.value === name) loadingFile.value = null
  }

  function clearCache() {
    fileCache.value = {}
  }

  return {
    filesByProject,
    filesFor,
    loadingFile,
    fileCache,
    setFiles,
    openFile,
    setFileContent,
    clearCache,
  }
})
