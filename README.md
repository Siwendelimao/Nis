# NIS · 你的私有 AI 工作台

**简体中文** · [English](README.en.md)

> **装在自己机器上的 AI 工作台** —— 长期记忆 + 知识库 + 完整工具链，桌面端、手机网页、QQ / 微信多端接入。

NIS（中文名「纽斯」）不是又一个聊天框。它把「AI 记得住你、能真的动手干活、走到哪都能叫到它」这三件事凑齐了：

- 🧠 **长期记忆 + 知识库** —— 四层记忆架构，对话、资料、项目沉淀成可检索的长期上下文（不是每次重头讲一遍）
- 🛠 **能干活的 Agent** —— 文件读写、命令行、浏览器操作、定时任务、多分身并行，带权限分级与文件历史（可回滚）
- 📱 **多端接入** —— 桌面端 + 手机网页同源；可选接入 QQ / 微信机器人，让它在群里 / 私聊里替你值班
- 🔌 **自带你的模型** —— 兼容任意 OpenAI 协议供应商（OpenAI、DeepSeek、通义、Kimi、LongCat、本地 Ollama…），也可以接 Codex / ACP 这类外部 Agent
- 🗂 **项目工作区** —— 按项目组织对话，Agent 在项目目录里干活，产出与下载各归各位
- 🔒 **数据在你自己手里** —— 会话、记忆、密钥全部存在本机；API Key 本地加密落盘（Windows DPAPI）

---

## 快速开始

### 方式一：用安装包（推荐普通用户）

1. 到 [Releases](../../releases) 下载 `NIS_Setup_x.x.x_x64.exe`
2. 双击安装（当前用户安装，无需管理员）
3. 打开 NIS → 设置 → 供应商，填入你自己的 API Key（或选一个免费模型）
4. 开始对话

> **当前仅支持 Windows 10/11**（桌面端基于 Tauri 2 + WebView2，密钥加密用 Windows DPAPI）。

### 方式二：从源码跑（开发者）

```bash
# 需要：Node.js 20+（推荐 22）、pnpm；想要记忆内核还需要 Python 3.10+

git clone <本仓库地址>
cd NIS

# 前端（Vue 3 + Vite）
cd frontend && pnpm install && cd ..

# 后端（Node + TypeScript）
cd backend && pnpm install && cd ..

# 一条命令起前后端（前端 5174 / 后端 8766）
pnpm dev
```

打开 `http://127.0.0.1:5174` 即可。手机接入：让手机和电脑在同一局域网，用你的内网 IP 访问 `http://<内网IP>:5174`。

**打包安装包**（Windows）：

```cmd
cd setup
build.cmd          :: 一键：前端构建 + Rust 编译 + 组装单文件安装器 → ..\exports\
```

> ⚠️ 打包请**在普通终端里跑**，不要在带沙箱注入的 AI shell 里跑 —— 沙箱 DLL 会拖慢 cargo/rustc 一个数量级。

---

## 配置

运行期配置都在数据目录（开发态 = `backend/data/`，安装版 = `%APPDATA%\nis\data\`）：

| 文件 | 内容 | 模板 |
| --- | --- | --- |
| `providers.json` | 模型供应商与 API Key | `examples/providers.example.json` |
| `channels.json` | QQ / 微信 / 远程访问通道 | `examples/channels.example.json` |
| `settings.json` | 界面与行为设置 | 界面里改即可 |
| `sessions/` | 会话记录（含工具调用、用量） | 不建议手改 |

**推荐用界面配置**（设置 → 供应商 / 接入），手改 JSON 前请先备份。

---

## 项目结构

```
frontend/          Vue 3 + Vite 前端（桌面壳在 src-tauri/，Tauri 2）
backend/           Node + TypeScript 后端（HTTP + SSE，端口 8766）
  channels/        QQ / 微信 / 远程通道适配
  memory-kernel/   Python 记忆内核（可选，随包自带）
setup/             单文件安装器（Tauri 壳 + NSIS 引擎组装）
examples/          配置模板
```

---

## 常见问题

**Q：一定要 API Key 吗？**
要。NIS 不自带模型额度，你用哪家模型就配哪家的 Key（也可以接本地 Ollama，完全离线）。

**Q：记忆内核必须要 Python 吗？**
不做语义记忆检索可以不要；要完整记忆/知识库功能建议装 Python 3.10+。

**Q：支持 macOS / Linux 吗？**
目前只测过 Windows。代码里只有少量 Windows 专属部分（密钥加密、托盘、安装器），欢迎 PR 补平台适配。

**Q：我的数据会被上传吗？**
不会。会话、记忆、文件都在本机；只有你自己配置的模型 API 会被调用。

---

## 许可证

本项目以 [MIT License](LICENSE) 开源。

第三方开源组件的完整清单与许可信息见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，程序内「设置 → 关于」也能查看。

特别说明：界面动画使用了 GSAP（GreenSock 自定义 "no charge" 许可，允许商用，但不得转售其本身或用于开发竞品）；`jszip` 采用 `MIT OR GPL-3.0-or-later` 双许可，本项目选择 MIT 条款。

## 关于这个项目

NIS 由 **斯文的狸猫** 与 AI 助手 **Nis** 协作完成 —— 产品定位、架构决策、验收标准与取舍由人拍板；代码实现、问题排查与文档有大量 AI 参与。**产品名 NIS，就取自这位搭档的名字。**

## 致谢

感谢所有开源作者。没有 Vue、Tauri、Node、Python 生态，就没有这个项目。
