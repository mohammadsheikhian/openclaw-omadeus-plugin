# OpenClaw Omadeus Plugin

[![Socket Badge](https://badge.socket.dev/npm/package/@brantrusnak/openclaw-omadeus)](https://badge.socket.dev/npm/package/@brantrusnak/openclaw-omadeus)
[![CI](https://github.com/brantrusnak/openclaw-omadeus-plugin/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/brantrusnak/openclaw-omadeus-plugin/actions/workflows/npm-publish.yml)
[![npm version](https://img.shields.io/npm/v/@brantrusnak/openclaw-omadeus)](https://www.npmjs.com/package/@brantrusnak/openclaw-omadeus)
[![License: ISC](https://img.shields.io/npm/l/@brantrusnak/openclaw-omadeus)](https://www.npmjs.com/package/@brantrusnak/openclaw-omadeus)

[Omadeus](https://omadeus.com) plugin for [OpenClaw](https://www.npmjs.com/package/openclaw).

## What it does

Connects an OpenClaw gateway to Omadeus (Xeba) chat so you can talk to your agent from
Omadeus.

**This channel serves one conversation: your direct message thread with the OpenClaw
Omadeus member.** Group channels, entity rooms (task, nugget, project, sprint, release),
DMs with other people, and your own self-DM are all ignored. If you want the agent in a
shared room, this plugin is not that.

Messages arrive over the Jaguar WebSocket; replies are sent over the Jaguar REST API.
The only message action is `send`. Editing, deleting, and reactions are not supported.
Attachments aren't read either — send one and the agent replies that it can only read text.

## Requirements

- Node.js `>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0` (matching OpenClaw's own `engines`)
- OpenClaw 2026.7.1 or newer
- An Omadeus account, and an OpenClaw bot member (`openclaw@xeba.tech`) in your organization

## Install

```bash
npm install -g openclaw
openclaw plugins install @brantrusnak/openclaw-omadeus
```

Verify the plugin was installed:

```bash
openclaw plugins list
```

Then run setup:

```bash
openclaw onboard
```

Setup asks for your email and password, lets you choose your organization, and resolves the
OpenClaw bot member automatically. It connects to production by default. Set `casUrl` and
`omadeusUrl` under `channels.omadeus` when the endpoints need explicit overrides.

## Configure

```bash
openclaw configure
```

You can also set credentials via environment variables:

```bash
export OMADEUS_EMAIL="you@example.com"
export OMADEUS_PASSWORD="your-password"
export OMADEUS_ORGANIZATION_ID="123"
```

## Start

```bash
openclaw gateway
```

Send a DM to the OpenClaw member in Omadeus and the agent replies in that thread.

### If replies never arrive

Some model harnesses (Codex in particular) default direct chats to `message_tool` visible
replies, which discards the agent's final text unless it explicitly calls the message tool.
This plugin requests automatic delivery by default to avoid that, but an explicit setting in
your OpenClaw config wins. If the gateway log shows
`source-reply/private-final … response kept private`, set:

```jsonc
{
  "messages": { "visibleReplies": "automatic" }
}
```

## Local Development

```bash
npm install
npm run build
openclaw plugins install . --link
```

The runtime loads `dist/`, which is not committed — **re-run `npm run build` after every
source change**, then restart the gateway.

```bash
npm run typecheck   # strict tsc; the build alone does not check types
npm test            # vitest
npm run prepack     # typecheck + build + verify publish surface
```

Contributor notes live in [AGENTS.md](AGENTS.md); the runtime trace is in [FLOW.md](FLOW.md).
