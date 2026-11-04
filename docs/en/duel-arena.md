# Two-player duel arena

> [简体中文](../duel-arena.md) · **English**

## Scope and entry point

The duel arena is a lightweight turn-based interaction inside a direct chat. Each player has 100 HP and locks one of **basic attack / guard / goofy skill** before the round countdown ends; the host resolves the round authoritatively and broadcasts one identical result to both sides. It is reached from the third item, **Arena**, in the chat toolbar's **PK** menu. It is not part of the avatar context menu and is unavailable in group chats.

- Only online peers advertising the `duel1` capability can be invited, so older clients never receive an unknown packet.
- The session lives in memory; completed match results are saved as local system messages in each participant's chat history.
- Traffic uses the existing LAN UDP/TCP discovery and reliable control channel. There is no external network access and no account.

## Flow

1. A opens the direct-chat PK menu and selects **Arena**. Main checks online state, `duel1`, cooldown, and whether another session is active, then sends `duel{op:"invite"}`.
2. If B is in another conversation, a non-blocking invitation card appears at the bottom-right. In the matching conversation, the arena overlay shows the invitation. Accepting starts the match; declining leaves A with a "declined" result.
3. Each round lasts 10 seconds. Both players choose a move; the round resolves immediately when both have chosen, or defaults to guard after the timeout.
4. A side reaching 0 HP is knocked out. After six rounds, remaining HP decides the winner; equal HP is a draw.
5. Opponent offline, voluntary quit, or a cancelled invitation ends the match immediately with a specific reason. The result screen can then be closed.

## Resolution rules

| Move | Effect |
|---|---|
| Basic attack | 8–14 damage; reduced to 40% against guard |
| Guard | Restore 2 HP; if both guard, each restores 4 HP |
| Goofy skill | 4–8 damage plus 3–7 self-heal; halved against guard |

All randomness comes from a hash of `seed + round + slot`, so the host and tests reproduce the same result. The guest never re-rolls; it applies the host's authoritative snapshot, preventing drift.

## Protocol and convergence

- The new `duel` packet type (`MSG_TYPES.duel`) is added to the reliable-control whitelist. Payloads are validated strictly in `src/shared/duel.ts`; unknown fields and out-of-range values are dropped.
- `invite` carries `matchId`, `seed`, `roundMs`, and `maxRounds`. The guest only accepts `accept / decline / cancel / state` matching the current invitation.
- The host is the only resolver. `move` is accepted only for the current round, current peer, and first submission. `state.seq` increases monotonically and the guest accepts only larger values, making retransmits and reordering idempotent.
- If the guest reaches the deadline without a snapshot, it sends `sync` every 2 seconds; the host resends the current `state`. Only after 20 seconds without a response is the match ended as interrupted.
- Peer offline is driven by `PeerRegistry` changes and ends the match locally at once. A failed reliable send reaches the same path.

## Compatibility and safety boundaries

- Older clients do not know the `duel` type and will neither ACK nor process it. The `duel1` capability is therefore required before any invitation is sent.
- Inbound packets must come from a known node and match the current peer and `matchId`. Forged `state / move` packets are silently ignored.
- Invitations have a 5-second per-peer cooldown and auto-cancel after 30 seconds. Only one session is kept at a time to avoid repeated interruptions.
- In-progress sessions are not persisted; results are saved in chat. The renderer opens the matching direct chat after acceptance.

## Code map

- `src/shared/duel.ts`: actions, payload/view types, inbound validation, deterministic resolution engine.
- `src/main/services/duel.ts`: invitation, accept/decline, host-authoritative resolution, guest sync, offline and quit handling.
- `src/main/net/codec.ts`, `src/main/net/messenger.ts`: `duel` whitelist and reliable frame support.
- `src/renderer/src/stores/duel.ts`: read-only projection of the main-process session and command proxy.
- `src/renderer/src/components/DuelArena.vue`: arena overlay, countdown, HP, move buttons, and animations.
- `src/renderer/src/components/DuelInviteToast.vue`: non-blocking invitation prompt.
- `src/renderer/src/components/ChatPane.vue`: PK menu entry and per-conversation overlay mount.

## Verification

```bash
npx vitest run src/shared/duel.test.ts src/main/services/duel.test.ts
npm run typecheck
npm run check:docs
```

For manual acceptance, verify invitations, moves, results, disconnects, result history, narrow layouts and reduced motion.
