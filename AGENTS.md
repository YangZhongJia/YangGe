# AGENTS.md — 阳鸽仓库导航

纯内网、无服务器的局域网即时通讯 + 文件传输桌面端；一套 Electron 22 二进制覆盖 Windows 7 到最新系统。
本文件只做路由，不复制规范正文。与路由到的规范文件冲突时，以规范文件为准。

## 技术栈

- Electron **22.3.27**（精确锁定）· 主进程 / preload 按 **Node 16.17** · 渲染层按 **Chrome 108**
- Vue 3 + Pinia · TypeScript strict · electron-vite 2 + Vite 5
- better-sqlite3 9.6（唯一原生模块，WAL）· vitest 2 · electron-builder 24

## 目录地图

```text
src/main/      主进程：net/（协议、发现、传输） store/（SQLite） services/（编排） windows/
src/preload/   contextBridge 唯一入口，暴露 window.pantry
src/renderer/  Vue UI，五个入口（主窗 / 设置 / 截图 / 看图 / 远程查看）
src/shared/    类型、常量、协议与 IPC 契约；零运行时依赖
src/i18n/      中文源文案 + 英文映射
scripts/       构建、校验、自测、发布辅助
docs/          产品与工程设计（中文为准，英文同步）
```

## 三条红线（不可破）

1. **纯内网**：不新增任何外网请求——更新检查、统计上报、CDN 字体 / 图片、远程 API 全部禁止；断网时必须完整可用。
2. **消息 / 存储兼容**：协议只做加法，未知报文忽略而不是报错；库表变更只增不改语义，旧版本客户端与旧数据库都必须能继续工作。
3. **迁移只增不改**：`src/main/store/migrations.ts` 只追加新迁移，已发布的迁移永不修改；版本号只由迁移表长度决定。

## 五连验证（提交前全绿）

```bash
npm test            # 文档双语校验 + vitest
npm run test:db     # Electron ABI 上的迁移 / repo / FTS
npm run typecheck   # node16 + chrome108 两套类型基线
npm run build       # 三端产物 + renderer bundle 预算
npm run smoke       # 构建后启动并干净退出
```

CI 在五个平台 job（Linux x64 / arm64、Windows x64 / ia32、macOS）重复同一组验证；任一失败不合并。

## 路由表

| 任务 | 读这个 |
|---|---|
| 搭环境、跑脚本、提交前检查、硬约束 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 找扩展点、分层职责、目录细节 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 架构、IPC / 库表契约、CI 与打包 | [docs/tech-design.md](docs/tech-design.md) |
| 写代码时的可检查规则 | [docs/coding-standard.md](docs/coding-standard.md) |
| 这个坑以前踩过吗 | [LESSONS.md](LESSONS.md) |
| 产品范围、优先级、决议记录 | [docs/requirements.md](docs/requirements.md) |
| 线上报文与时序 | [docs/protocol.md](docs/protocol.md) |
| 页面结构与视觉 token | [docs/ui-design.md](docs/ui-design.md) |

改行为时同一 PR 更新中文源与英文版，并跑 `npm run check:docs`。
