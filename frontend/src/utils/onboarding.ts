/* 0915：首次启动引导（Onboarding）状态模块 ——
   · 首启自动弹出：完成/跳过后写入**后端持久化**（localStore → data/ui-state.json），不再打扰；
   · 设置→关于 提供「重新查看新手引导」入口（openOnboarding）；
   · 本模块只管开关与标记，各步骤的数据写入由组件内调用对应 store（不在这里落业务数据）。
   ⚠️ 原先存 localStorage —— 打包版后端端口动态、窗口 origin 每次可能变，
      而 localStorage 按 origin 隔离 → 标记每次启动都读不到 → 引导页反复弹（0915 用户反馈）。
   现在走 localStore（与端口无关，且随数据目录一起备份迁移）。 */
import { reactive } from 'vue'
import { localStore } from '@/utils/localStore'

const KEY = 'nis-onboarded-v1'

export const onboarding = reactive({
  /** 引导层是否展示（App.vue v-if 挂载 OnboardingWizard） */
  visible: false,
})

/** 是否已完成过引导（读取异常时不打扰用户，视为已完成） */
export function isOnboarded(): boolean {
  try {
    return !!localStore.getItem(KEY)
  } catch {
    return true
  }
}

/** 打开引导（首启自动弹出 / 设置里手动重看） */
export function openOnboarding(): void {
  onboarding.visible = true
}

/** 完成或跳过：关闭并落标记（两种语义都置标记，避免反复打扰） */
export function closeOnboarding(): void {
  onboarding.visible = false
  try {
    localStore.setItem(KEY, '1')
    // 引导完成必须**立刻**写透后端，不能被防抖窗口吃掉（否则用户看完就关窗=白看）
    void localStore.flushNow()
  } catch {
    /* ignore */
  }
}
