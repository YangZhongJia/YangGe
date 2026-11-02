# AGENTS.md — YangGe repository map

> [简体中文](AGENTS.md) · **English**

An intranet-only, serverless LAN messenger and file-transfer desktop app; one Electron 22 binary covers Windows 7 through current systems.
This file is routing only and does not restate the standards. If it conflicts with a routed document, that document wins.

## Stack

- Electron **22.3.27** (pinned) · main / preload written for **Node 16.17** · renderer written for **Chrome 108**
- Vue 3 + Pinia · TypeScript strict · electron-vite 2 + Vite 5
- better-sqlite3 9.6 (the only native module, WAL) · vitest 2 · electron-builder 24

## Repository map

```text
src/main/      Main process: net/ (protocol, discovery, transfer), store/ (SQLite), services/ (orchestration), windows/
src/preload/   The only contextBridge entry, exposes window.pantry
src/renderer/  Vue UI with five entries (main / settings / capture / image viewer / remote view)
src/shared/    Types, constants, protocol and IPC contracts; zero runtime dependencies
src/i18n/      Chinese source strings plus the English map
scripts/       Build, validation, self-test and release helpers
docs/          Product and engineering design (Chinese canonical, English kept in sync)
```

## Three hard rules (never broken)

1. **Intranet only**: no new outbound requests — update checks, telemetry, CDN fonts/images and remote APIs are all forbidden; the app must remain fully usable offline.
2. **Message / storage compatibility**: protocol changes are additive and unknown packets are ignored rather than rejected; schema changes never alter existing semantics, and both old clients and old databases must keep working.
3. **Migrations are append-only**: `src/main/store/migrations.ts` only gains new entries; a shipped migration is never edited, and the version is derived solely from the migration list length.

## The five-command check (all green before delivery)

```bash
npm test            # doc locale check + vitest
npm run test:db     # migrations / repos / FTS on the Electron ABI
npm run typecheck   # node16 + chrome108 type baselines
npm run build       # all three bundles + renderer budget gate
npm run smoke       # build, launch, exit cleanly
```

CI repeats the same set in five platform jobs (Linux x64 / arm64, Windows x64 / ia32, macOS); any failure blocks merge.

## Routing table

| Task | Read this |
|---|---|
| Setup, scripts, pre-delivery checks, hard constraints | [CONTRIBUTING.en.md](CONTRIBUTING.en.md) |
| Extension points, layering, directory details | [DEVELOPMENT.en.md](DEVELOPMENT.en.md) |
| Architecture, IPC / database contracts, CI and packaging | [docs/en/tech-design.md](docs/en/tech-design.md) |
| Checkable rules while writing code | [docs/en/coding-standard.md](docs/en/coding-standard.md) |
| Has this pitfall bitten us before? | [LESSONS.en.md](LESSONS.en.md) |
| Product scope, priorities, decision records | [docs/en/requirements.md](docs/en/requirements.md) |
| Wire messages and sequences | [docs/en/protocol.md](docs/en/protocol.md) |
| Page structure and visual tokens | [docs/en/ui-design.md](docs/en/ui-design.md) |

When behavior changes, update the Chinese source and its English counterpart in the same PR and run `npm run check:docs`.
