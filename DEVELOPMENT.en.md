# Development guide

> [简体中文](DEVELOPMENT.md) · [English](DEVELOPMENT.en.md)

This guide describes the Teahouse codebase, process boundaries, data flow, and the safest starting point for common extensions.

- Product overview and installation: [README](README.en.md)
- Setup, hard constraints, testing, and packaging: [Contributing](CONTRIBUTING.en.md)
- Current architecture and extension points: this document

Teahouse is a serverless, IP-based LAN messenger and file-transfer application. Every client is an equal peer and all runtime data stays on the local network.

## Technology stack

| Area | Technology | Notes |
|---|---|---|
| Desktop runtime | **Electron 22.3.27** | Exact pin; final major version supporting Windows 7 |
| Renderer | **Vue 3** and **Pinia** | Compiled for Chrome 108 |
| Language | **TypeScript 5.6**, strict mode | Shared across main, preload, and renderer code |
| Storage | **better-sqlite3 9.6**, WAL | The only native dependency |
| Build | **electron-vite 2** and **Vite 5** | Separate main, preload, and renderer bundles |
| Tests | **Vitest 2** | Pure units plus loopback network integration |
| Packaging | **electron-builder 24** | NSIS, portable, deb, AppImage, dmg, and zip |
| Local OCR | **PaddleOCR PP-OCRv6 tiny** and **onnxruntime-web 1.20.1** | Model and WASM assets are bundled locally |

## Runtime baselines

- Main and preload processes run on **Node 16.17**. Global `fetch` and `structuredClone` are unavailable.
- Renderer processes run on **Chrome 108**. Native CSS nesting, Popover, `text-wrap: balance`, and subgrid are unavailable.
- `electron.vite.config.ts` fixes these targets at `node16` and `chrome108`.

Review the [hard constraints](CONTRIBUTING.en.md#hard-constraints) before changing runtime code or dependencies.

## Process model

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer processes — Chrome 108, Vue 3, Pinia            │
│ Main UI / Settings / Capture / Image viewer              │
│ Display and interaction; state projects the main process │
└────────────────────────────┬─────────────────────────────┘
                             │ window.pantry only
                             │ contextBridge in preload
┌────────────────────────────┴─────────────────────────────┐
│ Main process — Node 16.17                                │
│ net/       discovery, messaging, transfer                │
│ store/     SQLite repositories and full-text search      │
│ services/  use-case orchestration                        │
│ windows/   tray and auxiliary windows                    │
│ index.ts   assembly, IPC validation, desktop integration │
└──────────────────────────────────────────────────────────┘
```

The dependency rules are strict:

1. Renderer code imports no Electron or Node runtime module. It calls capabilities exposed through `window.pantry`.
2. `net/` and `store/` have no Electron dependency and do not depend on each other.
3. Business orchestration belongs in `services/`. IPC handlers validate parameters and forward calls.
4. `shared/` contains dependency-free types and constants.

## Repository map

```text
pantry/
├─ src/
│  ├─ shared/
│  │  ├─ protocol.ts       # Wire types and constants
│  │  ├─ ipc.ts            # PantryApi contract
│  │  ├─ pk.ts             # Rock-paper-scissors and dice data
│  │  └─ compat-emoji.ts   # Local emoji compatibility map
│  ├─ preload/
│  │  └─ index.ts          # The only contextBridge entry
│  ├─ main/
│  │  ├─ index.ts          # Assembly, IPC handlers, system integration
│  │  ├─ notifications.ts  # Desktop notifications
│  │  ├─ net/
│  │  │  ├─ codec.ts       # JSON codec and inbound allowlist validation
│  │  │  ├─ udp.ts         # UDP transport, broadcast, and limits
│  │  │  ├─ discovery.ts   # Entry, exit, heartbeat, gossip, probing
│  │  │  ├─ messenger.ts   # Reliable delivery and retry queues
│  │  │  ├─ transfer.ts    # Pull-based TCP file data plane
│  │  │  ├─ frame.ts       # TCP control and long-message frames
│  │  │  ├─ cidr.ts        # CIDR range calculations
│  │  │  ├─ peer-registry.ts
│  │  │  ├─ peer-clock.ts
│  │  │  └─ range-sync.ts
│  │  ├─ store/
│  │  │  ├─ db.ts          # SQLite WAL connection
│  │  │  ├─ migrations.ts  # Append-only user_version migrations
│  │  │  ├─ *-repo.ts      # Peer, conversation, message, queue, group, transfer, share repositories
│  │  │  ├─ fts.ts         # Chinese character-level full-text search
│  │  │  ├─ app-state.ts   # Identity and local configuration
│  │  │  └─ db-selftest.ts
│  │  ├─ services/
│  │  │  ├─ chat.ts        # Private messaging
│  │  │  ├─ groups.ts      # Discussion groups
│  │  │  ├─ files.ts       # Files, folders, images, and transfer offers
│  │  │  ├─ share.ts       # Shared file cabinet permissions and browsing
│  │  │  ├─ search.ts      # Search orchestration
│  │  │  ├─ forward.ts     # Message forwarding
│  │  │  ├─ porter.ts      # .pantry-bak export and import
│  │  │  └─ image-ocr-cache.ts
│  │  ├─ util/             # Pure path, archive, formatting, and write helpers
│  │  └─ windows/          # Tray, Settings, Capture, and Image viewer windows
│  └─ renderer/
│     ├─ src/
│     │  ├─ main.ts        # Hash-based routing to four renderer roots
│     │  ├─ App.vue        # Main window and three main tabs
│     │  ├─ SettingsApp.vue
│     │  ├─ CaptureApp.vue
│     │  ├─ ImageViewerApp.vue
│     │  ├─ stores/        # Pinia projections of main-process state
│     │  ├─ components/    # Chats, contacts, groups, transfers, cabinet UI
│     │  ├─ utils/         # Clipboard, emoji, time, avatar, and OCR helpers
│     │  ├─ styles/tokens.css
│     │  └─ assets/        # Local brand, font, emoji, and artwork assets
│     └─ public/ocr/       # Prepared local OCR runtime assets
├─ build/                  # Package icons and installer resources
├─ scripts/                # Validation, CI, packaging, and developer helpers
├─ docs/                   # Canonical Chinese designs and English translations
├─ references/             # Local research checkouts
├─ .github/workflows/      # Multi-platform release pipeline
└─ electron.vite.config.ts # node16 and chrome108 build targets
```

Most implementation files have adjacent `*.test.ts` coverage. Electron-free network, store, and utility modules can run directly under Vitest.

## Message data flow

Sending a text message:

```text
Renderer calls window.pantry
  → preload forwards to a validated IPC handler
  → services/chat stores the message and invokes networking
  → net/messenger encodes it and sends UDP+ACK or a TCP frame
  → the main process emits stored/status events
  → Pinia updates the visible conversation
```

Receiving a message:

```text
net/udp receives a datagram
  → codec performs type, length, and field allowlist validation
  → discovery or messenger dispatches and acknowledges it
  → services persist and deduplicate it by envelope ID
  → the main process emits an event to renderer stores
```

The message ID is also the envelope and deduplication key. Group delivery reuses one envelope ID across member-specific sends. File transfer is a pull-based TCP stream with `.part` resume files and SHA-256 integrity verification.

## Common extension paths

| Goal | Change order |
|---|---|
| Add a wire message type | `docs/protocol.md` → `shared/protocol.ts` → `net/codec.ts` validator → network/service handling → renderer → tests |
| Add a renderer component | Add under `renderer/src/components/`; use `window.pantry`; use variables from `styles/tokens.css` |
| Add a setting | `shared/ipc.ts` → preload bridge → validated main handler → `store/app-state.ts` → Settings UI |
| Add a table or column | Append a migration in `store/migrations.ts` → repository update → `npm run test:db` |
| Add an auxiliary window | Add a module under `main/windows/` and route a renderer root through `main.ts` |
| Expose a main-process capability | `shared/ipc.ts` → preload → validated handler → service implementation |

Protocol changes begin in the canonical protocol document and retain strict inbound allowlists. Unknown types are ignored to allow newer peers to coexist with older clients.

## Storage and migrations

SQLite uses WAL mode. Migrations use `PRAGMA user_version` and are append-only: add a new migration entry and never rewrite a migration shipped in a release. Run the database self-test through Electron because the native module uses Electron ABI 110.

The application data directory stores identity, configuration, databases, managed media, thumbnails, avatars, logs, and partial transfers. Renderer code never receives unrestricted local filesystem access; paths enter through main-process selection and authorization flows.

## Renderer design

The main window has three application tabs: Chat, Contacts, and File Cabinet. Settings, Capture, and Image Viewer remain separate renderer roots. `src/renderer/src/styles/tokens.css` is the single source for color, type scale, radius, spacing, elevation, and motion tokens.

Naive UI 2.43.2 is used selectively for standard forms, search, and common actions. It is imported through renderer entry points and styled through the centralized Teahouse theme mapping. Specialized chat, cabinet, capture, and brand surfaces remain project components.

## Tests and delivery

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

Network tests use `127.0.0.1` and empty broadcast targets. Use `npm run dev:2` or `npm run dev:3` for real local discovery, message, and file flows with isolated client data.

Package and lock versions must advance with each complete increment. The GitHub Actions release workflow builds multi-platform installers; after a push to `main` passes all platform and artifact version checks, it creates an annotated version tag and publishes the Release, skipping publication if the tag already exists remotely. Tag-triggered releases remain supported; manual dispatch publishes only on a `v*` tag.
