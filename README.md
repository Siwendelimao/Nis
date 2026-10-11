# NIS 项目（nis 0812）

前后端一体目录，避免多副本散落。

## 接手必读

- 最新交接文档：`docs/handover/HANDOVER-0901.md`（含历史交接文档与"铁律"汇总，旧轮次文档在同目录）
- 本目录自 2026-09-01 起用 git 管理：改动前先看 `git log`，改完提交，别再散落 restore/fix 一次性脚本

## 目录结构

| 目录 | 内容 | 说明 |
|---|---|---|
| `frontend/` | **前端**（原 nis-ui，Vue 3 + Vite + Tauri） | 端口 `5174`，包管理用 pnpm |
| `backend/` | **后端**（原 pi-bridge，DSH 前端 ↔ Pi Agent ↔ LongCat 桥接） | 端口 `8766`（HTTP API + SSE），包管理用 npm |
| `backend/scripts/archive/` | 历史 fix/restore 一次性脚本 | 仅存档，别执行，别新增 |
| `docs/` | 技术债、方案文档、交接文档 | |
| `package.json` | 根启动清单 | `concurrently` 一键起前后端 |

## 启动

```bash
# 首次：分别装依赖
cd frontend && pnpm install && cd ..
cd backend && npm install && cd ..
npm install   # 根的 concurrently

# 一条命令启动全部（前端 5174 + 后端 8766）
npm run dev

# 或分开启动
npm run dev:app      # 只起前端
npm run dev:server   # 只起后端
```

## 架构速览

```
浏览器 (5174, frontend/)
    │  HTTP /api/{method} + SSE /api/events.mux
    ▼
pi-bridge (8766, backend/server.ts)
    │  pi-agent-core Agent
    ▼
LongCat LLM（流式）

会话工作区：创建聊天时在设置储存目录下建 chat_<时间戳> 子目录，
产出/下载默认落这里；项目会话用项目 root_path。
```

## 备份说明

- 本目录是唯一活跃开发副本，git 历史即版本记录（`git log` 查看每次变更）
- 历史 handover 快照：`docs/handover/`；清理前的完整目录备份：`E:\nis0812-backup-0901-preClean`
- 旧位置仅作历史备份，不再更新：
  - 前端旧路径 `E:\nis-h-v1.0\NIs UI 4.0\nis-ui`
  - 后端旧路径 `E:\nis+gork\pi-bridge`
