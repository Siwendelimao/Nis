<script setup lang="ts">
/**
 * 数据备份弹窗（0919 改造，已定案）
 *   导出：勾选要打进包里的部分 → 选位置 → 打包（没勾的**不进包**）
 *   导入：选包 → **只读清单**（不解包）→ 勾选要导入的部分 → 只解勾中的那几部分
 *         · 已导入过的部分显示「已导入」标记；再勾要**二次确认**（会覆盖，旧的备份成 .bak-<时间戳>）
 *         · "设置"里含供应商 API Key → 标红提示；导入时后端会**剔除 storagePath/envDir**（本机路径）
 * 部分清单与前后端字段都以 `server.ts` 的 DATA_PARTS 为准。
 */
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'
import { Eye, EyeOff } from 'lucide-vue-next'
import DirPickerModal from './DirPickerModal.vue'
import { useModalLayer } from '@/utils/modalStack'

interface Item {
  id: string
  label: string
  hint?: string
  secrets?: boolean
  def?: boolean
  bytes?: number
  files?: number
  importedAt?: number
}

/* filePath：导入时**由调用方先选好包**再传进来 —— 这样顺序是"先出文件选择器 → 选完才出现勾选窗"，
   不会出现"空弹窗压着系统文件框"。桌面端选包用系统对话框、网页端用应用内的 DirPickerModal，
   两种都在 SettingsModal 里做；本组件只负责"读清单 + 勾选 + 应用"。 */
/* ★1010：加 z —— 引导页的根容器 z-index 是 21.4 亿，默认 10070 的遮罩会被它整个盖住
   （实测：引导页里点"导入数据"、选完包后"没有任何反应"就是这个）。默认值保持原样，调用方按需抬高。 */
const props = defineProps<{ open: boolean; mode: 'export' | 'import'; filePath?: string; z?: number }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'done', payload: { mode: 'export' | 'import'; path?: string; parts?: any[]; backups?: number }): void
}>()

const chat = useChatStore()
const busy = ref(false)
const err = ref('')
const info = ref('')
const items = ref<Item[]>([])
const checked = ref<Record<string, boolean>>({})
const pkg = ref<{ zipPath: string; sizeMb: number; exportedAt: string } | null>(null)
const cover = ref<{ id: string; label: string; at: number } | null>(null)
/* 导出必须先**选目录**：桌面端用系统对话框，网页端回落应用内的 DirPickerModal（与导入选包一致） */
const dirPicker = ref(false)
/* 打包/解包进度：后端会把 data/progress 广播上来（设置页那条进度条就是它）——
   这里也订阅，否则几百 MB 的包在弹窗里只会显示"处理中…"，看着像卡死。 */
const prog = ref<{ percent: number; phase: string } | null>(null)

function onProgressFrame(frame: any): void {
  const pl = frame?.payload
  if (!pl || pl.type !== 'data/progress' || !busy.value) return
  prog.value = { percent: Number(pl.percent), phase: String(pl.phase || '') }
}
onMounted(() => { chat.onMessage(onProgressFrame) })
onUnmounted(() => { chat.offMessage(onProgressFrame) })

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
const fmtBytes = (b = 0) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B')
const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-CN') : '')
const selIds = computed(() => items.value.filter((x) => checked.value[x.id]).map((x) => x.id))
const totalBytes = computed(() => items.value.filter((x) => checked.value[x.id]).reduce((a, b) => a + (b.bytes || 0), 0))
const isImport = computed(() => props.mode === 'import')

/* ── ★ 0930 导出口令（已定案）：填一句口令，包里带一份口令加密的密钥 → 换电脑输同一句可恢复。
   不填也能导，但**必须明确拦一下告诉用户**（这个包到了别的电脑上密钥用不了），不静默放行。── */
const passPhrase = ref('')
/* ★1011（老大要求）：口令框加"显示/隐藏"眼睛 —— 口令是手输的长串，看不见很容易打错 */
const passPhraseShow = ref(false)
const passInputShow = ref(false)
/* ★1011（老大：导出弹窗太长了）：口令说明默认只留一行摘要，「详情」按需展开 */
const passTipOpen = ref(false)
const showPass = ref(false)
const passErr = ref('')
const sealedCount = ref(0)
const needsPassphrase = ref(false)
const passPrompt = ref(false)          // 导入时弹口令输入框（用户选 A：检测到口令包就弹）

/* ★1011（实测踩坑）：后端 secretbox.passphraseWeak 会把"太弱"的口令**直接拒绝加密**，
   于是出现"填了口令却没带密钥"——而前端当时不说原因（老大实测：填了 10 位口令，
   包里照样没有 providers.json/websearch.json）。这里把后端规则**逐条抄过来**做即时提示，
   让用户填的当下就知道行不行，不用等导完才发现。 */
const _pw = () => String(passPhrase.value || '').trim()
const passPhraseWeak = computed(() => {
  const s = _pw()
  if (!s) return false                       // 留空 = 明确"不带密钥"，不算弱
  if (s.length < 8) return true
  if (/^(.)\1+$/.test(s)) return true
  if (/^\d+$/.test(s)) return true
  return false
})
/* ★1011（老大要求）：口令强度显示（很弱 / 弱 / 中 / 强）—— 4 段小条 + 文字 */
const passStrength = computed(() => {
  const s = _pw()
  if (!s) return { level: 0, label: '' }
  let score = 0
  if (s.length >= 8) score++
  if (s.length >= 12) score++
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length
  score += Math.max(0, kinds - 1)
  /* 纯数字 / 纯重复字符：无论多长都压到最低档（它们是最容易被撞的） */
  if (/^(.)\1+$/.test(s) || /^\d+$/.test(s)) score = Math.min(score, 1)
  const level = Math.max(1, Math.min(4, score))
  return { level, label: ['', '很弱', '弱', '中', '强'][level] }
})
const passPhraseWeakWhy = computed(() => {
  const s = _pw()
  if (!s) return ''
  if (s.length < 8) return '至少 8 位'
  if (/^(.)\1+$/.test(s)) return '别用重复字符（如 aaaaaaaa）'
  if (/^\d+$/.test(s)) return '别用纯数字（如 12345678）'
  return ''
})
const passInput = ref('')
/** 勾选里含"设置"（= 含供应商密钥）吗 → 决定要不要拦、要不要显示口令框 */
const pickedSecrets = computed(() => items.value.filter((x) => checked.value[x.id] && x.secrets))
const pickedSecretsLabel = computed(() => pickedSecrets.value.map((x) => x.label).join('、'))
/** ★1011：**能靠导出口令带走**的那些（供应商 / 搜索密钥）。
 *  通道与远程接入是明文类（plainSecrets）——口令对它们不起作用，
 *  所以"口令输入框"只在勾了本集合时才出现，免得给用户"填了口令就安全"的错觉。 */
const pickedSealed = computed(() => pickedSecrets.value.filter((x: any) => !x.plainSecrets))

function close(): void {
  // 导入是"解包 + 覆盖落位"多步流程，中途关掉会把数据留在半途 → 仍禁止。
  if (busy.value) { if (isImport.value) return; void cancelExport(); return }
  resetLayers()
  emit('update:open', false)
}

/** 关掉弹窗前**把内层浮层一起复位**（0920 修反馈：
 *  「二级弹窗还开着，父弹窗已经关了；再打开甚至连上次的二级弹窗都还在」——
 *  根因是父组件的 open 状态关了、children 的 v-model 布尔量却留在 true）。 */
function resetLayers(): void {
  cover.value = null
  dirPicker.value = false
  passPrompt.value = false          // ★ 0930：口令框也是内层浮层，关父弹窗时一并复位（否则二次打开还挂着）
  passInput.value = ''
  passErr.value = ''
}

/** 导出可以中途取消（0920）：通知后端 kill tar，后端会删掉半截包。
 *  ≤ 一个 RTT 内 runExport 的 catch 就会复位 busy，这里只负责发指令。 */
async function cancelExport(): Promise<void> {
  try { await chat.bridgeRpc('data.cancelExport', {}) } catch { /* 后端可能刚好做完 */ }
}

/* Esc 层级：本弹窗是"一层"。它自己的内层（选目录 / 覆盖确认）要么是独立的一层
   （DirPickerModal 自己登记），要么由上面的 close 一起复位。 */
useModalLayer(() => props.open, () => close())

async function load(): Promise<void> {
  err.value = ''; info.value = ''; items.value = []; checked.value = {}; pkg.value = null
  try {
    if (props.mode === 'export') {
      const r: any = await chat.bridgeRpc('data.parts', {})
      const list = Array.isArray(r?.parts) ? r.parts : []
      /* 后端没给清单时**必须说出来**：最典型的成因是"改了后端没重启"（后端非 watch 模式），
         旧进程会回 { ok:true, _unhandled:'data.parts' } —— 静默空白最误导人。 */
      if (!list.length) throw new Error(t('settings.backupDlg.noParts'))
      items.value = list.map((x: any) => ({ ...x }))
      for (const it of items.value) if (it.def) checked.value[it.id] = true
      return
    }
    const zipPath = String(props.filePath || '').trim()
    if (!zipPath) { err.value = t('settings.backupDlg.needFile'); return }
    busy.value = true
    const r: any = await chat.bridgeRpc('data.importInspect', { zipPath })
    pkg.value = { zipPath, sizeMb: Number(r?.sizeMb || 0), exportedAt: String(r?.exportedAt || '') }
    /* ★ 0930：这个包带不带口令密钥（后端从 manifest 读）——带了才弹口令框，老包不打断。*/
    needsPassphrase.value = !!r?.needsPassphrase
    sealedCount.value = Number(r?.sealedCount || 0)
    items.value = (r?.parts || []).map((x: any) => ({ ...x }))
    for (const it of items.value) checked.value[it.id] = true
  } catch (e: any) {
    err.value = String(e?.message || e).slice(0, 300)
  } finally {
    busy.value = false
  }
}
watch(() => props.open, (v) => { if (v) void load(); else resetLayers() })

/** 勾选：已导入过的**不直接勾上**，先弹确认（避免手滑就把老数据覆盖掉） */
function toggle(it: Item): void {
  if (checked.value[it.id]) { checked.value[it.id] = false; return }
  if (isImport.value && it.importedAt) { cover.value = { id: it.id, label: it.label, at: it.importedAt }; return }
  checked.value[it.id] = true
}
function coverYes(): void {
  if (cover.value) checked.value[cover.value.id] = true
  cover.value = null
}

async function doExport(): Promise<void> {
  if (busy.value) return
  if (!selIds.value.length) { err.value = t('settings.backupDlg.nothing'); return }
  err.value = ''
  /* ★ 0930（已定案①「明确拦一下」）：勾了含密钥的部分却没填口令 →
     这个包到了别的电脑上密钥用不了（密钥按本机 Windows 账户加密，出不了本机）。
     这里**明确问一次**，不静默放行；用户确认后仍可导出（他可能只是自己留个备份）。
     ★1011：**分两类说清楚** ——
       ① 加密的供应商/搜索密钥：不填口令就带不走（口令加密后才出得了本机）；
       ② 明文类（通道与远程接入：机器人 secret / 远程访问令牌 / 隧道私钥）：
          **口令保护不了**，包里就是明文 —— 必须单独说，别让用户以为填了口令就安全。*/
  if (pickedSecrets.value.length && !passPhrase.value.trim()) {
    const plain = pickedSecrets.value.filter((x: any) => x.plainSecrets)
    const sealed = pickedSecrets.value.filter((x: any) => !x.plainSecrets)
    const blocks: string[] = []
    if (sealed.length) {
      blocks.push(`「${sealed.map((x: any) => x.label).join('、')}」里含供应商密钥。\n` +
        `不填导出口令的话，这个包到了**别的电脑上密钥用不了**（密钥是按本机 Windows 账户加密的，出不了本机）。`)
    }
    if (plain.length) {
      blocks.push(`「${plain.map((x: any) => x.label).join('、')}」里含**明文**的访问令牌 / 机器人密钥 / 隧道私钥 ——\n` +
        `导出口令**保护不了**它们，包里就是明文（换台电脑能直接用，所以更要自己保管好这个包）。`)
    }
    const tail = sealed.length
      ? '确定要这样导出吗？（想带着密钥换电脑用，就取消、在下面填一句口令）'
      : '确定要这样导出吗？'
    const ok = window.confirm(blocks.join('\n\n') + '\n\n' + tail)
    if (!ok) { if (sealed.length) showPass.value = true; return }
  }
  const dir = await pickDir()
  if (!dir) return
  await runExport(dir)
}

/** 选导出目录：桌面端系统对话框；网页端打开应用内选择器（选完由 onDirPicked 接着导） */
async function pickDir(): Promise<string> {
  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const p = await open({ directory: true, multiple: false, title: t('settings.general.dataExportPickDir') })
      return p ? String(p) : ''
    } catch { /* 系统对话框不可用 → 回落内置选择器 */ }
  }
  dirPicker.value = true
  return ''
}

function onDirPicked(p: string): void {
  dirPicker.value = false
  if (!p) return
  void runExport(p)
}

async function runExport(dir: string): Promise<void> {
  busy.value = true
  prog.value = { percent: 0, phase: t('settings.general.dataExporting') }
  try {
    const r: any = await chat.bridgeRpc('data.exportAll', { dir, parts: selIds.value, passphrase: passPhrase.value.trim() })
    const sealed = Number(r?.portableKeys?.sealed || 0)
    const failedList: string[] = Array.isArray(r?.portableKeys?.failed) ? r.portableKeys.failed : []
    /* ★1011：后端的拒绝**原因**（例如"口令太弱"）以前没被前端用上，用户只看到"没带密钥"却不知为何 */
    const keyErr = String(r?.portableKeys?.error || '')
    info.value = t('settings.general.dataExportDone', { path: String(r?.path || '') })
      + (sealed > 0 ? `\n已把 ${sealed} 项密钥（供应商 / 搜索引擎）用你的口令加密进包（换电脑输同一句口令即可恢复）。` : '')
      + (failedList.length ? `\n⚠ 有 ${failedList.length} 项没能加密进包：${failedList.join('、')} —— 这些密钥只有本机能用。` : '')
      + (keyErr ? `\n原因：${keyErr}` : '')
    sealedCount.value = sealed
    busy.value = false
    prog.value = null
    emit('done', { mode: 'export', path: String(r?.path || '') })
    window.setTimeout(() => emit('update:open', false), 1600)
  } catch (e: any) {
    busy.value = false
    prog.value = null
    const msg = String(e?.message || e)
    /* 用户自己点的取消 —— 这不是故障，别弹红字吓人 */
    if (msg.includes('已取消')) { info.value = t('settings.backupDlg.cancelled'); return }
    err.value = msg.slice(0, 300)
  }
}

function passSubmit(): void {
  if (!passInput.value.trim() || busy.value) return
  passErr.value = ''
  passPrompt.value = false
  void doImport()
}

async function doImport(): Promise<void> {
  if (busy.value || !pkg.value) return
  if (!selIds.value.length) { err.value = t('settings.backupDlg.nothing'); return }
  /* ★ 0930（已定案②A）：这个包带口令密钥 → 先弹口令框，不打断到一半才问。*/
  if (needsPassphrase.value && !passInput.value.trim()) { passPrompt.value = true; return }
  err.value = ''
  busy.value = true
  try {
    const r: any = await chat.bridgeRpc('data.importApply', { zipPath: pkg.value.zipPath, parts: selIds.value, passphrase: passInput.value.trim() })
    const bad = (r?.parts || []).filter((x: any) => !x.ok)
    if (bad.length) err.value = bad.map((x: any) => `${x.label}：${x.note}`).join('；').slice(0, 300)
    busy.value = false
    emit('done', { mode: 'import', parts: r?.parts || [], backups: Number(r?.backups || 0) })
    window.setTimeout(() => emit('update:open', false), 1400)
  } catch (e: any) {
    busy.value = false
    err.value = String(e?.message || e).slice(0, 300)
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="db">
      <div v-if="props.open" class="db-mask" :style="{ zIndex: props.z || 10070 }" @click.self="close">
      <div class="db-card" role="dialog" aria-modal="true">
        <div class="db-head">
          <h3 class="db-title">{{ isImport ? t('settings.backupDlg.titleImport') : t('settings.backupDlg.titleExport') }}</h3>
          <p class="db-sub">{{ isImport ? t('settings.backupDlg.subImport') : t('settings.backupDlg.subExport') }}</p>
          <p v-if="isImport && pkg" class="db-pkg">
            {{ t('settings.backupDlg.pkg') }}：{{ pkg.zipPath.split(/[\\/]/).pop() }} · {{ pkg.sizeMb }} MB
            <span v-if="pkg.exportedAt"> · {{ pkg.exportedAt.slice(0, 19).replace('T', ' ') }}</span>
          </p>
        </div>

        <div class="db-list">
          <div v-for="it in items" :key="it.id" class="db-row" :class="{ on: checked[it.id] }" @click="toggle(it)">
            <span class="db-box" :class="{ on: checked[it.id] }"><i v-if="checked[it.id]" class="fas fa-check"></i></span>
            <div class="db-text">
              <div class="db-label">
                <span>{{ it.label }}</span>
                <span v-if="it.secrets" class="db-tag warn">{{ t('settings.backupDlg.secrets') }}</span>
                <span v-if="it.importedAt" class="db-tag done">{{ t('settings.backupDlg.imported') }}</span>
              </div>
              <div class="db-meta">
                <span v-if="it.bytes">{{ fmtBytes(it.bytes) }}</span>
                <span v-if="it.files">· {{ it.files }} 项</span>
                <span v-if="it.hint">· {{ it.hint }}</span>
                <span v-if="it.importedAt" class="db-at">· {{ t('settings.backupDlg.importedAt', { time: fmtTime(it.importedAt) }) }}</span>
              </div>
            </div>
          </div>
          <div v-if="!items.length && !busy && !err" class="db-empty">—</div>
        </div>

        <!-- ★ 0930 导出口令（已定案）：勾了含密钥的部分才显示；填了 → 密钥可跨电脑使用 -->
        <!-- ★1011：只在勾了**能用口令带走**的密钥（供应商/搜索）时出现；
             通道与远程接入是明文类，口令护不住 → 那里不出现口令框（文案里另有明确提示） -->
        <div v-if="!isImport && pickedSealed.length" class="db-pass">
          <label class="db-pass-label">
            导出口令<span class="db-pass-opt">（选填；<b>填了才会把密钥一起打包</b>）</span>
          </label>
          <div class="db-pass-row">
            <input
              v-model="passPhrase"
              :type="passPhraseShow ? 'text' : 'password'"
              class="db-pass-input"
              placeholder="至少 8 位；换电脑导入时要输同一句"
              autocomplete="off"
            />
            <button
              type="button"
              class="db-pass-eye"
              :title="passPhraseShow ? '隐藏口令' : '显示口令'"
              :aria-label="passPhraseShow ? '隐藏口令' : '显示口令'"
              @click="passPhraseShow = !passPhraseShow"
            >
              <EyeOff v-if="passPhraseShow" :size="15" :stroke-width="2" />
              <Eye v-else :size="15" :stroke-width="2" />
            </button>
          </div>
          <!-- ★1011：强度条（填了才显示） -->
          <div v-if="passStrength.level" class="db-pass-meter">
            <div class="db-pass-meter-bar">
              <span
                v-for="i in 4"
                :key="i"
                class="db-pass-meter-seg"
                :class="i <= passStrength.level ? 'is-on lv-' + passStrength.level : ''"
              ></span>
            </div>
            <span class="db-pass-meter-label" :class="'lv-' + passStrength.level">{{ passStrength.label }}</span>
          </div>
          <p v-if="passPhraseWeak" class="db-pass-weak">
            <i class="fas fa-triangle-exclamation mr-1"></i>
            口令较弱（{{ passPhraseWeakWhy }}）—— <b>仍然会</b>用它加密并打包密钥，只是包被拿走时更容易被暴力试出来。
            建议换成字母 + 数字 + 符号的组合，例如 <b>Nis-2026-Backup</b>。
          </p>
          <p class="db-pass-tip">
            <span class="db-pass-sum">不填 = 密钥留在本机；填了 = 换电脑能用（<b>口令忘了就恢复不了</b>）</span>
            <button type="button" class="db-pass-more" @click="passTipOpen = !passTipOpen">
              {{ passTipOpen ? '收起' : '详情' }}
            </button>
            <template v-if="passTipOpen">
              <br /><b>不填口令：</b>包里<b>不带</b>供应商 / 搜索密钥，密钥留在本机，换电脑要重新填一次。<br />
              <b>填了口令：</b>包里会多带一份用口令加密的密钥副本 —— 换电脑导入时输入同一句即可恢复。<br />
              密钥本身默认按<b>本机 Windows 账户</b>加密，出不了这台电脑；口令不会写进包里。
            </template>
          </p>
        </div>

        <!-- ★ 0930 导入：提示这个包的密钥需要口令 -->
        <p v-if="isImport && needsPassphrase" class="db-needpass">
          这个包里带 {{ sealedCount }} 项密钥（供应商 / 搜索引擎，用导出口令加密）。导入时会让你输入那句口令。
        </p>

        <p v-if="err" class="db-err">{{ err }}</p>
        <p v-if="info" class="db-info">{{ info }}</p>

        <!-- 打包/解包进度（几百 MB 的包要跑一分钟以上，没这条会像卡死） -->
        <div v-if="busy && prog" class="db-prog">
          <div class="db-prog-bar"><span :style="{ width: Math.max(6, Math.min(100, prog.percent)) + '%' }"></span></div>
          <span class="db-prog-txt">{{ prog.phase }}<template v-if="prog.percent >= 0"> · {{ Math.round(prog.percent) }}%</template></span>
        </div>

        <div class="db-foot">
          <span class="db-sum">
            {{ t('settings.backupDlg.picked') }} {{ selIds.length }}<template v-if="totalBytes"> · {{ fmtBytes(totalBytes) }}</template>
          </span>
          <div class="db-btns">
            <button
              type="button"
              class="db-btn ghost"
              :disabled="busy && isImport"
              :class="{ 'is-stopping': busy && !isImport }"
              @click="close"
            >{{ busy && !isImport ? t('settings.backupDlg.cancelRun') : t('settings.backupDlg.cancel') }}</button>
            <button v-if="!isImport" type="button" class="db-btn main" :disabled="busy" @click="doExport">
              {{ busy ? t('settings.backupDlg.busy') : t('settings.backupDlg.doExport') }}
            </button>
            <button v-else type="button" class="db-btn main" :disabled="busy || !pkg" @click="doImport">
              {{ busy ? t('settings.backupDlg.busy') : t('settings.backupDlg.doImport') }}
            </button>
          </div>
        </div>

        <!-- 覆盖确认（子层） -->
        <div v-if="cover" class="db-cover">
          <div class="db-cover-box">
            <h4 class="db-cover-title">{{ t('settings.backupDlg.coverTitle') }}</h4>
            <p class="db-cover-body">{{ t('settings.backupDlg.coverBody', { label: cover.label, time: fmtTime(cover.at) }) }}</p>
            <div class="db-btns end">
              <button type="button" class="db-btn ghost" @click="cover = null">{{ t('settings.backupDlg.coverNo') }}</button>
              <button type="button" class="db-btn main" @click="coverYes">{{ t('settings.backupDlg.coverYes') }}</button>
            </div>
          </div>
        </div>
      <!-- ★ 0930 导入口令输入（子层，仿覆盖确认那套） -->
        <div v-if="passPrompt" class="db-cover">
          <div class="db-cover-box">
            <h4 class="db-cover-title">输入导出口令</h4>
            <p class="db-cover-body">
              这个包里带 {{ sealedCount }} 项密钥（供应商 / 搜索引擎），是用你导出时设的那句口令加密的。<br />
              输入<b>同一句口令</b>即可恢复成这台电脑能用的密钥。口令错的话密钥<b>一个都不会恢复</b>（不会改成半套）。
            </p>
            <div class="db-pass-row mt">
              <input
                v-model="passInput"
                :type="passInputShow ? 'text' : 'password'"
                class="db-pass-input"
                placeholder="导出时设的那句口令"
                autocomplete="off"
                @keyup.enter="passSubmit()"
              />
              <button
                type="button"
                class="db-pass-eye"
                :title="passInputShow ? '隐藏口令' : '显示口令'"
                :aria-label="passInputShow ? '隐藏口令' : '显示口令'"
                @click="passInputShow = !passInputShow"
              >
                <EyeOff v-if="passInputShow" :size="15" :stroke-width="2" />
                <Eye v-else :size="15" :stroke-width="2" />
              </button>
            </div>
            <p v-if="passErr" class="db-err">{{ passErr }}</p>
            <div class="db-btns end">
              <button type="button" class="db-btn ghost" @click="passPrompt = false">取消</button>
              <button type="button" class="db-btn main" :disabled="!passInput.trim()" @click="passSubmit()">导入</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 导出目标文件夹（网页端用；桌面端走系统对话框）—— 层级要压在弹窗之上 -->
    <DirPickerModal v-model:open="dirPicker" initial="" :z="(props.z || 10070) + 20" @select="onDirPicked" />
  </Teleport>
</template>

<style scoped>
.db-mask { position: fixed; inset: 0; z-index: 10070; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.42); }
/* ★1011（老大：导出弹窗太长了）：卡片限高 + 纵向 flex —— 头/口令/脚固定，列表吃剩余高度自己滚。
   旧写法列表是死的 46vh，头+口令+脚一叠加就顶出屏幕（实测 680px 屏直接溢出）。 */
/* ★1011b（老大二次反馈："这一块的高度能不能再收一点"）：上限从"几乎顶满屏"（100vh-36px）
   收到 **最多 500px** —— 大屏不再被拉长，小屏另留 80px 呼吸位；放不下的条目交给列表自己滚。 */
.db-card { position: relative; width: 460px; max-width: calc(100vw - 40px);
  display: flex; flex-direction: column;
  max-height: min(500px, calc(100vh - 80px)); background: #fff; border: 1px solid #f0f0f3; border-radius: 20px; padding: 22px 22px 16px; box-shadow: 0 28px 70px -20px rgba(0, 0, 0, 0.5); }
@keyframes dbIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
/* ── 进出场：遮罩淡入淡出 + 卡片上浮/回落（与「关闭询问」「设置」两处同一套语感）──
   ⚠️ 只动 opacity/transform：别用 backdrop-filter + 全屏 Transition（WebView2 下有过命中测试的坑）。 */
.db-enter-active, .db-leave-active { transition: opacity 0.2s ease; }
.db-enter-from, .db-leave-to { opacity: 0; }
.db-enter-active .db-card { animation: dbIn 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
.db-leave-active .db-card { transition: transform 0.16s cubic-bezier(0.4, 0, 1, 1), opacity 0.16s ease; }
.db-leave-to .db-card { transform: translateY(6px) scale(0.985); opacity: 0; }
@keyframes dbCoverIn { from { opacity: 0; } to { opacity: 1; } }
.db-head { margin-bottom: 10px; flex: 0 0 auto; }
.db-title { font-size: 15.5px; font-weight: 640; color: #111827; margin: 0; }
.db-sub { margin: 5px 0 0; font-size: 12px; line-height: 1.7; color: #6b7280; }
.db-pkg { margin: 6px 0 0; font-size: 11px; color: #9ca3af; word-break: break-all; }
/* 0920（需求）：每条之间留白 —— 旧版行挨着行，一眼看过去像一整块，分不清条目边界。
   用列表容器的 gap 而不是行的 margin，省得首尾多出一份。 */
.db-list { flex: 1 1 auto; min-height: 76px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; display: flex; flex-direction: column; gap: 5px; }
.db-row { display: flex; gap: 9px; align-items: flex-start; padding: 7px 10px; border-radius: 11px; cursor: pointer; transition: background 0.12s ease; }
.db-row:hover { background: #f7f7f9; }
.db-row.on { background: #f3f1fe; }
.db-box { flex: 0 0 auto; width: 16px; height: 16px; margin-top: 1px; border-radius: 5px; border: 1.5px solid #d4d4dd; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #fff; transition: all 0.12s ease; }
.db-box.on { background: #6366f1; border-color: #6366f1; }
.db-text { min-width: 0; flex: 1; }
.db-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #374151; }
.db-tag { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; line-height: 1.6; }
.db-tag.warn { background: #fef2f2; color: #dc2626; }
.db-tag.done { background: #eef2f7; color: #64748b; }
.db-meta { font-size: 10.5px; color: #9ca3af; margin-top: 2px; line-height: 1.6; }
.db-at { color: #a8a8b4; }
.db-empty { padding: 14px; text-align: center; color: #c4c4cc; font-size: 12px; }
.db-needpass { margin: 12px 0 0; padding: 9px 11px; border-radius: 11px; background: #eef4ff; color: #3730a3; font-size: 11.5px; line-height: 1.7; }
/* ★ 0930 导出口令区块：只在勾了含密钥的部分时出现，不占平时的心智负担 */
.db-pass { margin: 10px 0 0; padding: 10px 11px; border-radius: 12px; background: #f7f7f9; flex: 0 0 auto; }
.db-pass.mt { margin-top: 10px; }
.db-pass-label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; }
.db-pass-opt { font-weight: 400; font-size: 11px; color: #9ca3af; margin-left: 4px; }
/* ★1011：口令强度条（4 段）*/
.db-pass-meter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.db-pass-meter-bar { display: flex; flex: 1 1 auto; gap: 4px; }
.db-pass-meter-seg {
  flex: 1 1 0;
  height: 4px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.1);
  transition: background-color 0.2s ease;
}
html.dark .db-pass-meter-seg { background: rgba(255, 255, 255, 0.14); }
.db-pass-meter-seg.is-on.lv-1 { background: #ef4444; }
.db-pass-meter-seg.is-on.lv-2 { background: #f59e0b; }
.db-pass-meter-seg.is-on.lv-3 { background: #eab308; }
.db-pass-meter-seg.is-on.lv-4 { background: #10b981; }
.db-pass-meter-label { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; }
.db-pass-meter-label.lv-1 { color: #ef4444; }
.db-pass-meter-label.lv-2 { color: #f59e0b; }
.db-pass-meter-label.lv-3 { color: #ca8a04; }
.db-pass-meter-label.lv-4 { color: #10b981; }

/* ★1011：口令太弱的即时提示 */
.db-pass-weak {
  margin-top: 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.12);
  color: #b45309;
  font-size: 12px;
  line-height: 1.6;
}
html.dark .db-pass-weak { background: rgba(251, 191, 36, 0.14); color: #fbbf24; }
/* ★1011：口令输入行（输入框 + 显示/隐藏眼睛） */
.db-pass-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.db-pass-row.mt { margin-top: 10px; }
.db-pass-eye {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.db-pass-eye:hover { background: rgba(0, 0, 0, 0.05); color: #111827; }
html.dark .db-pass-eye { border-color: rgba(255, 255, 255, 0.16); color: #9ca3af; }
html.dark .db-pass-eye:hover { background: rgba(255, 255, 255, 0.08); color: #f3f4f6; }
/* ★1011（老大实测截图）：WebView2/Edge 对 type="password" **自带**一个"显示密码"眼睛
   （::-ms-reveal，画在输入框内部右侧），和我们自己加的眼睛（框外）叠在一起 = 两个眼睛。
   隐藏原生的那个；Chromium 系还可能画自动填充/强密码按钮，一并关掉。
   注意：点我们自己的眼睛后 type 变 text，原生按钮本来也会自动消失，逻辑不冲突。 */
.db-pass-input::-ms-reveal,
.db-pass-input::-ms-clear {
  display: none;
}
.db-pass-input::-webkit-credentials-auto-fill-button,
.db-pass-input::-webkit-strong-password-auto-fill-button,
.db-pass-input::-webkit-textfield-decoration-container {
  display: none !important;
  visibility: hidden;
  pointer-events: none;
}
.db-pass-input { width: 100%; height: 34px; padding: 0 11px; border-radius: 10px; border: 1px solid #e2e2e8; background: #fff; color: #111827; font-size: 12.5px; outline: none; transition: border-color 0.15s ease; }
.db-pass-input:focus { border-color: #6366f1; }
.db-pass-tip { margin: 6px 0 0; font-size: 10.5px; line-height: 1.7; color: #9ca3af; }
.db-pass-sum { color: #9ca3af; }
.db-pass-more {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 10.5px;
  color: #6366f1;
  cursor: pointer;
  text-decoration: underline;
}
.db-pass-more:hover { color: #4f46e5; }
.db-pass-tip b { color: #6b7280; font-weight: 600; }
.db-err { margin: 12px 0 0; font-size: 11.5px; line-height: 1.7; color: #dc2626; word-break: break-all; }
.db-info { margin: 12px 0 0; font-size: 11.5px; line-height: 1.7; color: #16a34a; word-break: break-all; }
.db-prog { margin: 12px 0 0; }
.db-prog-bar { height: 4px; border-radius: 999px; background: #eeeef2; overflow: hidden; }
.db-prog-bar span { display: block; height: 100%; background: #6366f1; border-radius: 999px; transition: width 0.35s ease; }
.db-prog-txt { display: block; margin-top: 5px; font-size: 10.5px; color: #9ca3af; }
.db-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; padding-top: 11px; flex: 0 0 auto; border-top: 1px solid #f2f2f5; }
.db-sum { font-size: 11px; color: #9ca3af; }
.db-btns { display: flex; gap: 9px; }
.db-btns.end { justify-content: flex-end; margin-top: 14px; }
.db-btn { height: 34px; padding: 0 16px; border-radius: 10px; font-size: 12.5px; font-weight: 540; border: 1px solid transparent; cursor: pointer; transition: all 0.15s ease; }
.db-btn:disabled { opacity: 0.55; cursor: default; }
.db-btn.ghost { background: transparent; color: #6b7280; }
.db-btn.ghost:not(:disabled):hover { background: #f3f4f6; color: #374151; }
.db-btn.main { background: #000; color: #fff; }
.db-btn.main:not(:disabled):hover { background: rgba(0, 0, 0, 0.82); }
/* 导出打包中：取消按钮**保持可点**（能真中止），给一点红调提示"这里能停" */
.db-btn.ghost.is-stopping { color: #b91c1c; }
.db-btn.ghost.is-stopping:hover { background: #fef2f2; color: #991b1b; }
.db-cover { position: absolute; inset: 0; border-radius: 20px; background: rgba(255, 255, 255, 0.97); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 22px; animation: dbCoverIn 0.16s ease; }
.db-cover-box { width: 100%; }
.db-cover-title { font-size: 14px; font-weight: 640; color: #111827; margin: 0; }
.db-cover-body { font-size: 12px; line-height: 1.75; color: #6b7280; margin: 6px 0 0; }
html.dark .db-card { background: #17171c; border-color: #2a2a33; }
html.dark .db-title, html.dark .db-cover-title { color: #f0f0f4; }
html.dark .db-sub, html.dark .db-cover-body { color: #9a9aa6; }
html.dark .db-row:hover { background: #202027; }
html.dark .db-row.on { background: #23213a; }
html.dark .db-label { color: #d4d4dc; }
html.dark .db-box { border-color: #45454f; }
html.dark .db-foot { border-top-color: #26262e; }
html.dark .db-btn.ghost { color: #9a9aa6; }
html.dark .db-btn.ghost:not(:disabled):hover { background: #26262d; color: #d4d4dc; }
/* 深色下这条 hover 权重(0,5,0)高过上面的 .db-btn.ghost.is-stopping → 必须再压一条 */
html.dark .db-btn.ghost.is-stopping { color: #f87171; }
html.dark .db-btn.ghost.is-stopping:not(:disabled):hover { background: #2c2124; color: #fca5a5; }
html.dark .db-btn.main { background: #f0f0f4; color: #17171c; }
/* ★ 0920（0.0.11）：深色下主按钮的 hover 必须**单独覆盖** ——
   浅色那条 `.db-btn.main:not(:disabled):hover` 的选择器权重(0,4,1)比 `html.dark .db-btn.main`(0,3,1)高
   ⇒ 深色模式悬停时会被刷成 rgba(0,0,0,.82) 半透明黑底，而字色仍是 #17171c
   ⇒ 「导出/导入」按钮一悬停就变成一块几乎看不见的黑方块（截图实锤）。 */
html.dark .db-btn.main:not(:disabled):hover { background: rgba(240, 240, 244, 0.82); }
html.dark .db-cover { background: rgba(23, 23, 28, 0.94); }
html.dark .db-tag.done { background: #23272e; color: #9aa4b2; }
html.dark .db-prog-bar { background: #26262e; }
html.dark .db-pass { background: #202027; }
html.dark .db-pass-label { color: #d4d4dc; }
html.dark .db-pass-input { background: #17171c; border-color: #2f2f38; color: #f0f0f4; }
html.dark .db-pass-tip { color: #7c7c88; }
html.dark .db-pass-tip b { color: #a8a8b4; }
html.dark .db-needpass { background: #1c1f2e; color: #a5b4fc; }
</style>
