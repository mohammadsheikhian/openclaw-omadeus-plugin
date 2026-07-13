# Omadeus Plugin Flow

This document describes the current flow for `@brantrusnak/openclaw-omadeus`.

## Load And Runtime

OpenClaw discovers the plugin from `package.json`:

- `openclaw.extensions` loads `./index.ts`.
- `openclaw.setupEntry` loads `./setup-entry.ts`.
- `openclaw.channel` provides channel picker metadata.

`index.ts` exports `omadeusPlugin` and `setOmadeusRuntime`, then default-exports `defineChannelPluginEntry(...)`. `setup-entry.ts` default-exports `defineSetupPluginEntry(omadeusPlugin)`. Runtime services are stored by `src/runtime.ts` and read through `getOmadeusRuntime()` where shared OpenClaw helpers are needed.

## Main Plugin Contract

`src/channel.ts` defines `omadeusPlugin`. It is the main integration point OpenClaw calls.

- `capabilities` declares direct/group chat, reactions, no threads/media/native commands, and block streaming.
- `agentPrompt` teaches the agent Omadeus target and action conventions.
- `actions` exposes and handles message-tool actions.
- `reload` watches `channels.omadeus` config changes.
- `setup` and `setupWizard` provide configuration flows.
- `config` resolves account state and status-friendly account descriptions.
- `messaging.targetResolver` normalizes room and task-like targets.
- `outbound` validates targets, chunks text, and sends messages.
- `status` builds channel/account health snapshots.
- `gateway.startAccount` authenticates, connects sockets, and starts inbound processing.

## Gateway Startup

`gateway.startAccount` in `src/channel.ts` is the runtime boot path.

1. Resolve the configured Omadeus account.
2. Skip startup when credentials are missing or no password/session token is available.
3. Create `src/token.ts` token manager and perform initial auth.
4. Persist refreshed session tokens back to `channels.omadeus.sessionToken`.
5. Build an inbound handler with `src/message-handler.ts`.
6. Connect Jaguar chat socket with `src/socket/jaguar.socket.ts`.
7. Connect Dolphin data socket with `src/socket/dolphin.socket.ts`.
8. Store active token/socket references for outbound actions.
9. Keep the account runner alive until OpenClaw aborts it, then stop refresh and disconnect sockets.

Jaguar delivers chat messages. Dolphin currently logs data events for tasks, projects, sprints, and releases.

## Inbound Message Flow

Jaguar chat events enter through `src/channel.ts` and are normalized by `src/inbound.ts`.

`parseJaguarMessage(...)` keeps only non-removed chat messages with non-empty bodies. It detects mentions from `details.rawMessage` tokens such as `{user_reference_id:123}` and from leading bold mention text. Mention prefixes are stripped before the agent sees the content.

`src/message-handler.ts` then processes the normalized message:

1. Drop empty messages.
2. Evaluate `channels.omadeus.inbound` via `src/inbound-policy.ts` (direct, channel, and entity surfaces; sender and room/view allowlists; mention rules). Self-authored Jaguar messages are always dropped.
3. Apply the OpenClaw control-command gate.
4. Debounce regular inbound messages by room and sender.
5. Handle Omadeus task/nugget create intents before dispatch when detected.
6. Add nugget lookup context for references such as task/nugget numbers.
7. Resolve the OpenClaw route (`sessionKey`, `agentId`, `accountId`).
8. Build the agent envelope and context payload.
9. Record inbound session metadata.
10. Dispatch the turn through OpenClaw's reply pipeline.

The context payload sets `MessageSid` to the Jaguar message id. That lets `edit`, `delete`, and `react` default to the current inbound message when the agent invokes a message action from the same turn.

## Reply And Send Flow

Agent replies use `src/reply-dispatcher.ts`.

1. Resolve reply prefix context, text chunk limit, chunk mode, and human delay settings from OpenClaw runtime helpers.
2. Create a reply dispatcher with typing behavior.
3. For each reply payload, split text into chunks.
4. Send each chunk with `sendOmadeusMessage(...)`.

`src/outbound.ts` sends through `sendRoomMessage(...)` in `src/api/message.api.ts`. Send destinations are Omadeus room ids, not message ids.

Valid send targets are:

- `room:123`
- `123`
- task-like targets such as `N123` or `T123` when `messaging.targetResolver` can resolve them to a task room

## Message Actions

`actions.describeMessageTool` advertises `send`, `edit`, `delete`, and `react` when Omadeus is enabled and configured.

`actions.handleAction` currently implements:

- `send` with create intent parameters to create Omadeus tasks/nuggets through `createNugget(...)`.
- `edit` through `editMessage(...)`.
- `delete` through `deleteMessage(...)`.
- `react` through `addMessageReaction(...)`.

Action id rules:

- `send` uses a room target (`to` / `target`) such as `room:123` or `123`.
- `edit`, `delete`, and `react` use Jaguar message ids via `messageId`, `message_id`, or the current inbound `MessageSid`.
- Reaction emoji must be allowed by `src/allowed-reaction-emojis.ts`; unsupported emoji return an ignored success result instead of calling Omadeus.

## Setup Flow

Setup is split across three files:

- `src/setup-core.ts` validates basic setup input and writes `channels.omadeus`.
- `src/setup-surface.ts` exports `omadeusSetupWizard`.
- `src/onboarding.ts` runs the interactive setup wizard, auth checks, OpenClaw bot member lookup (by `openclaw@xeba.tech`), and channel selection.

Supported setup environment variables:

- `OMADEUS_EMAIL`
- `OMADEUS_PASSWORD`
- `OMADEUS_ORGANIZATION_ID`

Primary config fields live under `channels.omadeus`: `enabled`, `casUrl`, `maestroUrl`, `email`, `password`, `organizationId`, `sessionToken`, and `inbound` (Jaguar chat policy for direct messages, channel rooms, and entity rooms).

## Socket Contract

`src/socket/socket.ts` owns shared WebSocket behavior for Jaguar and Dolphin.

- WebSocket URL is built from `maestroUrl`, socket path suffix, and the current token.
- If the token needs refresh before connecting, the socket refreshes first and retries connect.
- Reconnect backoff starts at `2_000ms` and caps at `60_000ms`.
- On open, the socket sends `{"data":"keep-alive","action":"answer"}` immediately and then every `30_000ms`.
- Keep-alive answers reset the missed-heartbeat counter.
- Backend heartbeat pings are answered immediately.
- After 5 unanswered heartbeat sends, the socket closes so reconnect logic can establish a fresh connection.
