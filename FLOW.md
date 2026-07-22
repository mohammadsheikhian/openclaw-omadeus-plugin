# Omadeus Plugin — Runtime Flow

An end-to-end trace of how this plugin behaves at runtime: what happens at boot, how an
inbound message becomes an agent turn, and how a reply reaches the room.

This document describes **flow only**. For rules, conventions, commands, and gotchas, see
[AGENTS.md](AGENTS.md).

## 1. Load

OpenClaw discovers the plugin from `package.json`:

- `openclaw.extensions` → `./index.ts` (runtime), `openclaw.runtimeExtensions` → `./dist/index.js`
- `openclaw.setupEntry` → `./setup-entry.ts`
- `openclaw.channel` → channel-picker metadata (id, label, blurb, order)

`index.ts` default-exports `defineChannelPluginEntry({ plugin: omadeusPlugin, setRuntime })`.
OpenClaw calls `setRuntime` once; `src/runtime.ts` stores it, and every module reaches shared
OpenClaw helpers through `getOmadeusRuntime()`.

## 2. Gateway startup

`gateway.startAccount` in `src/channel.ts`:

1. Resolve the account (`src/config.ts`). Bail out if credentials are missing.
2. Create the token manager (`src/token.ts`) and authenticate (`src/auth.ts` → CAS/panda).
   The manager auto-refreshes **5 minutes before expiry**.
3. Persist a refreshed session token back to `channels.omadeus.sessionToken` (skipped when
   unchanged, so config writes stay quiet).
4. Create the `SentMessageTracker` and the inbound handler
   (`createOmadeusMessageHandler`).
5. Create and connect the Jaguar WebSocket client.
6. Publish `tokenManager` / `jaguar` / `sentTracker` into module-level `gatewayState` so
   outbound actions can reach them.
7. Stay alive until OpenClaw aborts, then stop refresh and disconnect the socket.

## 3. The socket

`src/socket/socket.ts` is the shared client; `src/socket/jaguar.socket.ts` wraps it with
`pathSuffix: "ws"` and the `[jaguar]` log prefix.

- URL is `maestroUrl` with `http`→`ws`, plus `?token=<current session token>`.
- If the token needs refreshing before connect, it refreshes first and retries.
- Reconnect backoff: **2s doubling, capped at 60s**, reset on a successful open.
- Heartbeat: sends `{"data":"keep-alive","action":"answer"}` on open, then every **30s**.
  Any inbound frame resets the miss counter; a server `heartbeat` ping is answered
  immediately. After **5** unanswered sends the socket closes so reconnect can take over.
- Keep-alive frames are consumed internally and never surface as events.

Every other frame is JSON-parsed and passed to `onEvent`, where
`isOmadeusMessage(data)` (`type === "message"`, numeric `roomId`, string `body`) splits chat
messages from everything else. Non-messages are logged and discarded.

## 4. Inbound: frame → agent turn

```text
socket frame
  └─ isOmadeusMessage?                      src/socket/jaguar.socket.ts
      └─ sentTracker.isEcho()?  ─── yes ──▶ drop (our own message echoing back)
          └─ parseJaguarMessage()           src/inbound.ts
              └─ handleOmadeusMessage()     src/message-handler.ts
```

`parseJaguarMessage` drops removed messages and empty bodies, detects mentions (from
`details.rawMessage` tokens like `{user_reference_id:123}` and from leading bold mention
text), and strips the mention prefix before the agent sees the body.

From there, `src/message-handler.ts` runs this order — note that **debounce comes first**:

1. **Debounce** — `inboundDebouncer.enqueue(...)`, keyed by `omadeus:<roomId>:<senderId>`.
   Control commands and empty bodies bypass debouncing. When several messages flush together
   their bodies are joined with newlines and all their ids are acknowledged.
2. **Resolve the DM counterparty** — `src/direct-resolver.ts` looks up who this direct room is
   *with* (cached per room; falls back to a full list once). Transient API failures are
   retried with a short backoff before giving up; a real outage fails closed. Admission
   depends on this, not on the sender.
3. **Inbound policy** — `src/inbound-policy.ts`. Drops with a reason, logged at `info`:
   `not_direct_room`, `direct_disabled`, `direct_openclaw_authored`,
   `direct_not_openclaw_room`. `requireMention` is not enforced — see AGENTS.md.
4. **Control-command gate** — `resolveControlCommandGate(...)` with an explicit authorizer,
   since the only room served is the operator's own DM.
5. **Text check** — an admitted message with no usable text (attachment-only, bare mention)
   is acknowledged and answered with a short "text only" reply, then the turn ends. This runs
   *after* admission so it can never fire in another room.
6. **Acknowledge** — `seeMessage(...)` marks the source message(s) read, fire-and-forget.
   Sent with `asOpenclaw: true`, so Jaguar records the receipt against the OpenClaw bot
   rather than the operator (whose own message it is).
7. **Route** — `resolveAgentRoute({ peer: { kind: "direct", id: senderId } })` yields
   `sessionKey` / `agentId` / `accountId`.
8. **System event** — a one-line preview is queued for the agent's ambient context.
9. **Dispatch** — `core.channel.inbound.run(...)` with an `{ ingest, resolveTurn }` adapter.

The turn kernel then owns ingest → classify → preflight → resolve → record → dispatch →
finalize. `resolveTurn` builds the context via `core.channel.inbound.buildContext(...)` and
returns the assembled turn, including the delivery adapter from `src/reply-dispatcher.ts`.

`messageId` carries the Jaguar message id into the context as `MessageSid`.

## 5. Reply → room

`createOmadeusTurnDelivery` (`src/reply-dispatcher.ts`) supplies three things to the kernel:

- **`delivery`** — `durable()` names the target room; `deliver(payload)` chunks the text
  (`resolveTextChunkLimit`, 4000 default, markdown-aware) and sends each chunk.
- **`dispatcherOptions`** — the response prefix context.
- **`replyOptions`** — `onModelSelected`, plus `sourceReplyDeliveryMode: "automatic"` when
  `messages.visibleReplies` is unset. (See the `visibleReplies` gotcha in AGENTS.md — this is
  what stops replies from silently vanishing on tool-shy models.)

The kernel owns the dispatcher lifecycle: typing indicators, block buffering, settle, and
error handling.

## 6. Outbound send

All sends converge on `sendOmadeusText` in `src/channel.ts`, then:

```text
sendOmadeusMessage()                    src/outbound.ts
  ├─ generateTemporaryId()
  ├─ sentTracker.trackOutbound(...)     BEFORE the HTTP call — the echo can beat the response
  ├─ sendRoomMessage()                  POST /jaguar/apiv1/rooms/:id/messages
  └─ sentTracker.trackId(result.id)
```

Two callers reach it:

- The **message adapter** (`plugin.message`, built with
  `createChannelMessageAdapterFromOutbound`) — core's durable send path, used by
  `message(action=send)` via `actions.prepareSendPayload`.
- The **outbound adapter** (`plugin.outbound`) — the reply path and other core delivery.

`actions.handleAction`'s `send` branch remains as a fallback for paths that bypass
`prepareSendPayload`.

Targets are room ids only: `room:123` or `123`. `outbound.resolveTarget` and
`messaging.targetResolver` both reject anything else.

## 7. Message actions

`actions.describeMessageTool` advertises exactly one action — `send` — when the channel is
enabled and configured. `supportsAction` claims only that; `edit`, `delete`, `react`, and
everything else fall through to the SDK's shared handling instead of reaching `handleAction`.

## 8. Setup

- `src/setup-core.ts` — validates input, writes `channels.omadeus`.
- `src/setup-surface.ts` — exports `omadeusSetupWizard`.
- `src/onboarding.ts` — the interactive wizard: environment → credentials → organization →
  OpenClaw member lookup.

The wizard always resolves the OpenClaw bot member by the hardcoded email
`openclaw@xeba.tech`; it is never user-selectable. Its `referenceId` is written to
`openClawReferenceId` and is what the inbound policy compares against.

Config written under `channels.omadeus`: `enabled`, `environment`, `email`, `password`,
`organizationId`, `sessionToken`, `sessionTokenEnvironment`, `openClawReferenceId`, and
`inbound.direct` (`enabled`, `allowedSenderReferenceIds`, and `requireMention` —
still accepted by the schema for backwards compatibility, but no longer enforced).

Environment variables read during setup: `OMADEUS_EMAIL`, `OMADEUS_PASSWORD`,
`OMADEUS_ORGANIZATION_ID`.
