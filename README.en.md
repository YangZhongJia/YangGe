<div align="center">

<p><a href="README.md">简体中文</a> · <b>English</b></p>

<img src="build/icons/pantry-logo-icon.png" alt="YangGe logo" width="120" height="120" />

<h1>阳鸽 &nbsp;·&nbsp; YangGe</h1>

<p><b>Chat and transfer files across a LAN, with no Internet connection or server (original Iris indigo UI)</b></p>

> **Fork notice**: YangGe is a secondary-development fork of the open-source [Teahouse](https://github.com/skyjt/teahouse) project (GPL-3.0-only).
> It goes far beyond a rebrand: rebuilt brand & UI, new features (AI avatar, clipboard send, typing indicator, AI group summary), one-click LAN self-update, multi-platform packaging with CI auto-release — see the [fork content](#fork-contentwhat-yangge-changes-upstream) for the full list. Thanks to the upstream authors.

<p>
  <a href="https://github.com/skyjt/teahouse/releases/latest">
    <img src="https://img.shields.io/github/v/release/skyjt/teahouse?style=flat-square&label=latest&color=3D8B6B&logo=github&logoColor=white" alt="Latest release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0--only-3D8B6B?style=flat-square" alt="GPL-3.0-only" />
  </a>
  <a href="https://github.com/skyjt/teahouse/releases">
    <img src="https://img.shields.io/badge/platform-Windows%207%2B%20%7C%20Linux%20%7C%20macOS-0366d6?style=flat-square" alt="Supported platforms" />
  </a>
  <img src="https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 22" />
</p>

<p>
  <a href="#why-yangge">Why YangGe</a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#platform-support">Platforms</a>
  &nbsp;·&nbsp;
  <a href="#installation">Installation</a>
  &nbsp;·&nbsp;
  <a href="#usage">Usage</a>
  &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a>
  &nbsp;·&nbsp;
  <a href="#security">Security</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
</p>

</div>

---

Start YangGe on computers connected to the same local network and they discover each other automatically. Open a peer to chat or transfer files directly. No cloud account, central server, telemetry, or Internet access is involved. YangGe is designed for corporate intranets, isolated networks, and laboratories where external connectivity is limited or prohibited.

## Why YangGe

Moving a file or sending a short message inside an office network should be effortless. Existing tools often miss at least one requirement: commercial solutions require licensing fees, Neiwangtong provides only Windows binaries without support for domestic UOS or macOS, and iptux presents a steeper learning curve for regular office users. YangGe aims for an open-source, serverless, zero-configuration experience across Windows 7, domestic UOS deployments, Linux, and macOS.

## Features

- **Zero-configuration peer discovery** — UDP broadcast discovers online peers on the same subnet automatically. Peers communicate directly without deploying a central server or manually configuring IP addresses.
- **Cross-subnet communication & LAN self-updates** — Supports manual peer IP addition and CIDR subnet scanning; saved scan ranges are shared among online peers at a low rate; provides a global subnet scan trigger with real-time progress; supports P2P package requests for LAN-based self-updating. Installers self-retain their package (the first upgraded machine becomes the update source), and after pulling a package one click installs silently and restarts.
- **Messaging & group collaboration** — Direct chats and multi-user discussion groups; text, local images, pasted screenshots, Twemoji SVG graphics, and custom sticker collections; delivery acknowledgments, offline queuing with automatic retry upon reconnection, 2-minute message recall, message forwarding, quote replies with jump-to-source navigation, and @ mentions in groups; synchronized group descriptions (≤200 characters) and announcements (≤1024 characters); window nudge alerts.
- **High-speed P2P file transfers** — Direct TCP peer-to-peer transfers maximize LAN physical bandwidth; supports single files, multi-file selections, and full directory trees; resume interrupted transfers and review comprehensive transfer history; 24-hour expiration window closes outdated transfers automatically.
- **Shared file cabinet (third main tab)** — Built natively into the third tab of the main window; publish a local folder with configurable global permissions (disabled, read-only, read-write) and granular per-peer grants; browse colleagues' shared cabinets with breadcrumb navigation and pagination; multi-select download and save-as; drag-and-drop upload of files or folders into dedicated subdirectories to avoid overwriting existing data; aggregate recent upload activity.
- **Standalone image viewer & offline OCR** — Independent image viewer with smooth zooming, double-click mouse-anchored zooming, rotation, and window centering; browse chat image history seamlessly using previous/next navigation buttons; built-in PaddleOCR (PP-OCRv6 tiny + onnxruntime-web WASM) fully offline text recognition engine; directly select, drag across lines, and copy text on top of the original image, plus one-click copy of all recognized text; session-level in-memory caching restores the text selection layer instantly.
- **Cross-machine clipboard** — send your clipboard text to a peer with one click in a single chat; the peer can paste it immediately, with automatic audit tips on both sides. Live "typing…" indicator while the peer is composing.
- **AI group summary (optional)** — right-click in a group to summarize today's messages into key points, shown locally only and never posted to the group. Pairs with the AI avatar.
- **Built-in screenshot utility** — One-key global shortcut capture; rectangular selection, pencil, arrows, mosaic, and in-place single-line text annotations; includes a magnifier and coordinate/color inspector; compatible with Linux Wayland and X11 environments.
- **View-only screen assistance** — Request from a private chat; the peer consents and selects a screen each time. An independent viewer provides Auto and 3/5/10 fps modes with immediate stop. Plaintext LAN transport; local loopback and synthetic Electron capture are validated, while physical-screen permissions and target performance remain pending. See [technical boundaries](docs/en/tech-design.md#remote-view).
- **Local history & full-text search** — Powered by SQLite WAL mode and FTS full-text index; quickly search contacts, groups, and message history globally or filter within a specific chat; supports local backup export and device migration.
- **Bilingual interface switching** — Native support for Simplified Chinese and English; switch instantly across all active windows via Settings → General → Language; fresh installations initialize automatically based on system locale.
- **LAN security boundary** — Globally appends `--no-proxy-server` at startup to bypass any system or environment proxies; zero external network requests, zero telemetry, and zero remote CDN dependencies; context isolation and Chromium sandboxing enabled in renderers; strict network packet allowlist validation; destination path traversal sanitization; inline chat images bounded to ≤8192px and ≤32 megapixels; strict log sanitization keeping message bodies and file contents out of logs.

## Fork content (what YangGe changes upstream)

**Brand & UI**

- New brand "YangGe" with an original "ribbon dove" mark: app icons, tray (color + macOS template), installer, notifications and in-app brand bitmap all redrawn; the icon pipeline is scripted from a single 1024px master (ico/icns/Linux sizes).
- **Original Iris indigo UI**: graphite neutrals, indigo accent, solid indigo bubbles with directional corners, floating composer, reworked nav rail; light & dark themes.

**New features**

- **AI avatar**: auto-replies to single chats and group mentions via any OpenAI-compatible LLM (LAN Ollama/vLLM or cloud API), with anti-loop guard, cooldown and serial queue. Off by default.
- **AI group summary**: right-click to summarize today's group messages; local dialog only, never posted to the group.
- **Clipboard send**: one-click cross-machine clipboard text sharing.
- **Typing indicator**: live "typing…" in single chats.
- **One-click LAN self-update**: completes upstream decision #166 — installers self-retain to become update sources; after pulling a package, one click installs silently and restarts. Zero servers, zero internet.

**Fixes & engineering**

- WeChat-style notification policy: a focused window suppresses toasts only for the conversation you are looking at.
- Installers add firewall rules automatically (idempotent, zero UAC on silent upgrades), fixing screen-assist timeouts caused by inbound blocks after rebranding.
- Restored macOS (arm64/x64 dmg) and Linux (deb/AppImage) packaging; five-platform CI builds and tag-triggered releases with checksums.
- 1033+ automated tests maintained; key chains (self-update, notifications, AI, clipboard, typing) covered by unit and real-instance E2E tests.

## Platform support

| Platform | Supported versions | Architectures | Packages | Hardware-tested coverage |
|---|---|---|---|---|
| Windows | Windows 7 SP1 through Windows 11 | x64 / ia32 | NSIS installer, portable executable | Windows 7 x64; ia32 build verified |
| UnionTech UOS / Kylin | UOS 20 and later, Kylin V10 | x64 / arm64 | `.deb` | UOS 20 x64; arm64 build verified |
| macOS | macOS 12 Monterey and later | Apple Silicon | `.dmg`, `.zip` | macOS 12+ / Apple Silicon |
| Debian / Ubuntu and related distributions | Debian 10 Buster and later | x64 / arm64 | `.deb`, AppImage | Build verified |

The hardware-tested column distinguishes an installation and messaging test on the named operating system from CI-only package validation.

Electron is pinned to **22.3.27**, the final major release supporting Windows 7. This compatibility baseline is permanent. See [Contributing](CONTRIBUTING.en.md#hard-constraints) before changing dependencies or runtime code.

## Installation

This fork targets **Windows 10+ x64** only. Two package forms:

- **NSIS installer** `YangGe-<version>-win-x64-setup.exe` — run to install, with custom install directory and desktop shortcut support;
- **Portable** `YangGe-<version>-win-x64-portable.exe` — no installation, single executable.

Packages are built from this repository via `npm run dist:win` and placed under `release/`; distribute them over an intranet share or USB drive.

> If the operating-system firewall prompts on first run, allow it (default ports: UDP `17878` and TCP `17879`).

## Usage

1. Start YangGe on each device connected to the LAN. Peers on the same subnet appear automatically in the left contact list.
2. Select a peer to start a private chat, click the plus icon to create a discussion group, or drag files and folders into the chat window to send them.
3. Switch to the File Cabinet tab in the navigation rail to browse files shared by colleagues, or publish your own shared folder with custom access permissions.
4. **Cross-subnet communication**: For routed subnets where UDP broadcast does not cross boundaries, add peer IPs or configure CIDR scan ranges in Settings → Network. Saved ranges are shared at a low rate among online peers. Click the refresh button at the bottom of the navigation rail to scan all ranges with live progress.
5. **Image viewing & text recognition**: Double-click an image in chat to open the standalone viewer, use the side arrows to navigate session image history, or click "Recognize Text" to select and copy text directly from the image.
6. Allow the application through the operating-system firewall when prompted. Default ports are UDP `17878` and TCP `17879`.

## How it works

Each client is an equal peer (P2P), with **no central server**:

```text
Renderer process (UI) — session list, chat panel, shared file cabinet, image viewer, settings
   │  IPC exposed exclusively through context-isolated preload bridges
Main process
   ├─ Network (Net)     : UDP discovery & heartbeat, UDP+ACK / TCP message channel, TCP file transfer
   ├─ Services          : contacts, groups, file cabinet service, offline delivery queue
   ├─ Storage (Store)   : SQLite (WAL mode + FTS index, persisting history, groups, grants, and transfers)
   └─ Desktop (System)  : tray, notifications, global shortcuts, OCR coordination & window management
```

| Channel / Component | Transport | Default ports | Purpose |
|---|---|---|---|
| Peer Discovery | UDP broadcast & unicast | 17878 | Online announcement, response, heartbeat, offline exit, and subnet exchange |
| Control & Short Messages | UDP with ACK/retry | 17878 | Text messages, delivery receipts, recall, window nudges, group events, cabinet metadata |
| Long Message Channel | Direct TCP | 17879 | Fallback channel for lengthy messages exceeding UDP MTU |
| File & Data Transfer | Direct TCP | 17879 | Chunked verified file/folder transfers, cabinet uploads/downloads, LAN P2P self-updates |

The discovery sequence takes inspiration from IP Messenger, while YangGe uses its own UTF-8 JSON protocol and does not claim wire compatibility with legacy ipmsg clients.

## Security

- **Strict LAN boundary** — All communication is strictly bounded to the local network; `--no-proxy-server` is appended at startup to bypass system proxies; zero external calls, telemetry, or remote updates.
- **Minimal renderer attack surface** — Renderers load locally packaged resources only. `contextIsolation` and Chromium sandboxing are enforced, `nodeIntegration` is disabled, window navigation and opening are denied, and strict CSP is applied.
- **Untrusted input validation** — Incoming network packets undergo strict schema and length allowlist validation; unknown message types are ignored gracefully; inline images are bounded to ≤8192px and ≤32 megapixels to prevent decoder OOM.
- **Safe file persistence** — Incoming file names are sanitized against path traversal; files are saved exclusively to user-selected or isolated subdirectories with automatic conflict renaming to prevent overwrites; cabinet uploads are restricted to dedicated peer folders.
- **Operational log sanitization** — Message contents and transferred file data are never written to disk logs; only transaction IDs, status codes, and file byte sizes are recorded.
- **Physical LAN trust model** — YangGe adopts the unencrypted LAN transmission model of classic tools like IP Messenger and iptux, intended for operation within trusted intranet perimeters and isolated laboratory networks.

## Development

- [Contributing](CONTRIBUTING.en.md) covers setup, builds, tests, hard constraints, and release packaging.
- [Development guide](DEVELOPMENT.en.md) explains architecture, data flow, and extension points.
- [Documentation index](docs/en/README.md) links the English requirements, protocol, UI, technical design, handoff, compatibility, and optimization documents.

Please report bugs and feature requests through [GitHub Issues](https://github.com/skyjt/teahouse/issues).

## Related projects

- [IP Messenger](https://ipmsg.org/) — the original LAN messaging protocol that inspired the discovery model.
- [iptux](https://github.com/iptux-src/iptux) — an open-source IP Messenger-compatible client for Linux.
- FeiQ and Neiwangtong — popular Windows LAN messengers used as product references.

## Third-party resources

Standard renderer controls use [Naive UI](https://github.com/tusen-ai/naive-ui) 2.43.2 (locally bundled, MIT). Built-in avatar and emoji compatibility rendering uses a locally bundled subset of [Twemoji](https://github.com/jdecked/twemoji) (CC-BY 4.0). Built-in offline OCR uses PaddleOCR models and onnxruntime-web. See [Third-party notices](THIRD_PARTY_NOTICES.en.md).

## License

Copyright © 2026 skyjt and YangGe fork contributors.

YangGe is a secondary-development fork of [Teahouse](https://github.com/skyjt/teahouse), licensed under the [GNU General Public License v3.0 only](LICENSE), SPDX identifier `GPL-3.0-only`. The upstream project has used GPL-3.0-only since version 0.37.0; MIT rights granted for version 0.36.8 and earlier remain valid. Third-party components and artwork retain the licenses listed in [Third-party notices](THIRD_PARTY_NOTICES.en.md).


## Diagnostics and feedback (since v0.60.0)

After a problem, open **Settings → About → Diagnostics and feedback → Export diagnostics**, save a local ZIP and attach it to your Issue manually. **Copy environment info** supplies a redacted summary. Include the time, steps and expected result; for file/image issues, export from both peers and label sender/receiver.

Bundles include versions, OS/architecture/session details, known listener/permission status and recent events. Logs retain up to **seven days and 10 MiB**, excluding chat text, filenames/file contents, screen images, clipboard contents, credentials and raw error messages. Nodes and addresses are aliased by default. The unchecked **Include real network addresses** option adds addresses observed during this run only; confirm they can be shared before posting public attachments. Copied information always stays redacted. The app never uploads or contacts an external service.

If the app cannot open, retrieve `.jsonl` files from `logs`, not the complete data directory, database or `identity-salt`:

| Platform | Default log location |
|---|---|
| Windows | `%APPDATA%\茶话间\logs` |
| Linux / UOS / Kylin | `${XDG_CONFIG_HOME:-~/.config}/茶话间/logs` |
| macOS | `~/Library/Application Support/茶话间/logs` |

Development instances use `PANTRY_USER_DATA/logs` when overridden. Restarted apps can export retained previous-run records. An unclean marker does not establish a crash cause; native crashes/power loss may leave no stack. If logging fails, bounded in-memory records last until exit and the summary reports persistence errors. Packaging runs only during export, with no per-frame logging or continuous performance monitoring.
