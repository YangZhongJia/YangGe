# Coding standard (checkable rules)

> [简体中文](../coding-standard.md) · **English**

This file contains only rules that can be judged right or wrong. Each rule names its check: a command or test file where machine-checkable, or what to inspect in review where not.
Priority: the three hard rules ([AGENTS.en.md](../../AGENTS.en.md)) > this file > existing code style > personal preference. Sources of these lessons: [LESSONS.en.md](../../LESSONS.en.md).

## 1. What a change contains

- **C1.1** One PR solves one problem; unrelated refactors, formatting and dependency bumps get their own PR. Check: the PR diff contains no unrelated files.
- **C1.2** A behavior change updates the Chinese source and its English counterpart (`docs/en/`, `*.en.md`) in the same PR, or it is not merged. Machine check: `npm run check:docs`.
- **C1.3** Before adding a dependency, prove the standard library or an existing dependency cannot do it; pin exact versions with `npm i -E`; `engines` must support Node 16; the only allowed native module is better-sqlite3. Check: `package.json` diff + `npm run test:db`.
- **C1.4** Decisions go into the decision record in `docs/requirements.md`, and code comments cite the decision number; no new ADR or CHANGELOG. Check: review.
- **C1.5** No commented-out code, debug output or throwaway scripts; one-off validation lives in `scripts/*-selftest.cjs` and is deleted afterwards. Check: review.
- **C1.6** Do not reorder imports or reformat whole files as a side effect; reviewers must keep a meaningful diff. Check: review.

## 2. Tests

- **C2.1** Pure logic, protocol codecs and storage rules get vitest unit tests in `*.test.ts` next to the source. Machine check: `npm test`.
- **C2.2** Network, discovery and transfer tests bind to `127.0.0.1` only; never send to or broadcast on the real LAN. Check: test code review.
- **C2.3** Changes touching SQLite migrations, repos or FTS must run `npm run test:db` (Electron's built-in ABI 110); vitest is not a substitute. Machine check: `npm run test:db`.
- **C2.4** Fixing a bug starts with a failing test; the PR description shows the fail → pass evidence. Check: PR description + diff.
- **C2.5** External process, filesystem and network boundaries need failure-path cases: timeout, non-zero exit, path escape, malformed packet. Check: the corresponding `*.test.ts`.
- **C2.6** UI structure tests assert behavior and contracts, not the position of a `v-if` / `v-else-if` branch (LESSONS L4). Machine check: `npm test`.

## 3. Acceptance

- **C3.1** All five checks are green before requesting review: `npm test`, `npm run test:db`, `npm run typecheck`, `npm run build`, `npm run smoke`.
- **C3.2** All five CI platform jobs are green: Linux x64 / arm64, Windows x64 / ia32, macOS. Any failure blocks merge.
- **C3.3** Platform-specific changes are smoke-tested on the matching machine or VM: Win7 SP1 x64, Debian 10 / UOS 20, macOS. Check: the PR description records machine and result.
- **C3.4** The PR description always states: what changed, why, how it was verified, which platforms are affected, and how to roll back. Check: review.

## 4. Commits

- **C4.1** Commit subjects use `type(scope): Chinese description`, where `type` is `feat|fix|docs|refactor|test|chore`; the body explains cause and impact. Check: review.
- **C4.2** `package.json` is the single source of the version; the lockfile, release tag and artifact names follow it. When changing it, sync the lockfile and run `npm run check:version`. Check: `npm run check:version`.
- **C4.3** One commit carries one logical change; never mix formatting with behavior. Check: `git show --stat`.
- **C4.4** Never create or push a release tag by hand; CI creates it after all five platform artifacts pass. A tag is not a finished release — artifacts still need target-machine smoke tests.

## 5. Electron runtime baseline

- **C5.1** Electron stays at `22.3.27` with no `^` / `~`; an upgrade PR must first present a Windows 7 support plan. Check: `package.json` and its `build.electronVersion`.
- **C5.2** Main and preload are written for Node 16.17: no global `fetch`, no `structuredClone`, no global `crypto`; networking uses only `net` / `dgram` / `http`. Check: review + `npm run typecheck`.
- **C5.3** The renderer is written for Chrome 108: no native CSS nesting, no Popover API, no `text-wrap: balance`, no subgrid. Check: review.
- **C5.4** Never change the `node16` / `chrome108` build targets in `electron.vite.config.ts`; a target error means the code crossed the line — change the code, not the target. Machine check: `npm run typecheck`, `npm run build`.
- **C5.5** Check new syntax and APIs against Node 16.17 and Chrome 108 support first; type checking covers types, not missing runtime globals. Check: review.

## 6. IPC and preload boundary

- **C6.1** `renderer/` never imports electron or node modules; capabilities arrive only through `window.pantry`. A new capability changes three places together: the type in `src/shared/ipc.ts` → exposure in `src/preload/index.ts` → handler in `src/main/index.ts`. Machine check: search `src/renderer` for `from 'electron'`.
- **C6.2** Channel names come only from `IpcChannels` / `IpcEvents`; no new string-literal channels. Check: review.
- **C6.3** `ipcMain.handle` only validates arguments and forwards; business logic lives in `services/`. Check: review handler bodies.
- **C6.4** preload never exposes `ipcRenderer` itself, nor arbitrary-channel `send` / `invoke`. Check: `src/preload/index.ts`.
- **C6.5** main → renderer events carry only structured-cloneable data; convert `Buffer` / `Date` / `Error` to plain objects first. Check: view types in `src/shared/ipc.ts`.
- **C6.6** Paths, command lines and URLs coming from the renderer are re-validated in main; never trust the renderer. Check: argument validation in the owning service.

## 7. SQLite migrations and ABI

- **C7.1** `MIGRATIONS` only gains new entries; shipped migrations v1–v17 are never edited. Check: the migration array diff only adds.
- **C7.2** The version is defined once from `MIGRATIONS.length`; test assertions reference `LATEST_VERSION`, never a literal (LESSONS L1). Machine check: `npm run test:db`.
- **C7.3** New columns are nullable or have defaults; never drop a column or change its semantics; an old database upgrades in order from any shipped version. Machine check: `npm run test:db`.
- **C7.4** Every new migration is covered in `db-selftest.ts` on two paths: fresh database → latest, and at least one upgrade from an older version. Machine check: `npm run test:db`.
- **C7.5** Migration SQL contains no `BEGIN` / `COMMIT`; `applyMigrations` wraps the transaction. Check: migration text review.
- **C7.6** better-sqlite3 is the only native module; after a version change run `npm run rebuild:electron` and verify ABI 110 with `npm run test:db`.
- **C7.7** Back up the database before importing or migrating user data; a migration never silently deletes user files under `files/`.

## 8. Renderer

- **C8.1** The five UI entries are fixed: `App.vue`, `SettingsApp.vue`, `CaptureApp.vue`, `ImageViewerApp.vue`, `RemoteViewApp.vue`; never add or merge entries. Machine check: `npm run check:renderer-bundles`.
- **C8.2** Heavier panes load with a dynamic `import` on first use and stay out of the shared bootstrap closure; never use `defineAsyncComponent` inside `App.vue` in a way that breaks the manifest entries (LESSONS L2).
- **C8.3** Budgets are hard limits: the shared bootstrap closure is ≤ 200 KiB and per-root static closures use `DEFAULT_ROOT_BUDGETS`; raising a budget requires a decision number and a reason why splitting is impossible in the script comment. Machine check: `npm run build`.
- **C8.4** User-visible Chinese goes through `tr('Chinese source')` string literals with the English entry added to `src/i18n/en.ts`; never build strings around the catalog. Machine check: `src/i18n/coverage.test.ts` (`npm test`).
- **C8.5** Message lists and the contact tree keep the existing virtual scrolling; a new list over 200 rows must be virtualized. Check: review.
- **C8.6** Animations and particles respect `prefers-reduced-motion` and expose a switch. Check: component tests + review.
- **C8.7** Colors, spacing and radii come from `styles/tokens.css` variables; no new hard-coded colors (theme switching depends on the variable table). Check: review.

## 9. Security

- **C9.1** Intranet only: outbound requests, CDNs, remote fonts/images and telemetry are rejected; review a new dependency's install script and runtime network behavior. Check: review + offline smoke test.
- **C9.2** Inbound packets are untrusted input: validate length, type and field whitelists; ignore unknown types instead of throwing. Machine check: `src/main/net/codec.test.ts`.
- **C9.3** Received paths pass through `sanitizeRelPath` plus a realpath containment check before writing; absolute paths, drive letters and `..` are rejected. Machine check: `src/main/util/sanitize.test.ts` + transfer tests.
- **C9.4** Logs and diagnostic exports contain whitelisted fields only: no message bodies, file paths, plaintext IPs or credentials. Machine check: `npm run test:diagnostics`.
- **C9.5** BrowserWindows keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; block `will-navigate` and `window.open`; CSP may only tighten. Check: `src/main/index.ts`, `src/renderer/index.html`.
- **C9.6** Credentials never enter the database, logs or exports; admin passwords are stored as hashes only. Check: review.

## 10. Packaging matrix

- **C10.1** Packaging configuration lives only in `package.json` `build` and `.github/workflows/release.yml`; changes to those or to `scripts/ci-install-linux.sh` must clear [CONTRIBUTING "PR stop conditions"](../../CONTRIBUTING.en.md#pr-stop-conditions) first.
- **C10.2** Matrix: Windows `nsis` + `portable` (x64 + ia32); Linux `deb` + `AppImage` (x64 + arm64, Debian 10 / UOS 20 baseline); macOS `dmg` + `zip` (arm64 + x64).
- **C10.3** `asar: true` with `better_sqlite3.node` unpacked; Linux packaging sets `USE_HARD_LINKS=false`; packaged GLIBC symbols stay at or below 2.28. Machine check: CI packaging jobs.
- **C10.4** `appId`, `productName` and install paths stay ASCII; display names use NSIS `shortcutName`, desktop `Name` and `CFBundleDisplayName`. Check: packaging config + artifact paths.
- **C10.5** The version has a single source, `package.json`; artifact names contain `${version}`; ship a SHA-256 manifest alongside artifacts. Machine check: `npm run check:version`.
