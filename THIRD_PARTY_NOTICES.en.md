# Third-party notices

> [简体中文](THIRD_PARTY_NOTICES.md) · [English](THIRD_PARTY_NOTICES.en.md)

## Naive UI

Teahouse uses Naive UI for standard forms, search controls, and common renderer actions. Components are bundled locally and make no runtime network request.

- Source: <https://github.com/tusen-ai/naive-ui>
- Version: 2.43.2
- Use: component-level imports styled through Teahouse design tokens
- License: MIT License
- Copyright: Copyright (c) 2021 TuSimple

## Twemoji

Teahouse bundles a subset of Twemoji SVG artwork for built-in avatars and cross-platform emoji rendering. The assets remain local at runtime.

- Source: <https://github.com/jdecked/twemoji>
- Version: artwork subset from v15.1.0
- Use: selected unmodified SVG files
- Artwork license: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0)
- Copyright: Copyright Twitter, Inc. and other contributors

## Navigation icons

The left navigation uses `message-circle`, `users`, `package-2`, `refresh-cw` and `settings` from Lucide 0.468.0. Original geometry is preserved with a shared display size and stroke weight. Only these five glyphs are bundled, with no icon-library runtime dependency or network request.

- Lucide: <https://github.com/lucide-icons/lucide/tree/0.468.0>, ISC License (some artwork originates from Feather / MIT)
- Full copyright and license notices: [navigation-icons.txt](build/licenses/navigation-icons.txt), bundled as `licenses/navigation-icons.txt`.

## Guandan (embedded game)

The Guandan entry in the left rail opens an embedded single-player game from a third-party open-source project. Its static assets ship with the application and make no runtime network request.

- Source: <https://github.com/dengweiqh/guandan-windows>
- Commit: `600c175aa6a0fef12eb7f408e489871b9144939a`
- Use: upstream `dist` static build loaded through the local `yangge-game://` protocol; promo badge, external fonts, and Trae link removed; build target fixed to Chrome 108
- Rooms: upstream `server/index.js` extended with player names, a 1000-point starting score, and leaderboard events, bundled as `guandan-server/server.cjs` and started with the app on LAN port 17890
- License: Apache License 2.0, full text at [build/guandan/LICENSE](build/guandan/LICENSE)
- Copyright: upstream authors and contributors
