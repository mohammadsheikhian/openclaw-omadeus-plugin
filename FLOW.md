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

`gateway.startAccount` in `src/channel.ts`, in order. Any failure sets `lastError` on the
account status and returns — the channel does not start half-configured.

1. **Resolve the account** (`src/config.ts`). Exactly two credential shapes are accepted:
   `apiKey`, or `email` + `password` + `organizationId`. Config is the only source.
2. **Require `openClawMemberId`.** Without it the channel cannot recognise its own replies, so
   it refuses to start rather than risk answering itself.
3. **Build the token manager** (`src/token.ts`):
   - `apiKey` → static, nothing to refresh.
   - password → CAS login through `src/auth.ts`, then auto-refresh **5 minutes before expiry**.
     The token lives in memory only and is never written back to config.
4. **Pin the room** (`src/room.ts`) via `GET /jaguar/apiv1/directs/openclaw_bot`. Jaguar
   resolves the DM from the authenticated member, so no room id is ever guessed. This call
   doubles as the credential check, and it verifies `openClawMemberId` is really a member of
   that room. 5xx and network errors retry; 401/404 fail immediately.
5. **Create the inbound handler** (`src/handler.ts`) bound to that room id.
6. **Connect the socket** (`src/socket/socket.ts`) to `wss://<maestro>/ws?token=…`.
7. On `open`, report `openclawStatus: "connected"` to Dolphin (fire-and-forget). Until this
   lands, Jaguar routes the DM to its own setup assistant and refuses `asOpenclaw`.

Teardown on abort: stop the refresh timer, disconnect the socket, clear the pinned room.

## 3. Inbound: frame → agent turn

```
Jaguar WS frame
  └─ socket.ts            keep-alive? handle and return. otherwise:
     └─ isOmadeusMessage  chat frame, or some other event?
        └─ parseJaguarMessage   normalize; strip a leading **@mention**; drop removed
           └─ admitOmadeusMessage
                ├─ roomId !== pinned      → drop "other_room"      (logged at info)
                ├─ sender === openClaw    → drop "openclaw_authored" (our echo)
                └─ admitted
                   └─ debouncer.enqueue
```

The debouncer groups messages sent in quick succession into one turn, joining their bodies
with newlines and acknowledging every source message. On flush:

1. **No usable text?** (attachment-only, or a bare mention) — mark seen, reply "I can only read
   text messages", stop. This is only reachable after admission, so it never fires in a room
   the channel does not serve.
2. **Mark seen** — `SEE /jaguar/apiv1/messages/:id` with `asOpenclaw: true`, fire-and-forget.
   Sent at dispatch time, matching the declared `after_agent_dispatch` ack policy.
3. **Resolve the route** — `core.channel.routing.resolveAgentRoute` with a direct peer, giving
   the agent id, account id, and session key.
4. **Enqueue a system event** so the turn shows up in OpenClaw's activity.
5. **Build the delivery adapter** (`src/reply.ts`).
6. **Run the turn** — `core.channel.inbound.run` with an adapter that ingests the message and
   resolves a turn from `core.channel.inbound.buildContext`.

## 4. Outbound: reply → room

`src/reply.ts` returns a `delivery` whose `deliver` chunks the text
(`chunkTextWithMode`, 4000 chars, markdown-aware) and posts each chunk through
`sendOmadeusMessage` → `SEND /jaguar/apiv1/rooms/:id/messages` with `asOpenclaw: true`.

`replyOptions.sourceReplyDeliveryMode` is forced to `"automatic"` when
`messages.visibleReplies` is unset, so harnesses that only deliver via the message tool still
get their final text out. An explicit operator setting is never overridden.

Every one of those sends echoes straight back over the socket — authored by the OpenClaw bot,
and therefore dropped at admission. That is the whole echo-suppression design.

## 5. Proactive sends (message tool)

`message(action=send)` goes through `actions.prepareSendPayload` onto core's durable send path
(persist, retry, recover, ack), landing in the outbound adapter. There is no target to resolve:
one room is served, so `resolveTarget` always returns the pinned id and any target the agent
supplied is discarded. `handleAction`'s `send` branch is the fallback for paths that bypass the
durable route.

## 6. Setup (self-hosted only)

`openclaw setup omadeus` runs `omadeusSetupWizard` (`src/onboarding.ts`), a single linear path:

1. Email and password.
2. Organization — listed from `LIST /dolphin/apiv1/organizations` by email, picked from a menu.
3. Authenticate; on failure, offer to re-enter and try again.
4. `GET /jaguar/apiv1/directs/openclaw_bot` → the OpenClaw member is whichever member of that
   DM is not us. Nothing is hardcoded.
5. `POST /dolphin/apiv1/settings/bots/openclaw` with `connecting`.
6. Write `channels.omadeus`: `enabled`, `casUrl`, `omadeusUrl`, `email`, `password`,
   `organizationId`, `openClawMemberId`.

Hosted instances never run this. Their config is rendered by eagle before the gateway starts,
and they boot with `OPENCLAW_SKIP_ONBOARDING=1`.
