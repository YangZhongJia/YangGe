# Lessons queue (LESSONS)

> [简体中文](LESSONS.md) · **English**

This file only records lessons that **already cost us something**. It never invents standards; the executable version of every rule lives in [docs/en/coding-standard.md](docs/en/coding-standard.md).

## Promotion rule

- Every entry has four fixed parts: **Rule / Trigger / Evidence / Seen N×**. Seen counts **distinct dates**; repeats on the same day count once.
- When the same lesson reappears on **3 or more distinct dates**, promote it into [docs/en/coding-standard.md](docs/en/coding-standard.md), keep the entry here and mark it "promoted"; the index is at the end.
- Evidence must be checkable: commit / PR / CI job / test name. Observations without evidence stay in PR discussion and do not enter this file.
- Entries are newest first; write the rule as the action to take next time.

## L1 Derive the migration version from the migration list only

- **Rule**: Tests and logs reference `LATEST_VERSION` (= `MIGRATIONS.length`); never write literals such as `16` or `17`. Adding a migration changes only the migration list.
- **Trigger**: PR #1 appended v17 (agent tables) while five `user_version === 16` assertions in `src/main/store/db-selftest.ts` still hard-coded the old value, so the real database reported 17.
- **Evidence**: PR #1 (a72c593, 2026-11-02) merged v17; `npm run test:db` failed in all five platform jobs (the commit message names Debian / Windows / macOS); the fix, PR #3 (138b80a, pending merge), exports `LATEST_VERSION` and replaces all five assertions.
- **Seen**: 1× (2026-11-02)

## L2 Load heavy panes on demand; CSS budgets are hard limits

- **Rule**: Load heavier panes with a dynamic `import` on first use instead of the main window's static closure. Never raise a budget in `scripts/check-renderer-bundles.mjs` just to pass; if a raise is truly required, cite the decision number in the script comment and explain why splitting is impossible.
- **Trigger**: The Agent pane was statically imported into `App.vue`, pushing the main window's static CSS closure to 141355 bytes, above the `137 KiB` (140288 byte) budget, so the bundle gate at the end of `npm run build` failed.
- **Evidence**: 1e9a68e inside PR #1 (2026-11-02) loads the pane only after the Agent tab is first opened; CSS returned to 133677 bytes and the budget table stayed unchanged.
- **Seen**: 1× (2026-11-02)

## L3 Windows .cmd wrappers must not add `shell: true`

- **Rule**: Spawn external commands with `spawn` + `windowsHide`, never `shell: true`. On Windows, `.cmd` / `.bat` files go explicitly through `cmd.exe /d /s /c` with the whole command **wrapped in one more pair of quotes** and `windowsVerbatimArguments` set.
- **Trigger**: When an Agent CLI lived under a path with spaces such as `C:\Program Files\...`, `cmd /s /c` split the unquoted command into several arguments and the process failed to start.
- **Evidence**: 9b4e67d (inside PR #1, 2026-11-02) fixed `buildCmdInvocation`; regression test "Windows cmd wrapper adds one more quote layer" in `src/main/services/agent/acp-client.test.ts`.
- **Seen**: 1× (2026-11-02)

## L4 Do not pin source-level structure assertions to a `v-if` chain

- **Rule**: UI structure tests assert behavior and contracts (tab reachability, IPC wiring, key copy), not the position of a `v-if` / `v-else-if` branch. When source-level assertions are unavoidable, grep the existing ones and update them together.
- **Trigger**: After the Agent pane landed, `CabinetPane` moved from `v-if` to `v-else-if`, breaking the source assertion in `src/renderer/src/ui/file-cabinet-panel.test.ts` and turning the main branch red.
- **Evidence**: PR #2 (ffdedc6, 2026-11-02) fixed the assertion in one line; behavior itself did not change.
- **Seen**: 1× (2026-11-02)

## Promotion index

| Lesson | Promoted to | Date |
|---|---|---|
| None yet | — | — |
