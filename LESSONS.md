# 教训队列（LESSONS）

本文件只收**付过代价**的教训；规范正文不在这里发明，规则的可执行版本在 [docs/coding-standard.md](docs/coding-standard.md)。

## 晋升规则

- 每条固定四段：**规则 / 触发场景 / 证据 / Seen N×**。Seen 按**不同日期**累计，同一天重复发生只记 1×。
- 同一条教训在 **≥3 个不同日期**再次出现，就晋升进 [docs/coding-standard.md](docs/coding-standard.md)，原条目保留并标注「已晋升」；晋升索引见文末。
- 证据必须可核对：commit / PR / CI job / 测试名。没有证据的观察留在 PR 讨论里，不进本文件。
- 条目按最近发生时间倒序；规则写成下一次可以直接执行的动作。

## L1 迁移版本号只从迁移表长度推导

- **规则**：测试与日志一律引用 `LATEST_VERSION`（= `MIGRATIONS.length`），不得写 `16`、`17` 这类字面量；新增迁移后只改迁移表。
- **触发场景**：PR #1 追加 v17（Agent 表），`src/main/store/db-selftest.ts` 里 5 处 `user_version === 16` 的断言仍写死旧值，测试在真实库上拿到 17。
- **证据**：PR #1（a72c593，2026-11-02）合入 v17；五个平台 job 的 `npm run test:db` 全部失败（提交说明记为 Debian / Windows / macOS）；修复 PR #3（138b80a，待合）导出 `LATEST_VERSION` 并替换 5 处断言。
- **Seen**：1×（2026-11-02）

## L2 新面板按需加载，CSS 预算是硬上限

- **规则**：较重面板首次使用时再动态 `import`，不进入主窗静态闭包；`scripts/check-renderer-bundles.mjs` 的预算不得为了通过而抬高——确实要抬，必须在脚本注释写明决议号并说明为什么无法拆分。
- **触发场景**：Agent 面板静态 `import` 进 `App.vue`，主窗静态 CSS 闭包涨到 141355 字节，超过 `137 KiB`（140288 字节）预算，`npm run build` 末尾的 bundle 检查失败。
- **证据**：PR #1 内 1e9a68e（2026-11-02）改为首次切到 Agent 页签才加载，CSS 回到 133677 字节；预算表未改。
- **Seen**：1×（2026-11-02）

## L3 Windows 的 .cmd 包装器不能再套 `shell: true`

- **规则**：启动外部命令一律 `spawn` + `windowsHide`，禁止 `shell: true`；Windows 的 `.cmd` / `.bat` 显式走 `cmd.exe /d /s /c`，整条命令**再包一层引号**并配 `windowsVerbatimArguments`。
- **触发场景**：Agent CLI 位于 `C:\Program Files\...` 这类带空格路径时，`cmd /s /c` 把未整体加引号的命令拆成多个参数，进程启动失败。
- **证据**：9b4e67d（PR #1 内，2026-11-02）修正 `buildCmdInvocation`；回归测试 `src/main/services/agent/acp-client.test.ts`「Windows cmd 包装器给整条命令再加一层引号」。
- **Seen**：1×（2026-11-02）

## L4 源码结构断言不要锁死 `v-if` 链

- **规则**：UI 结构测试断言行为与契约（页签可达、IPC 接线、关键文案），不要锁 `v-if` / `v-else-if` 的具体分支位置；必须锁模板源码时，先 grep 现有断言并一并更新。
- **触发场景**：Agent 面板接入后 `CabinetPane` 从 `v-if` 改成 `v-else-if`，`src/renderer/src/ui/file-cabinet-panel.test.ts` 的源码断言失败，主分支测试变红。
- **证据**：PR #2（ffdedc6，2026-11-02）一行修正断言；功能本身未变。
- **Seen**：1×（2026-11-02）

## 晋升索引

| 教训 | 晋升目标 | 日期 |
|---|---|---|
| 暂无 | — | — |
