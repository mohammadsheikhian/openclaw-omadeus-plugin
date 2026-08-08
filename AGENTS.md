# Omadeus Plugin — Agent Notes

`@brantrusnak/openclaw-omadeus` is an OpenClaw **channel plugin** that connects an OpenClaw
gateway to Omadeus (Xeba) chat.

> **Scope, and it is narrow:** this channel serves exactly one room — the operator's direct
> message conversation with the **OpenClaw Omadeus member**. That room is resolved once at
> startup and pinned; every other room is dropped by a single id comparison. Widening this
> means changing `src/room.ts` and `src/inbound.ts` deliberately, not by accident.

For the end-to-end runtime trace, see [FLOW.md](FLOW.md). This file covers rules and gotchas.

## Commands

```bash
npm run typecheck   # tsc --noEmit — strict + noUncheckedIndexedAccess
npm test            # vitest run
npm run build       # rolldown -> dist/
npm run prepack     # typecheck + build + verify-npm-files
npx vitest run src/gateway.integration.test.ts   # the end-to-end suite
```

**`npm run build` proves nothing about types.** rolldown strips TypeScript without checking
it, so `npm run typecheck` is the gate that actually validates SDK contracts.

## Architecture

Two transports, and they are not symmetric:

| Direction | Transport | Entry point |
| --- | --- | --- |
| **Inbound** | Jaguar **WebSocket** (`wss://<maestro>/ws?token=…`) | `src/socket/socket.ts` |
| **Outbound** | Jaguar **REST** (`POST /jaguar/apiv1/rooms/:id/messages`) | `src/outbound.ts` → `src/api/message.api.ts` |

Both are held by **one session** (`src/session.ts`), which is what `startAccount` opens and
what every outbound path sends through.

The socket is the *only* inbound path — no polling, no webhook fallback. Sends never touch it.

Upstream services (see the `omadeus` and `jaguar` repos' own `AGENTS.md`):

- **jaguar** — chat backend. Owns rooms, DMs, and the WebSocket fan-out. Sharded one
  PostgreSQL database per organization.
- **panda / CAS** — identity. `src/auth.ts` + `src/api/auth.api.ts` exchange credentials for a
  session JWT.
- **maestro** — the gateway host all REST and WS URLs are built from.

### The three values everything hangs off

Resolved once when `openOmadeusSession` runs, then fixed:

```
roomId           ← GET /jaguar/apiv1/directs/openclaw_bot   (Jaguar resolves it from the caller)
openClawMemberId ← config
authorization    ← "ApiToken <key>"  or  "Bearer <jwt>" with in-memory refresh
```

Inbound admission is then two comparisons, in `admitOmadeusMessage`:

```ts
if (msg.roomId !== roomId) drop;                  // not our room
if (msg.senderId === openClawMemberId) drop;      // our own reply echoing back
```

### Two ways to authenticate, and only two

| Mode | Credential | Who uses it |
| --- | --- | --- |
| **hosted** | `apiKey` | instances provisioned by eagle; config is rendered before boot |
| **self-hosted** | `email` + `password` + `organizationId` | a member running their own gateway, via the setup wizard |

An `apiKey` wins when both are present. **Config is the only source** — no environment
variables, no CLI flags, no cached session token on disk.

### Entry points

- `index.ts` — runtime entry, `defineChannelPluginEntry(...)`.
- `setup-entry.ts` — setup-only entry, `defineSetupPluginEntry(...)`.
- `runtime-api.ts` — the **only** place OpenClaw SDK imports are re-exported for internal use.

### Key modules

- `src/channel.ts` — the `ChannelPlugin` object. Holds one `activeSession` and little else.
- `src/session.ts` — **the live connection.** `openOmadeusSession` composes credential → room →
  handler → socket; the returned session is `roomId`, `send`, `close`. Its adapters are
  injectable (`deps`), which is what makes the lifecycle testable.
- `src/room.ts` — pins the served room; validates `openClawMemberId` against its members.
- `src/inbound.ts` — parses Jaguar frames and decides admission.
- `src/handler.ts` — debounce, read receipt, text-less reply, dispatch onto the turn kernel.
- `src/turn.ts` — builds the turn context for one admitted message, as a value.
- `src/reply.ts` — delivery adapter + reply options for one turn.
- `src/token.ts` — the credential. `openOmadeusToken(account)` picks the adapter, logs in, and
  starts auto-refresh; reads refresh themselves 5 minutes before expiry.
- `src/socket/socket.ts` — the WS: reconnect backoff, connection transitions, token freshness.
- `src/socket/heartbeat.ts` — the Jaguar keep-alive protocol.
- `src/utils/http.util.ts` — every Omadeus request, and the one error type they all raise.

## Conventions

- **SDK imports** go through `openclaw/plugin-sdk/<subpath>` entrypoints or `runtime-api.ts`.
  Never the monolithic `openclaw/plugin-sdk` root, never OpenClaw `src/**` internals.
- `openclaw` belongs in `peerDependencies` + `devDependencies`, never `dependencies`.
- Adding a public entry file means updating `package.json.files` **and**
  `scripts/verify-npm-files.mjs`.
- `package.json`'s `openclaw` block and `openclaw.plugin.json` are **public plugin surface**.
  The config schema is `additionalProperties: false`, so adding a key there and writing it
  from eagle must land in that order — eagle first would break every hosted pod.
- `CLAUDE.md` is a **symlink to this file**. Edit `AGENTS.md`; never replace the symlink.

## Gotchas

### Everything we send comes back at us

Every message the plugin sends echoes back over the socket as inbound. The only thing that
stops an infinite loop is the author check in `admitOmadeusMessage`, which works because
**every** send and every read receipt carries `asOpenclaw: true` — Jaguar then swaps the acting
member to the OpenClaw bot, so our own traffic returns authored by the bot rather than by the
operator whose account the gateway holds.

If you ever add a send path that omits `asOpenclaw`, the channel will answer itself forever.
The integration test asserts the flag; do not weaken it.

**Never suppress echoes by matching message bodies.** A reply and the operator repeating it
("ok", "1", "yes") are indistinguishable by text, so a body match could only ever swallow the
operator's genuine message. There is a regression test for this.

### Replies can silently vanish (`visibleReplies`)

This caused a real production outage. Some harnesses — Codex notably — default direct chats to
`sourceVisibleReplies: "message_tool"`, meaning **final assistant text is discarded unless the
model calls `message(action=send)`**. Weaker models answer without calling the tool, and the
reply is dropped with only a `source-reply/private-final` warning in the log.

`src/reply.ts` defends against this by requesting `sourceReplyDeliveryMode: "automatic"`
whenever `messages.visibleReplies` is unset — but it deliberately does **not** override an
operator who set that config explicitly. If replies go missing, check that setting first.

### Read receipts must be sent as the OpenClaw bot

In the OpenClaw DM every admitted message is authored by the operator, and Jaguar refuses to
let a member see their own message (`StatusCanNotSeeOwnMessage`, status `1058`). `seeMessage`
posts `asOpenclaw: true` so Jaguar records the receipt against the bot.

### `openClawMemberId` is not optional

Without it the channel cannot tell its own voice from the operator's, so `startAccount` refuses
to start rather than running in a state where it would answer itself. `pinOpenClawRoom` also
checks the id is actually a member of the resolved DM, which turns a silent misconfiguration
into a startup error. It is surfaced as a **status issue** as well.

### A 404 on the room is fatal, on purpose

The OpenClaw DM always exists by the time an instance is provisioned. `pinOpenClawRoom` retries
5xx and network errors (a pod can start before its gateway is reachable) but raises 401/404
immediately: those mean the gateway is pointed at the wrong Omadeus or holds the wrong
credentials, and no amount of retrying fixes it.

Retryability is decided by `isTransientFailure`, which is true only for an `OmadeusHttpError`
whose status is 5xx or `0` (never reached the server). **Every** Omadeus request raises that
one type — that is why `src/utils/http.util.ts` decodes bodies and throws rather than handing
back a `Response`. When some calls threw it and others threw a plain `Error`, the check was
`err.name !== "OmadeusHttpError"` and got the member-mismatch error backwards: a misconfigured
`openClawMemberId` was retried 5 times over 8 seconds before surfacing. If you add a request
path, raise `OmadeusHttpError` or it will be classified as permanent.

### `formatAllowFrom` must pass values through

OpenClaw runs **both** `commands.ownerAllowFrom` and the inbound sender id through
`config.formatAllowFrom`, then matches the two results against each other to decide
`senderIsOwner`. A stub returning `[]` blanks both sides, the match can never succeed, and the
agent loses every owner-only tool — `cron` first among them — with only a
`gateway sender owner-only tools.deny` line in the log. That is exactly what happened; there
are regression tests in `src/owner-policy.test.ts`.

The channel still has no sender allowlist (`resolveAllowFrom` returns `[]`) — the room is the
allowlist. That part is fine; it is only the *formatting* hook that must be honest.

The owner id itself comes from `commands.ownerAllowFrom`: written by the provisioner for
hosted instances, and by the setup wizard for self-hosted ones. Without an entry there,
`senderIsOwner` is false for every turn.

### Admission failures must stay visible

Drops and text-less messages log at `info`, not `debug`. Every silent failure this channel has
had was invisible at the default log level.

### `send` has no target

There is one room, so the message tool takes only `message`; any target passed by the agent is
discarded. Re-adding target resolution means re-adding the whole class of bug where a model
invents a `room:` id and the reply goes nowhere.

### Do not reintroduce the deprecated reply helpers

The receive path runs on the channel turn kernel (`core.channel.inbound.run` +
`core.channel.inbound.buildContext` + `dispatchReplyWithBufferedBlockDispatcher`).
`dispatchReplyFromConfig`, `createReplyDispatcherWithTyping`, `finalizeInboundContext`, and
`resolveHumanDelayConfig` are all SDK-deprecated and were removed on purpose.

### Live preview is deliberately not declared

`plugin.message.live` is absent on purpose. `ChannelMessageLiveAdapterShape` carries only
capability *declarations* — there is no implementation hook on it, and the machinery that edits
a streaming draft in place lives in each bundled channel's own outbound builder, which the
shared SDK does not export. Declaring these would advertise behavior nothing backs.

### `onConnect` is per transition, not per socket

`createJaguarSocket` fires `onConnect` when the connection comes up and not again until an
`onDisconnect` has fired. The session reports `openclawStatus: "connected"` from it, and
Jaguar does not want that on every reconnect. The guard lives in the socket because the caller
that kept its own `isConnected` flag was duplicating state the socket already had.

The socket's interface is `connect` and `disconnect`. `send`, `isConnected` and `onOtherEvent`
were removed — nothing called them, and the last one only ever meant "a frame arrived", which
is now the heartbeat's business.

### Reading the credential can refresh it

`OmadeusTokenManager` is `authorization()`, `wsToken()`, `close()`. Both reads are `async` and
re-authenticate first when the token is within 5 minutes of expiry, so no caller sequences a
refresh. `openOmadeusToken(account)` is the only constructor a runtime path should use: it
picks the adapter the credential source implies, logs in before it resolves, and starts
auto-refresh. `close()` is the whole cleanup obligation.

Do not re-add `getToken`/`needsRefresh`/`refresh`/`startAutoRefresh` to that interface. The
ordering rules they forced onto callers are exactly what the module now owns, and one of the
old members (`getPayload`) threw by design on the API-key adapter.

### Two AI agents share these rooms

Omadeus has its own `bot_openclaw` prompt-only agent (`omadeus` repo,
`llm/prompts/instructions/bot_openclaw.mako`). It answers the member's OpenClaw DM until this
gateway reports `connected`. Be deliberate about which one owns a room.

## Testing

`src/gateway.integration.test.ts` is the one that matters: it stands up a real WebSocket
server, stubs `fetch`, and runs a frame through socket → parse → admission → handler → REST
reply. It covers the three failures this channel actually has — a dropped message, an echo
loop, and answering the wrong room. Break the author check and it fails; that has been
verified by mutation.

Around it:

- `src/session.test.ts` — the gateway lifecycle through `deps`: startup ordering, that a failed
  room pin releases the credential, that `close` is idempotent, and that `connected` is
  reported. This is what `deps` on `openOmadeusSession` exists for; keep it injectable.
- `src/token.test.ts` — adapter choice, login-before-return, refresh-on-read, one login per
  burst, and that `close` stops the timer.
- `src/utils/http.util.test.ts` — one error type, and the `isTransientFailure` classification.
- `src/turn.test.ts` — the turn context the kernel receives, field by field.
- `src/socket/heartbeat.test.ts` — the keep-alive protocol against frame fixtures.
- `src/inbound.test.ts`, `src/room.test.ts`, `src/owner-policy.test.ts` — the pure decisions.

`gateway.startAccount` itself is still uncovered — it is now thin enough to read, but the wiring
between it and OpenClaw is not exercised, so a real DM through a running gateway is still worth
it after touching `src/channel.ts`:

```bash
npm run build && openclaw plugins install . --link   # then restart the gateway
```

`dist/` is gitignored, so a deploy target must run `npm run build` after pulling.

## Behavior reference

- A message with no usable text (attachment-only, or a bare `**@mention**`) gets a short
  "text only" reply — but only after admission, so it never fires in a room we do not serve.
- **`send` is the only message action.** `edit`, `delete`, and `react` fall through to the
  SDK's shared handling. `capabilities.reactions` is `false`.
- Message-tool sends route through `actions.prepareSendPayload` onto core's durable send path.
  The `send` branch in `handleAction` is the fallback for paths that bypass it.
- The wizard writes `channels.omadeus` and is the self-hosted path only; hosted instances boot
  with `OPENCLAW_SKIP_ONBOARDING=1` and never run it.
