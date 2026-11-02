# 编码规范（可检查项）

本文件只写能判定对错的规则。每条末尾标注检查方式：能机检的给命令或测试文件名，不能机检的写 review 时要看什么。
优先级：三条红线（[AGENTS.md](../AGENTS.md)）> 本文件 > 既有代码风格 > 个人偏好。教训来源见 [LESSONS.md](../LESSONS.md)。

## 1. 改动包含什么

- **C1.1** 一个 PR 只解决一个问题；无关重构、格式化、依赖升级拆成独立 PR。检查：PR diff 是否混入无关文件。
- **C1.2** 行为变化必须在同一 PR 更新中文源与英文版（`docs/en/`、`*.en.md`），否则不合入。机检：`npm run check:docs`。
- **C1.3** 新增依赖前先证明标准库或现有依赖做不到；用 `npm i -E` 精确锁版本；`engines` 必须兼容 Node 16；原生模块只允许 better-sqlite3。检查：`package.json` diff + `npm run test:db`。
- **C1.4** 决策写入 `docs/requirements.md` 的决议记录，代码注释引用决议号；不新增 ADR / CHANGELOG。检查：review。
- **C1.5** 不提交注释掉的代码、调试输出、临时脚本；一次性验证放 `scripts/*-selftest.cjs`，用完删除。检查：review。
- **C1.6** 不顺手重排 import 或全文件格式化，避免 reviewer 丢失有效 diff。检查：review。

## 2. 测试

- **C2.1** 纯逻辑、协议编解码、存储规则加 vitest 单测，与被测文件同目录 `*.test.ts`。机检：`npm test`。
- **C2.2** 网络 / 发现 / 传输用例只绑定 `127.0.0.1`，绝不向真实局域网发包或广播。检查：测试代码 review。
- **C2.3** 触及 SQLite 迁移、repo、FTS 必须跑 `npm run test:db`（Electron 内置 ABI 110）；vitest 不能替代。机检：`npm run test:db`。
- **C2.4** 修复 bug 先写一条会失败的测试，再改实现；PR 描述给出失败 → 通过的证据。检查：PR 描述 + diff。
- **C2.5** 外部进程、文件系统、网络边界必须有失败路径用例：超时、非零退出、路径逃逸、坏报文。检查：对应 `*.test.ts`。
- **C2.6** UI 结构测试断言行为与契约，不锁 `v-if` / `v-else-if` 分支位置（LESSONS L4）。机检：`npm test`。

## 3. 验收

- **C3.1** 五连验证全绿才能请求评审：`npm test`、`npm run test:db`、`npm run typecheck`、`npm run build`、`npm run smoke`。
- **C3.2** CI 五个平台 job 全绿：Linux x64 / arm64、Windows x64 / ia32、macOS。任一失败不合入。
- **C3.3** 平台相关改动在对应真机 / VM 冒烟：Win7 SP1 x64、Debian 10 / UOS 20、macOS。检查：PR 描述记录机器与结果。
- **C3.4** PR 描述固定写：改了什么、为什么、怎么验证、影响哪些平台、如何回滚。检查：review。

## 4. 提交

- **C4.1** 提交信息 `type(scope): 中文描述`，`type` ∈ `feat|fix|docs|refactor|test|chore`；正文写原因与影响面。检查：review。
- **C4.2** 版本号以 `package.json` 为唯一来源，lockfile、release tag、产物名都跟随它；改版本时同步 lockfile 并跑 `npm run check:version`。检查：`npm run check:version`。
- **C4.3** 一个 commit 一个逻辑改动，不混格式化与功能改动。检查：`git show --stat`。
- **C4.4** 不手工创建或推送 release tag；tag 由 CI 在五平台产物通过后创建。tag 不等于发布完成，产物仍需目标机冒烟。

## 5. Electron 运行时基线

- **C5.1** Electron 固定 `22.3.27`，不加 `^` / `~`；升级 PR 必须先给出 Windows 7 支持方案。检查：`package.json` + `package.json` 的 `build.electronVersion`。
- **C5.2** 主进程 / preload 按 Node 16.17 写：无全局 `fetch`、无 `structuredClone`、无全局 `crypto`；网络只用 `net` / `dgram` / `http`。检查：review + `npm run typecheck`。
- **C5.3** 渲染层按 Chrome 108 写：无原生 CSS 嵌套、无 Popover API、无 `text-wrap: balance`、无 subgrid。检查：review。
- **C5.4** 不改 `electron.vite.config.ts` 的 `node16` / `chrome108` 构建目标；目标报错说明写法越线，改写法而不是放宽目标。机检：`npm run typecheck`、`npm run build`。
- **C5.5** 新语法 / API 先查 Node 16.17 与 Chrome 108 支持表；类型检查只覆盖类型，不覆盖运行时缺失。检查：review。

## 6. IPC 与 preload 边界

- **C6.1** `renderer/` 不 import electron / node 模块，能力只经 `window.pantry`。新增能力三处同改：`src/shared/ipc.ts` 类型 → `src/preload/index.ts` 暴露 → `src/main/index.ts` handler。机检：在 `src/renderer` 搜索 `from 'electron'`。
- **C6.2** 通道名只能来自 `IpcChannels` / `IpcEvents`，不新增字符串字面量通道。检查：review。
- **C6.3** `ipcMain.handle` 只做入参校验与转发；业务逻辑写在 `services/`。检查：review handler 函数体。
- **C6.4** preload 不暴露 `ipcRenderer` 本体，也不提供任意 channel 的 `send` / `invoke`。检查：`src/preload/index.ts`。
- **C6.5** main → renderer 事件只传可结构化克隆的数据；`Buffer` / `Date` / `Error` 先转普通对象。检查：`src/shared/ipc.ts` 的视图类型。
- **C6.6** 来自渲染层的路径、命令行、URL 在 main 侧重新校验，不信任 renderer。检查：对应 service 的入参校验。

## 7. SQLite 迁移与 ABI

- **C7.1** `MIGRATIONS` 只追加新条目；已发布的 v1–v17 永不修改。检查：迁移数组 diff 只应新增。
- **C7.2** 版本号只由 `MIGRATIONS.length` 定义一次；测试断言引用 `LATEST_VERSION`，不写字面量（LESSONS L1）。机检：`npm run test:db`。
- **C7.3** 新增列必须有默认值或可空；不删列、不改列语义；旧库能从任意已发布版本顺序升到最新。机检：`npm run test:db`。
- **C7.4** 每个新迁移在 `db-selftest.ts` 覆盖两条路径：全新库 → 最新，以及至少一个旧版本升级。机检：`npm run test:db`。
- **C7.5** 迁移 SQL 内不写 `BEGIN` / `COMMIT`，事务由 `applyMigrations` 统一包裹。检查：迁移文本 review。
- **C7.6** better-sqlite3 是唯一原生模块；版本变更后跑 `npm run rebuild:electron`，并在 `npm run test:db` 验证 ABI 110。
- **C7.7** 导入或迁移用户数据前先备份数据库；迁移不得静默删除 `files/` 下的用户文件。

## 8. 渲染层

- **C8.1** 五个 UI 入口固定：`App.vue`、`SettingsApp.vue`、`CaptureApp.vue`、`ImageViewerApp.vue`、`RemoteViewApp.vue`；不新增或合并入口。机检：`npm run check:renderer-bundles`。
- **C8.2** 较重面板首次使用时动态 `import`，不进入公共启动闭包；禁止在 `App.vue` 内用 `defineAsyncComponent` 破坏 manifest 入口（LESSONS L2）。
- **C8.3** 预算硬上限：公共启动闭包 ≤ 200 KiB，各根组件静态闭包见脚本 `DEFAULT_ROOT_BUDGETS`；抬预算必须在脚本注释写明决议号与无法拆分的原因。机检：`npm run build`。
- **C8.4** 用户可见中文走 `tr('中文源')` 字面量，英文补 `src/i18n/en.ts`；不拼字符串绕过词条。机检：`src/i18n/coverage.test.ts`（`npm test`）。
- **C8.5** 消息列表与联系人树沿用既有虚拟滚动；新增长列表超过 200 行必须虚拟化。检查：review。
- **C8.6** 动画与粒子尊重 `prefers-reduced-motion`，并提供开关。检查：组件测试 + review。
- **C8.7** 颜色、间距、圆角走 `styles/tokens.css` 变量，不新增硬编码颜色（主题换装依赖变量表）。检查：review。

## 9. 安全

- **C9.1** 纯内网：新增出站请求、CDN、远程字体 / 图片、遥测一律拒绝；新依赖要审查 install script 与运行时网络行为。检查：review + 断网冒烟。
- **C9.2** 入站报文按不可信输入处理：长度、类型、字段白名单；未知类型忽略而不是抛错。机检：`src/main/net/codec.test.ts`。
- **C9.3** 接收路径必须过 `sanitizeRelPath`，落盘前再做 realpath 包含检查；拒绝绝对路径、盘符与 `..`。机检：`src/main/util/sanitize.test.ts` + 传输用例。
- **C9.4** 日志与诊断导出只写白名单字段：不写消息正文、文件路径、IP 明文、凭据。机检：`npm run test:diagnostics`。
- **C9.5** BrowserWindow 保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；拦截 `will-navigate` 与 `window.open`；CSP 只收紧不放宽。检查：`src/main/index.ts`、`src/renderer/index.html`。
- **C9.6** 凭据不入库、不进日志、不导出；管理密码只存哈希。检查：review。

## 10. 打包矩阵

- **C10.1** 打包配置只在 `package.json` 的 `build` 与 `.github/workflows/release.yml`；改这两处或 `scripts/ci-install-linux.sh` 前先过 [CONTRIBUTING「PR 停审条件」](../CONTRIBUTING.md#pr-停审条件)。
- **C10.2** 矩阵：Windows `nsis` + `portable`（x64 + ia32）；Linux `deb` + `AppImage`（x64 + arm64，Debian 10 / UOS 20 基线）；macOS `dmg` + `zip`（arm64 + x64）。
- **C10.3** `asar: true` 且 `better_sqlite3.node` 必须 `asarUnpack`；Linux 打包 `USE_HARD_LINKS=false`；包内 GLIBC 符号不超过 2.28。机检：CI 打包 job。
- **C10.4** `appId`、`productName`、安装路径保持 ASCII；显示名走 NSIS `shortcutName`、desktop `Name`、`CFBundleDisplayName`。检查：打包配置 + 产物路径。
- **C10.5** 版本号单一来源 `package.json`；产物名含 `${version}`；随产物产出 SHA-256 清单。机检：`npm run check:version`。
