# Omadeus Plugin — Agent Notes

`@brantrusnak/openclaw-omadeus` is an OpenClaw **channel plugin** that connects an OpenClaw
gateway to Omadeus (Xeba) chat.

> **Scope, and it is narrow:** this channel serves exactly one room — the operator's direct
> message conversation with the **OpenClaw Omadeus member**. Group channels, entity rooms
> (task/nugget/project/sprint/release/…), DMs with other people, and the operator's own
> self-DM are all refused in `src/inbound-policy.ts`. Do not add surface for them without
> changing that policy deliberately.

For the end-to-end runtime trace (how a message travels from socket frame to reply), see
[FLOW.md](FLOW.md). This file covers rules, conventions, and gotchas.

## Commands

```bash
npm run typecheck   # tsc --noEmit — strict + noUncheckedIndexedAccess
npm test            # vitest run
npm run build       # rolldown -> dist/
npm run prepack     # typecheck + build + verify-npm-files
npx vitest run src/inbound-policy.test.ts   # single suite
```

**`npm run build` proves nothing about types.** rolldown strips TypeScript without checking
it, so `npm run typecheck` is the gate that actually validates SDK contracts. Run it before
claiming anything compiles.

## Architecture

Two transports, and they are not symmetric:

| Direction | Transport | Entry point |
| --- | --- | --- |
| **Inbound** | Jaguar **WebSocket** (`wss://<maestro>/ws?token=…`) | `src/socket/socket.ts` → `src/socket/jaguar.socket.ts` |
| **Outbound** | Jaguar **REST** (`POST /jaguar/apiv1/rooms/:id/messages`) | `src/outbound.ts` → `src/api/message.api.ts` |

The socket is the *only* inbound path — there is no polling or webhook fallback. Sends never
touch it.

Upstream services (see the `omadeus` and `jaguar` repos' own `AGENTS.md` for detail):

- **jaguar** — chat/messaging backend. Owns rooms, DMs, reactions, and the WebSocket fan-out.
  Sharded one PostgreSQL database per organization, routed by `organization_id`, which is why
  `channels.omadeus.organizationId` is load-bearing rather than cosmetic.
- **panda / CAS** — identity. `src/auth.ts` + `src/api/auth.api.ts` exchange credentials for a
  session JWT.
- **maestro** — the gateway host all REST and WS URLs are built from.

Environments (`src/defaults.ts`): `production`, `staging`, `dev`, `milestone` — each a
`casUrl` + `maestroUrl` pair.

### Entry points

- `index.ts` — runtime entry, `defineChannelPluginEntry(...)`.
- `setup-entry.ts` — setup-only entry, `defineSetupPluginEntry(...)`.
- `api.ts` — public re-exports (`src/setup-core.ts`, `src/setup-surface.ts`).
- `runtime-api.ts` — the **only** place OpenClaw SDK imports are re-exported for internal use.

### Key modules

- `src/channel.ts` — the `ChannelPlugin` object: capabilities, agent prompt hints, message
  actions, `message` adapter, outbound adapter, config/status adapters, and
  `gateway.startAccount` (auth → socket → inbound handler).
- `src/message-handler.ts` — inbound orchestration: debounce, policy, command gate, ack,
  routing, and dispatch onto the channel turn kernel.
- `src/inbound.ts` — normalizes raw Jaguar frames (`parseJaguarMessage`), strips mention
  prefixes, detects mentions.
- `src/inbound-policy.ts` — admission. Direct-room-only; everything else drops.
- `src/direct-resolver.ts` — resolves a DM's *counterparty* (cached), which is what admission
  keys off.
- `src/sent-message-tracker.ts` — suppresses echoes of our own sends (2 min TTL, 500 entries).
- `src/reply-dispatcher.ts` — builds the delivery adapter + reply options for one turn.
- `src/token.ts` — session JWT with auto-refresh 5 minutes before expiry.
- `src/socket/socket.ts` — shared WS: reconnect backoff, heartbeat, pre-connect token refresh.

## Conventions

- **SDK imports** go through focused `openclaw/plugin-sdk/<subpath>` entrypoints or
  `runtime-api.ts`. Never import the monolithic `openclaw/plugin-sdk` root or OpenClaw
  `src/**` internals.
- `openclaw` belongs in `peerDependencies` + `devDependencies`, never `dependencies`.
- Adding a public entry file means updating `package.json.files` **and**
  `scripts/verify-npm-files.mjs`.
- `package.json`'s `openclaw` block and `openclaw.plugin.json` are **public plugin surface** —
  treat changes there as breaking.
- `CLAUDE.md` is a **symlink to this file**. Edit `AGENTS.md`; never replace the symlink.

## Gotchas

### Replies can silently vanish (`visibleReplies`)

This caused a real production outage. Some harnesses — Codex notably — default direct chats to
`sourceVisibleReplies: "message_tool"`, meaning **final assistant text is discarded unless the
model calls `message(action=send)`**. Weaker models answer without calling the tool, and the
reply is dropped with only a `source-reply/private-final` warning in the log.

`src/reply-dispatcher.ts` defends against this by requesting
`sourceReplyDeliveryMode: "automatic"` whenever `messages.visibleReplies` is unset — but it
deliberately does **not** override an operator who set that config explicitly. If replies go
missing, check that setting first.

### Everything we send comes back at us

Every message the plugin sends echoes back over the socket as inbound. `SentMessageTracker`
suppresses those by `temporaryId` and backend `id` only. Note the ordering in
`src/outbound.ts`: the `temporaryId` is registered **before** the HTTP call, because the echo
can arrive before the response. `src/inbound-policy.ts` has a second structural backstop
(`direct_openclaw_authored`) for when the TTL expires or the gateway restarts.

**Never add a body-matching fallback to the tracker.** Replies are posted with `asOpenclaw`,
so they echo back authored by the OpenClaw bot, never by the operator. A body match could
therefore only ever fire on the operator's *own* genuine message — silently swallowing it
whenever they repeated something OpenClaw had just said ("1", "ok", "yes") inside the TTL.
There is a regression test for this.

### Admission keys off the counterparty, not the sender

Because the operator and OpenClaw share one authenticated account, the operator's own messages
to OpenClaw arrive *self-authored*. Gating on sender would let the operator's DMs to any person
through. `src/direct-resolver.ts` resolves who the DM is *with*; that is what the policy checks.
A failed lookup drops the message rather than guessing — OpenClaw goes quiet instead of
answering the wrong room.

### Control commands are authorized in this room

`resolveControlCommandGate` can only authorize via its `authorizers` list, and `[].some(...)`
is always false — passing an empty list silently blocks **every** `/command`. Because the one
room this channel serves is the operator's own DM with a hardcoded bot member, the handler
passes an explicit authorizer. Do not "simplify" it back to `[]`.

### Admission failures must stay visible

Policy drops, command blocks, and text-less messages log at `info`, not `debug`. Every silent
failure this channel has had was invisible at the default log level. `openClawReferenceId`
missing from config is likewise surfaced as a **status issue**, because without it the policy
drops every message while the account still reports as configured.

### Read receipts must be sent as the OpenClaw bot

The gateway authenticates as the operator, and in the OpenClaw DM every admitted message is
authored by the operator. Jaguar refuses to let a member see their own message
(`StatusCanNotSeeOwnMessage`, status `1058`), so `seeMessage` posts `asOpenclaw: true` and
Jaguar swaps the acting member to the OpenClaw bot — the identity that actually read it. That
flag is honored by `see_operation(as_openclaw=...)` in the jaguar repo; without it the call
fails and no receipt is recorded.

### Do not reintroduce the deprecated reply helpers

The receive path runs on the channel turn kernel (`core.channel.inbound.run` +
`core.channel.inbound.buildContext` + `dispatchReplyWithBufferedBlockDispatcher`).
`dispatchReplyFromConfig`, `createReplyDispatcherWithTyping`, `finalizeInboundContext`, and
`resolveHumanDelayConfig` are all SDK-deprecated and were removed on purpose. The first of
those carries an explicit warning that direct use "must manually preserve source reply delivery
metadata such as `sourceReplyDeliveryMode`" — which is exactly the bug above.

### Live preview is deliberately not declared

`plugin.message.live` is absent on purpose. `ChannelMessageLiveAdapterShape` carries only
capability *declarations* (`draftPreview`, `progressUpdates`, `previewFinalization`) — there is
no implementation hook on it. The machinery that edits a streaming draft in place lives in each
bundled channel's own outbound builder (e.g. `createTelegramOutboundAdapter`), which the shared
SDK does not export. Declaring these would advertise behavior nothing backs. Real live preview
means re-adding an `EDIT` wrapper to `src/api/message.api.ts` (Jaguar supports the verb; the
plugin no longer calls it), building an edit loop on it, **and** reconciling that loop with
`SentMessageTracker`, since every edit echoes back over the socket.

### Two AI agents share these rooms

Omadeus has its own `bot_openclaw` prompt-only agent (see the `omadeus` repo,
`llm/prompts/instructions/bot_openclaw.mako`). This plugin is a second, independent path into
the same Jaguar rooms. Be deliberate about which one owns a room before widening inbound scope.

## Testing

Unit tests sit beside their modules (`src/*.test.ts`), run under vitest.

**Coverage has a hole you must respect:** nothing exercises the inbound path end to end. The
tests cover pure functions — policy decisions, config resolution, the send
payload contract. After changing `src/message-handler.ts`, `src/inbound-policy.ts`, or
`src/socket/*`, typechecking and green tests are **not** sufficient evidence. Rebuild and send
a real DM through a running gateway:

```bash
npm run build && openclaw plugins install . --link   # then restart the gateway
```

`dist/` is gitignored, so a deploy target must run `npm run build` after pulling.

## Behavior reference

- `send` targets the DM's room id: `room:123` or `123`. There is no entity/task target
  resolution — `N123`/`T123` were removed with the nugget features.
- A message with no usable text (attachment-only, or a bare `**@mention**`) is answered with
  a short "text only" reply — but only *after* the policy admits it, so this never fires in
  rooms the channel does not serve. `parseJaguarMessage` deliberately returns such messages
  with empty `content` rather than dropping them.
- `inbound.direct.requireMention` is **not enforced**. There is no way to @mention inside a
  Jaguar direct, so honouring `"always"` would drop every message and brick the channel.
- **`send` is the only message action.** `edit`, `delete`, and `react` are absent from
  `supportsAction`, so they fall through to the SDK's shared handling rather than reaching
  `handleAction`. `capabilities.reactions` is `false`. Jaguar still *sends* a `reactions`
  field on inbound messages; that is wire shape, not a feature.
- Message-tool sends route through `actions.prepareSendPayload` onto core's durable send path.
  The `send` branch in `handleAction` is the fallback for paths that bypass it.
- Setup writes `channels.omadeus` (including `inbound.direct`) and reads `OMADEUS_EMAIL`,
  `OMADEUS_PASSWORD`, `OMADEUS_ORGANIZATION_ID`.
