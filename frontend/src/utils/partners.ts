/**
 * 伙伴显示层映射 —— 后端仍用英文标识（Luna / WebSurfer ...），前端统一显示中文。
 *
 * 风格：抽象分工风，如 代码大师 - 露娜、画师 - 李柳、严格审查员 - 哩蛋。
 * 头像：办公室 chibi 角色静态图（public/partners/*.png，由 Spine 渲染导出）。
 * 后期升级伙伴管理页时会提供「改备注」，届时改这里即可全局生效。
 */

interface PartnerProfile {
  /** 中文显示名 */
  name: string
  /** 分工角色标签 */
  role: string
  /** 一句简介（成员弹窗选择页 / 悬停 tooltip 展示） */
  desc: string
  /** 头像图片路径（chibi 角色），无则用首字符圆形占位 */
  image?: string
}

const IMG = (skin: string) => `/partners/${skin}.png`

export const PARTNER_PROFILES: Record<string, PartnerProfile> = {
  Luna: { name: '露娜', role: '代码大师', desc: '代码实现专家。负责编写、调试和优化代码实现，精通 Python/TypeScript/Java/Rust/Go', image: IMG('misaki') },
  WebSurfer: { name: '阿浪', role: '搜索专员', desc: '网络搜索与信息调研专家。负责搜索互联网信息、调研技术方案、收集资料和文档', image: IMG('nate') },
  Auditor: { name: '哩蛋', role: '严格审查员', desc: '代码审计与质量检查专家。负责代码审查、质量评估、规范检查、技术债务分析', image: IMG('spineboy') },
  'MCP Expert': { name: '阿控', role: '系统操控手', desc: '计算机操作专家。通过 MCP 协议操作电脑、浏览器和系统工具，支持截图、窗口控制、剪贴板', image: IMG('soeren') },
  'Frontend Expert': { name: '小前', role: '前端工程师', desc: '资深前端开发工程师。负责 Web 界面开发、交互设计、性能优化和工程化建设', image: IMG('erikari') },
  DocAuthor: { name: '文青', role: '文档作家', desc: '技术文档编写专家。负责撰写 README、API 文档、设计文档、用户手册等技术文档', image: IMG('harri') },
  TestPilot: { name: '吴测', role: '测试飞行员', desc: '测试专家。负责编写单元测试、集成测试、端到端测试，以及测试覆盖率分析', image: IMG('sinisa') },
  VisualPainter: { name: '李柳', role: '画师', desc: '视觉设计与图片生成专家。负责生成图表、UI 原型、设计素材，以及数据可视化', image: IMG('mario') },
  SysDoctor: { name: '郑医', role: '系统医生', desc: '系统诊断专家。负责排查系统问题、分析错误日志、诊断性能瓶颈、检查服务状态', image: IMG('luke') },
  SecurityGuard: { name: '铁盾', role: '安全卫士', desc: '安全扫描专家。负责代码安全审计、漏洞扫描、依赖安全检查、权限分析', image: IMG('spineboy') },
  GitKeeper: { name: '库守', role: '版本管家', desc: 'Git 版本控制专家。负责代码提交、分支管理、合并冲突解决、版本发布', image: IMG('sinisa') },
  AutoBrowser: { name: '小览', role: '网页舵手', desc: '浏览器自动化专家。负责网页操作、表单填写、数据抓取、页面截图', image: IMG('nate') },
  MediaWizard: { name: '影灵', role: '媒体术士', desc: '媒体处理专家。负责视频转码、音频处理、图片压缩、格式转换', image: IMG('mario') },
  RequirementAuditor: { name: '严标', role: '需求审计', desc: '需求审计专家。负责需求分析、优先级评估、可行性分析、风险识别', image: IMG('erikari') },
  OpenSourceHunter: { name: '猎源', role: '开源猎手', desc: '开源方案调研专家。负责寻找开源项目、评估技术选型、对比框架方案、分析社区活跃度', image: IMG('soeren') },
  // 系统事件发送者（无 chibi 头像，回退首字符占位）
  Session: { name: '会话', role: '对话记录', desc: '对话记录系统事件源' },
  Distiller: { name: '提炼', role: '记忆提炼', desc: '记忆提炼系统事件源' },
  // 通用子代理（未匹配到项目伙伴时的默认身份）
  SubAgent: { name: '子代理', role: '执行专员', desc: 'NIS 派发的通用子代理，在独立上下文中执行被指派的任务' },
}





/** 取某英文标识对应的一句简介，未映射返回空 */
export function partnerDesc(sender: string): string {
  return PARTNER_PROFILES[sender]?.desc || ''
}




