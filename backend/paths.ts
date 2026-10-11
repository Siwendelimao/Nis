/**
 * 集中路径定义 —— 打包版路径重定向的唯一入口。
 *
 * 开发态（node --import tsx/esm server.ts）：默认写 backend/data 与 backend/skills。
 * 打包版（Tauri sidecar）：设置 NIS_DATA_DIR / NIS_SKILLS_DIR 环境变量指向用户数据目录
 * （如 %APPDATA%/nis/data 与 %APPDATA%/nis/skills），全部落盘位置随之迁移，代码零改动。
 */
import path from 'node:path'

const BACKEND_DIR = path.resolve(import.meta.dirname)
export const BACKEND_ROOT = BACKEND_DIR

export const DATA_ROOT = process.env.NIS_DATA_DIR
  ? path.resolve(process.env.NIS_DATA_DIR)
  : path.join(BACKEND_DIR, 'data')

export const SKILLS_ROOT = process.env.NIS_SKILLS_DIR
  ? path.resolve(process.env.NIS_SKILLS_DIR)
  : path.join(BACKEND_DIR, 'skills')

/** 项目根（自我修改用）：backend 的父目录。开发态 = E:/nis0812；打包态为资源目录内（只读源码无意义，self-modify 工具集此时退化） */
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..')
