/* familyTool.ts —— 「家族工具」合并壳（0929 工具瘦身·刀①）
 * 思路：家族 = 1 个工具 + `action` 参数；execute **直接派发给原单工具的 execute**（子工具实现原样保留），
 * 逻辑零重写 ⇒ 行为天然等价（"功能不减"的最硬保证）。
 * 参数校验：合并 schema 只强制 `action` 必填；各 action 自己的必填字段在 execute 里校验，
 * 缺了返回人话错误（教模型自己补）——typebox 表达不了"按 action 的 required"，故不在 schema 级强校验。
 * 显示：前端按 (name, args.action) 分流图标/文案（见接线清单），所以 execute 返回的 details 带 action。
 */
import { Type } from 'typebox'

interface FamilyMember {
  /** 动作名（旧工具 bg_start 的 action=start） */
  action: string
  /** 原单工具对象（name/label/description/parameters/execute），execute 会被原样调用 */
  tool: any
  /** 该 action 的必填字段（execute 前校验，缺了给人话错误） */
  required?: string[]
  /** 家族描述里的一行要点（≤30 字，写清何时用） */
  summary: string
}

export function buildFamilyTool(opts: {
  name: string
  label: string
  group: string
  variant: string
  tab?: string
  /** 家族总述：用途 + 何时用 + 行为纪律（硬规矩逐条保留，一句都不丢） */
  description: string
  members: FamilyMember[]
  /** 家族级 risky（审批按 action 判时这里只是登记口径，审批门禁在 server.ts 按 action 分流） */
  risky?: boolean
  /** 是否把每个子工具的完整描述原文内联进家族描述（默认 true=纪律一字不丢）；
   *  子工具描述含大段共享纪律时改 false + 手写家族描述（共享文案只放一份，防 4 倍重复）。 */
  fullMemberDescriptions?: boolean
}): any {
  const { name, label, group, variant, tab, description, members, risky, fullMemberDescriptions = true } = opts
  const byAction = new Map<string, FamilyMember>()
  const props: any = {
    action: Type.String({
      description: '要干哪个活：' + members.map(m => `${m.action}=${m.summary}`).join('；'),
    }),
  }
  for (const m of members) {
    if (byAction.has(m.action)) throw new Error(`familyTool: action 重复 ${m.action}`)
    byAction.set(m.action, m)
    const schemaProps = (m.tool.parameters && (m.tool.parameters as any).properties) || {}
    for (const [k, v] of Object.entries<any>(schemaProps)) {
      if (props[k]) continue   // 同名字段只收一份（如 task_id 多个 action 共用）
      // ⚠️ 必须 Type.Optional 包一层：TypeBox 的 Type.Object 默认把全部字段设为必填 ——
      // 0928 真机实测：不包的话 pi 在 execute 前按 schema 拒调用（"must have required properties ..."），
      // 各 action 的必填校验在 execute 里做（按 action 口径，schema 表达不了）。
      props[k] = Type.Optional({ ...v, description: `（${m.action} 用）${v?.description || ''}` })
    }
  }
  return {
    name,
    label,
    group,
    variant,
    ...(tab ? { tab } : {}),
    ...(risky ? { risky: true } : {}),
    description:
      description
      + (fullMemberDescriptions
          ? members.map(m => `\n【action=${m.action}｜${m.tool.label}】${m.tool.description}`).join('')
          : '\n各 action 一句话：' + members.map(m => `\n· ${m.action}（${m.tool.label}）：${m.summary}${m.required?.length ? `｜必填：${m.required.join('、')}` : ''}`).join('')),
    parameters: Type.Object(props, { description: '家族工具：action 选活，其余字段按所选 action 给（该 action 用不到的字段别给）' }),
    async execute(callId: string, params: any) {
      const action = String((params as any)?.action || '').trim()
      const m = byAction.get(action)
      if (!m) {
        return {
          content: [{ type: 'text', text: `【错误】action「${action}」不认识。可用：${[...byAction.keys()].join(' / ')}（${name} 是家族工具，必须给 action）` }],
          details: { ok: false },
        }
      }
      for (const req of m.required || []) {
        const v = (params as any)?.[req]
        if (v === undefined || v === null || v === '') {
          return {
            content: [{ type: 'text', text: `【错误】action=${action} 需要字段「${req}」——请补上再调一次。` }],
            details: { ok: false, action },
          }
        }
      }
      const r = await m.tool.execute(callId, params)
      // details 带上 action（前端按 name+action 分流图标/文案；原 details 字段全部保留）
      if (r && typeof r === 'object') {
        const d = (r as any).details
        ;(r as any).details = d && typeof d === 'object' ? { ...d, action } : { ok: true, action }
      }
      return r
    },
  }
}
