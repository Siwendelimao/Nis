/* registry.ts —— ★1001 外部 agent 安装配方表（数据驱动，可拆装）
 * 安装目录：NIS 根目录\external-agents\<id>\（已定案的固定文件夹）
 * 渠道按序尝试（本机 GitHub 文件 CDN 被墙 → 自动落到备用渠道；正常网络走 GitHub）：
 *   github-release  = GitHub releases 最新资产（资产名正则匹配 win-x64）
 *   pypi-pip        = PyPI 包，python -m pip install --prefix <dir>（解析依赖，生成 Scripts\*.exe 入口）
 *   npm-tarball     = npm registry tarball 直取解包（仅限自带二进制、零依赖的包）
 */
import path from 'node:path'
import { BACKEND_ROOT } from '../paths.ts'

/** NIS 根目录\external-agents —— 所有外部 agent 的固定安装家 */
export const EXT_AGENTS_DIR = path.join(path.dirname(BACKEND_ROOT), 'external-agents')

export type ExtChannel =
  | { kind: 'github-release'; asset: RegExp; extract: 'zip' | 'tar.gz' }
  | { kind: 'pypi-pip'; pkg: string }
  | { kind: 'npm-tarball'; pkg: string }
  | { kind: 'npm-deps'; pkg: string; bin: string; shim: string }

export interface ExtAgentRecipe {
  id: string
  name: string
  desc: string
  repo: string
  /** 安装后入口二进制名（装完在安装目录里扫描定位，记进 install.json） */
  binName: string
  /** 预设引擎 id（=adapter id；接线前 runExternalTurn 如实报"引擎待接线"） */
  engine: string
  channels: ExtChannel[]
  /** 渠道都没有的（如实标"渠道待补"，按钮置灰） */
  pendingSource?: string
}

export const EXT_AGENTS: ExtAgentRecipe[] = [
  {
    id: 'codex', name: 'Codex', engine: 'codex',
    desc: 'OpenAI 的命令行编码 agent（codex exec 无人值守模式已接线，可当预设/子agent）',
    repo: 'https://github.com/openai/codex',
    binName: 'codex.exe',
    channels: [
      { kind: 'github-release', asset: /codex-x86_64-pc-windows-msvc\.exe\.tar\.gz$/, extract: 'tar.gz' },
      { kind: 'pypi-pip', pkg: 'openai-codex-cli-bin' },
    ],
  },
  {
    id: 'opencode', name: 'OpenCode', engine: 'opencode',
    desc: '开源编码 agent（opencode run 无人值守 + TS SDK；引擎接线中）',
    repo: 'https://github.com/anomalyco/opencode',
    binName: 'opencode.exe',
    channels: [
      { kind: 'github-release', asset: /^opencode-windows-x64\.zip$/, extract: 'zip' },
      { kind: 'npm-tarball', pkg: 'opencode-windows-x64' },
    ],
    pendingSource: '按当前产品口径：外部 agent 一律不内置、用户自己选装 —— 目前先只开放 Codex，其余待接线',
  },
  {
    id: 'dsh', name: 'DeepSeek Harness', engine: 'dsh',
    desc: 'DeepSeek 的插件式 agent harness（dsh；引擎接线中）',
    repo: 'https://github.com/deepseek-ai/deepseek-harness',
    binName: 'dsh.cmd',
    channels: [
      // ★1001 七批：官方真身=npm @deepseek-ai/dsh（PyPI 那个 deepseek-harness 是同名冒牌，已排除）；
      // 带依赖 → npm-deps 装法（解包+装依赖+写启动器）
      { kind: 'npm-deps', pkg: '@deepseek-ai/dsh', bin: 'lib/bin.js', shim: 'dsh.cmd' },
    ],
    pendingSource: '按当前产品口径：外部 agent 一律不内置、用户自己选装 —— 目前先只开放 Codex，其余待接线',
  },
  {
    id: 'gemini', name: 'Gemini CLI', engine: 'gemini',
    desc: 'Google 官方开源 agent（Gemini 模型；谷歌账号/API key 登录；引擎接线中）',
    repo: 'https://github.com/google-gemini/gemini-cli',
    binName: 'gemini.js',
    channels: [
      { kind: 'npm-tarball', pkg: '@google/gemini-cli' },   // 自包含 bundle（deps=0）
    ],
    pendingSource: '按当前产品口径：外部 agent 一律不内置、用户自己选装 —— 目前先只开放 Codex，其余待接线',
  },
  {
    id: 'pi', name: 'Pi', engine: 'pi',
    desc: 'pi 原版编码 agent（NIS 引擎的上游，同源不同命；引擎接线中）',
    repo: 'https://github.com/earendil-works/pi',
    binName: 'pi.cmd',
    channels: [
      { kind: 'npm-deps', pkg: '@earendil-works/pi-coding-agent', bin: 'dist/bundle/cli.js', shim: 'pi.cmd' },
    ],
    pendingSource: '按当前产品口径：外部 agent 一律不内置、用户自己选装 —— 目前先只开放 Codex，其余待接线',
  },
  {
    id: 'hermes', name: 'Hermes', engine: 'hermes',
    desc: 'Nous Research 的自成长 agent（TUI/网关双入口；引擎接线中）',
    repo: 'https://github.com/nousresearch/hermes-agent',
    binName: 'hermes.exe',
    channels: [
      { kind: 'pypi-pip', pkg: 'hermes-agent' },
    ],
    pendingSource: '按当前产品口径：外部 agent 一律不内置、用户自己选装 —— 目前先只开放 Codex，其余待接线',
  },
  // ★1001 六批（已定案）：zcode 摘牌——命令行发行包只在其不可达 CDN（cdn.zcode-ai.com，实测 000），
  // GitHub 只有桌面安装器（已解剖：无独立 CLI 运行时，运行资源也是首跑时从同 CDN 拉）。
  // 证据链：D:\nis0924\toolchain\codex\zcode_setup.exe + asar 解剖记录；哪天地址公开/网络通了再加回一行。
]

export function findRecipe(id: string): ExtAgentRecipe | undefined {
  return EXT_AGENTS.find(r => r.id === id)
}
