import {
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-runtime";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { buildComputedAccountStatusSnapshot } from "openclaw/plugin-sdk/status-helpers";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import {
  DEFAULT_ACCOUNT_ID,
  missingTargetError,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  ALLOWED_OMADEUS_REACTION_EMOJI_LIST,
  isAllowedOmadeusReactionEmoji,
} from "./allowed-reaction-emojis.js";
import {
  createNugget,
  resolveTaskRoomIdByNumber,
  type OmadeusNuggetKind,
  type OmadeusNuggetPriority,
} from "./api/nugget.api.js";
import { addMessageReaction, deleteMessage, editMessage } from "./api/message.api.js";
import { generateTemporaryId } from "./utils/http.util.js";
import {
  getOmadeusChannelConfig,
  listOmadeusAccountIds,
  resolveDefaultOmadeusAccountId,
  resolveOmadeusAccount,
} from "./config.js";
import { parseJaguarMessage } from "./inbound.js";
import { createOmadeusMessageHandler } from "./message-handler.js";
import { parseTaskChannelTargetIntent } from "./nugget-lookup.js";
import { sendOmadeusMessage, type OutboundDeps } from "./outbound.js";
import { getOmadeusRuntime } from "./runtime.js";
import { SentMessageTracker } from "./sent-message-tracker.js";
import { omadeusSetupAdapter } from "./setup-core.js";
import { omadeusSetupWizard } from "./setup-surface.js";
import { createDolphinSocketClient, type DolphinSocketClient } from "./socket/dolphin.socket.js";
import { createJaguarSocketClient, type JaguarSocketClient } from "./socket/jaguar.socket.js";
import { createTokenManager, type OmadeusTokenManager } from "./token.js";
import type { ResolvedOmadeusAccount as Account } from "./types.js";

const CHANNEL_ID = "omadeus" as const;

const gatewayState: {
  tokenManager: OmadeusTokenManager | null;
  dolphin: DolphinSocketClient | null;
  jaguar: JaguarSocketClient | null;
  sentTracker: SentMessageTracker | null;
} = { tokenManager: null, dolphin: null, jaguar: null, sentTracker: null };

const isUnconfigured = (account: Account) => account.credentialSource === "none";

let lastPersistedToken: string | null = null;

async function persistSessionToken(
  token: string,
  environment: Account["environment"],
): Promise<void> {
  if (lastPersistedToken === token) return;
  const runtime = getOmadeusRuntime();
  const cfg = runtime.config.current() as OpenClawConfig;
  const section = getOmadeusChannelConfig(cfg) ?? {};
  if (section.sessionToken === token && section.sessionTokenEnvironment === environment) {
    lastPersistedToken = token;
    return;
  }
  await runtime.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      draft.channels = {
        ...(draft.channels ?? {}),
        omadeus: {
          ...(getOmadeusChannelConfig(draft) ?? {}),
          sessionToken: token,
          sessionTokenEnvironment: environment,
        },
      };
    },
  });
  lastPersistedToken = token;
}

/** Actions `handleAction` implements; anything else falls back to the shared SDK path. */
const OMADEUS_MESSAGE_ACTIONS = new Set(["send", "edit", "delete", "react"]);

function actionError(text: string, error = text) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    details: { error },
  };
}

function actionOk(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, channel: CHANNEL_ID, ...payload }) }],
    details: { ok: true, channel: CHANNEL_ID, ...payload },
  };
}

const omadeusConfigAdapter = createTopLevelChannelConfigAdapter<Account>({
  sectionKey: "omadeus",
  resolveAccount: (cfg) => resolveOmadeusAccount({ cfg }),
  listAccountIds: listOmadeusAccountIds,
  defaultAccountId: resolveDefaultOmadeusAccountId,
  deleteMode: "clear-fields",
  clearBaseFields: [
    "environment",
    "email",
    "password",
    "organizationId",
    "sessionToken",
    "sessionTokenEnvironment",
    "inbound",
  ],
  // Keep adapter contract satisfied even though Omadeus no longer uses DM allowlists.
  resolveAllowFrom: () => [],
  formatAllowFrom: () => [],
});

const defaultRuntimeState = {
  accountId: DEFAULT_ACCOUNT_ID,
  running: false,
  connected: false,
  lastConnectedAt: null,
  lastStartAt: null,
  lastStopAt: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastError: null,
} as const;

/** Normalize Jaguar chat target: `room:123` or `123` -> `123` (numeric room id for APIs). */
function normalizeOmadeusRoomId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixed = /^room:(\d+)$/i.exec(trimmed);
  if (prefixed) {
    return prefixed[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

function readReactionMessageId(
  params: Record<string, unknown>,
  toolContext?: { currentMessageId?: string | number },
): number | undefined {
  const raw = params.messageId ?? params.message_id ?? toolContext?.currentMessageId;
  if (raw == null) {
    return undefined;
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : undefined;
}

function readStringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumberParam(params: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function readNuggetKind(params: Record<string, unknown>): OmadeusNuggetKind {
  const raw = readStringParam(params, ["kind", "entity", "type"])?.toLowerCase();
  return raw === "nugget" ? "nugget" : "task";
}

function readNuggetPriority(params: Record<string, unknown>): OmadeusNuggetPriority {
  const raw = readStringParam(params, ["priority"])?.toLowerCase();
  if (raw === "urgent" || raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }
  return "low";
}

function isCreateNuggetRequest(params: Record<string, unknown>): boolean {
  const op = readStringParam(params, ["op", "operation", "intent"])?.toLowerCase();
  if (op === "create_nugget" || op === "create_task") {
    return true;
  }
  const create =
    params["createNugget"] === true ||
    params["createTask"] === true ||
    params["create"] === true ||
    readStringParam(params, ["actionType", "mode"])?.toLowerCase() === "create";
  if (create) {
    return true;
  }
  return Boolean(readStringParam(params, ["title"]) && readStringParam(params, ["description"]));
}

export const omadeusPlugin: ChannelPlugin<Account> = {
  id: "omadeus",
  meta: {
    id: "omadeus",
    label: "Omadeus",
    selectionLabel: "Omadeus (API + WebSocket)",
    docsPath: "",
    docsLabel: "",
    blurb: "AI-native project management that knows your role, speaks your language, and keeps your team in sync. No noise.",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Omadeus routing: **send** uses **room id** (`to` / `target`, e.g. `room:117947` or `117947`). **edit**, **delete**, **react** use the Jaguar **message** `id` (`messageId`, or the current inbound message from context).",
      "- Create Omadeus task/nugget: use `action=send` with params `{ op: \"create_task\"|\"create_nugget\", title, description, priority?, stage?, kind?, memberReferenceId?, clientId?, folderId? }`.",
      "- Omadeus **Task** and **Nugget** are distinct product types (Jaguar `subscribableKind`). **Project**, **Sprint**, **Release**, **Folder**, **Client**, **Summary**, etc. also have entity chat rooms. User \"task\" / \"the task\" → map to **this room's** `subscribableKind` (Task vs Nugget vs other), not an OpenClaw background task.",
      "- In Task or Nugget rooms, inbound may include **Dolphin nuggetviews** JSON for this chat's `roomId` — **summarize that** for status questions. The payload may include a **`people`** object (Omadeus member names). Use those for assignees; do not read `referenceId` numbers as names. Do not tell the user to go use the Omadeus app instead of answering from that data or the thread.",
      "- `session_status` / SessionKey: **OpenClaw** gateway only. Use the inbound SessionKey, \"current\", or the hint in **entity** rooms — never a fake `task/<...>` string from a title.",
      `- Reactions only allow these emojis (others are ignored): ${ALLOWED_OMADEUS_REACTION_EMOJI_LIST.join(" ")}`,
      "- Reply in chat with plain text; use the message tool for proactive sends, edits, deletes, or reactions.",
    ],
  },
  actions: {
    describeMessageTool: ({ cfg }) => {
      const enabled =
        cfg.channels?.omadeus?.enabled !== false &&
        !isUnconfigured(resolveOmadeusAccount({ cfg }));
      return {
        actions: enabled ? ["send", "edit", "delete", "react"] : [],
        capabilities: [],
        schema: null,
      };
    },
    supportsAction: ({ action }) => OMADEUS_MESSAGE_ACTIONS.has(action),
    /**
     * Routes plain `message(action=send)` onto core's durable send path (persist, retry,
     * recover, ack) via the outbound adapter. Returning null keeps an action on the legacy
     * plugin-owned `handleAction` path, which is what create_task/create_nugget still needs
     * since it is not a message delivery at all.
     */
    prepareSendPayload: ({ ctx, payload }) => {
      if (ctx.action !== "send" || isCreateNuggetRequest(ctx.params)) {
        return null;
      }
      return payload;
    },
    handleAction: async (ctx) => {
      const account = resolveOmadeusAccount({ cfg: ctx.cfg });
      const apiOpts = () => {
        if (!gatewayState.tokenManager) {
          throw new Error("Omadeus: not connected; gateway must be running with Omadeus enabled.");
        }
        return { maestroUrl: account.maestroUrl, tokenManager: gatewayState.tokenManager };
      };

      if (ctx.action === "send" && isCreateNuggetRequest(ctx.params)) {
        const title = readStringParam(ctx.params, ["title", "subject", "name"]);
        const description = readStringParam(ctx.params, ["description", "details", "body"]);
        if (!title || !description) {
          return actionError("Omadeus create task/nugget requires `title` and `description`.", "Missing title/description.");
        }

        const kind = readNuggetKind(ctx.params);
        const priority = readNuggetPriority(ctx.params);
        const stage = readStringParam(ctx.params, ["stage"]) ?? "Triage";
        const memberReferenceId =
          readNumberParam(ctx.params, ["memberReferenceId", "assigneeReferenceId"]) ??
          gatewayState.tokenManager?.getPayload().referenceId;
        const clientId = readNumberParam(ctx.params, ["clientId"]) ?? 1;
        const folderId = readNumberParam(ctx.params, ["folderId"]) ?? 1;

        if (!memberReferenceId) {
          return actionError(
            "Omadeus create task/nugget needs `memberReferenceId` or an active authenticated user.",
            "Missing memberReferenceId.",
          );
        }

        try {
          const created = await createNugget(apiOpts(), {
            title,
            description,
            stage,
            kind,
            priority,
            memberReferenceId,
            clientId,
            folderId,
          });
          return actionOk({ action: "create", kind, number: created["number"], id: created["id"], title });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return actionError(msg);
        }
      }

      // Plain text send. Harnesses whose `sourceVisibleReplies` default is `message_tool`
      // (Codex, for example) never auto-deliver the final text — they call the message tool
      // instead, so this path is the only way their replies reach the room.
      if (ctx.action === "send") {
        if (!gatewayState.jaguar) {
          return actionError("Omadeus: not connected. Is the gateway running with Omadeus enabled?");
        }
        const text = readStringParam(ctx.params, ["message", "text", "body"]);
        if (!text) {
          return actionError("Omadeus send requires `message`.", "Missing message.");
        }

        const rawTarget = readStringParam(ctx.params, ["to", "target", "chatId", "chat_id", "roomId"]);
        if (!rawTarget) {
          return actionError(
            "Omadeus send requires a target: room:<roomId>, a numeric room id, or N<number>/T<number>.",
            "Missing target.",
          );
        }

        let roomId = normalizeOmadeusRoomId(rawTarget);
        if (!roomId) {
          const taskIntent = parseTaskChannelTargetIntent(rawTarget);
          const resolved = taskIntent
            ? await resolveTaskRoomIdByNumber(apiOpts(), { nuggetNumber: taskIntent.nuggetNumber })
            : undefined;
          if (!resolved) {
            return actionError(
              `Omadeus send could not resolve target \`${rawTarget}\`. Use room:<roomId> or a numeric room id.`,
              "Unresolved target.",
            );
          }
          roomId = String(resolved);
        }

        try {
          const sent = await sendOmadeusMessage(
            {
              apiOpts: apiOpts(),
              jaguarSocket: gatewayState.jaguar,
              sentTracker: gatewayState.sentTracker ?? undefined,
            },
            { to: roomId, text },
          );
          return actionOk({ action: "send", messageId: sent.messageId, chatId: sent.chatId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return actionError(msg);
        }
      }

      if (ctx.action === "edit") {
        const messageId = readReactionMessageId(ctx.params, ctx.toolContext);
        const body =
          (typeof ctx.params.message === "string" && ctx.params.message.trim()) ||
          (typeof ctx.params.text === "string" && ctx.params.text.trim()) ||
          (typeof ctx.params.content === "string" && ctx.params.content.trim()) ||
          "";
        if (messageId == null) {
          return actionError(
            "Omadeus edit requires `messageId` (Jaguar message id) or current inbound MessageSid.",
            "Missing messageId for edit.",
          );
        }
        if (!body) {
          return actionError(
            "Omadeus edit requires new text in `message`, `text`, or `content`.",
            "Missing body for edit.",
          );
        }
        try {
          const temporaryId = generateTemporaryId();
          // Track before editing so the edit's socket echo is recognized as ours.
          gatewayState.sentTracker?.trackOutbound({ temporaryId, body });
          const edited = await editMessage(apiOpts(), { messageId, body, temporaryId });
          if (typeof edited?.id === "number") {
            gatewayState.sentTracker?.trackId(edited.id);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return actionError(msg);
        }
        return actionOk({ action: "edit", messageId });
      }

      if (ctx.action === "delete") {
        const messageId = readReactionMessageId(ctx.params, ctx.toolContext);
        if (messageId == null) {
          return actionError(
            "Omadeus delete requires `messageId` (Jaguar message id) or current inbound MessageSid.",
            "Missing messageId for delete.",
          );
        }
        try {
          await deleteMessage(apiOpts(), { messageId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return actionError(msg);
        }
        return actionOk({ action: "delete", messageId });
      }

      if (ctx.action === "react") {
        const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
        if (!emoji) {
          return actionError("Omadeus react requires `emoji`.", "Omadeus react requires emoji.");
        }
        if (!isAllowedOmadeusReactionEmoji(emoji)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  channel: CHANNEL_ID,
                  ignored: true,
                  reason: "unsupported_emoji",
                  emoji,
                  allowed: [...ALLOWED_OMADEUS_REACTION_EMOJI_LIST],
                }),
              },
            ],
            details: { ok: true, ignored: true, channel: CHANNEL_ID },
          };
        }
        const messageId = readReactionMessageId(ctx.params, ctx.toolContext);
        if (messageId == null) {
          return actionError(
            "Omadeus react requires `messageId` or a current inbound message id (MessageSid).",
            "Missing messageId for reaction.",
          );
        }
        try {
          await addMessageReaction(apiOpts(), { messageId, emoji });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return actionError(msg);
        }
        return actionOk({ messageId, emoji });
      }

      throw new Error(`Unhandled Omadeus action: ${String(ctx.action)}`);
    },
  },
  reload: { configPrefixes: ["channels.omadeus"] },
  setup: omadeusSetupAdapter,
  setupWizard: omadeusSetupWizard,

  config: {
    ...omadeusConfigAdapter,
    isConfigured: (account) => !isUnconfigured(account),
    unconfiguredReason: () =>
      "Omadeus requires email, password, and organizationId. Run: openclaw setup omadeus",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: !isUnconfigured(account),
      credentialSource: account.credentialSource,
      baseUrl: account.maestroUrl,
    }),
  },

  // Used by shared message-tool target resolution (send, react, etc.).
  messaging: {
    targetResolver: {
      hint: "Use room:<roomId> (matches OpenClaw OriginatingTo) or a numeric Jaguar room id.",
      looksLikeId: (raw) => {
        const t = raw.trim();
        return /^room:\d+$/i.test(t) || /^\d+$/.test(t) || /^[nt]\d+$/i.test(t);
      },
      resolveTarget: async ({ cfg, input }) => {
        const id = normalizeOmadeusRoomId(input);
        if (!id) {
          const taskIntent = parseTaskChannelTargetIntent(input);
          if (!taskIntent || !gatewayState.tokenManager) {
            return null;
          }
          const roomId = await resolveTaskRoomIdByNumber(
            {
              maestroUrl: resolveOmadeusAccount({ cfg }).maestroUrl,
              tokenManager: gatewayState.tokenManager,
            },
            { nuggetNumber: taskIntent.nuggetNumber },
          );
          if (!roomId) {
            return null;
          }
          return {
            to: String(roomId),
            kind: "group",
            display: `${taskIntent.rawPrefix.toUpperCase()}${taskIntent.nuggetNumber}`,
            source: "normalized",
          };
        }
        return {
          to: id,
          kind: "group",
          display: `room:${id}`,
          source: "normalized",
        };
      },
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: (text, limit) => getOmadeusRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    ...createAttachedChannelResultAdapter({
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text }) => {
        if (!gatewayState.jaguar || !gatewayState.tokenManager) {
          throw new Error("Omadeus: not connected. Is the gateway running with Omadeus enabled?");
        }
        const deps: OutboundDeps = {
          apiOpts: {
            maestroUrl: resolveOmadeusAccount({
              cfg,
            }).maestroUrl,
            tokenManager: gatewayState.tokenManager,
          },
          jaguarSocket: gatewayState.jaguar,
          sentTracker: gatewayState.sentTracker ?? undefined,
        };
        return await sendOmadeusMessage(deps, { to, text });
      },
    }),
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      const id = normalizeOmadeusRoomId(trimmed);
      if (!id) {
        if (/^[nt]\d+$/i.test(trimmed)) {
          // Allow task-id-like target to proceed; async target resolver may dock it to a room later.
          return { ok: true, to: trimmed };
        }
        return {
          ok: false,
          error: missingTargetError("Omadeus", "room:<roomId> or numeric room id"),
        };
      }
      return { ok: true, to: id };
    },
  },

  status: {
    defaultRuntime: defaultRuntimeState,
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const issues: ChannelStatusIssue[] = [];
        if (entry.enabled !== false && entry.configured !== true) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: String(entry.accountId ?? DEFAULT_ACCOUNT_ID),
            kind: "config",
            message: "Omadeus credentials are missing.",
            fix: "Run: openclaw setup omadeus",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildPassiveChannelStatusSummary(snapshot, {
        credentialSource: snapshot.credentialSource ?? "none",
        baseUrl: snapshot.baseUrl ?? null,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
      }),
      ...buildTrafficStatusSummary(snapshot),
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: !isUnconfigured(account),
        runtime,
      }),
      baseUrl: account.maestroUrl,
      credentialSource: account.credentialSource,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, abortSignal } = ctx;
      ctx.log?.info(`[omadeus] starting for org ${account.organizationId}`);

      if (isUnconfigured(account)) {
        ctx.log?.warn("[omadeus] skipping start: credentials not configured");
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: "credentials not configured",
        });
        return;
      }

      const hasCachedSession = Boolean(account.sessionToken?.trim());
      if (!account.password && !hasCachedSession) {
        ctx.log?.warn("[omadeus] skipping start: password/sessionToken not set");
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: "password/sessionToken not set",
        });
        return;
      }

      const log = ctx.log ?? { info: () => {}, warn: () => {}, error: () => {} };
      let isConnected = false;

      const tokenManager = createTokenManager({
        casUrl: account.casUrl,
        maestroUrl: account.maestroUrl,
        email: account.email,
        password: account.password,
        organizationId: account.organizationId,
        initialToken: account.sessionToken,
        onRefresh: (token) => {
          log.info("[omadeus] token refreshed");
          void persistSessionToken(token, account.environment).catch((err) =>
            log.warn(`[omadeus] failed to persist session token: ${String(err)}`),
          );
        },
        onError: (err) => {
          log.error(`[omadeus] token refresh failed: ${err.message}`);
          ctx.setStatus({ accountId: account.accountId, lastError: err.message });
        },
      });

      try {
        await tokenManager.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[omadeus] initial auth failed: ${msg}`);
        ctx.setStatus({ accountId: account.accountId, running: false, lastError: msg });
        return;
      }

      tokenManager.startAutoRefresh();
      gatewayState.tokenManager = tokenManager;

      const selfReferenceId = tokenManager.getPayload().referenceId;

      const sentTracker = new SentMessageTracker();
      gatewayState.sentTracker = sentTracker;

      const outboundDeps: OutboundDeps = {
        apiOpts: { maestroUrl: account.maestroUrl, tokenManager },
        jaguarSocket: null as unknown as JaguarSocketClient,
        sentTracker,
      };

      const handleMessage = createOmadeusMessageHandler({
        cfg,
        runtime: ctx.runtime,
        log,
        outboundDeps,
        selfReferenceId,
      });

      const jaguar = createJaguarSocketClient({
        maestroUrl: account.maestroUrl,
        tokenManager,
        log,
        onMessage: (msg) => {
          const label =
            msg.subscribableKind === "direct"
              ? `DM from ${msg.senderReferenceId}`
              : `${msg.subscribableKind}/${msg.roomName ?? msg.roomId} from ${msg.senderReferenceId}`;
          log.info(`[jaguar] ${label}: ${msg.body.slice(0, 80)}`);

          // Suppress echoes of messages we sent (we send as the logged-in
          // account, so our own messages come back over the socket). This
          // replaces the old "drop everything from self" rule, letting the
          // logged-in user message their own OpenClaw.
          if (
            sentTracker.isEcho({
              id: msg.id,
              temporaryId: msg.temporaryId,
              body: msg.body,
              roomId: msg.roomId,
              fromSelf: msg.senderReferenceId === selfReferenceId,
            })
          ) {
            log.debug?.(`[jaguar] suppressed self-echo id=${msg.id}`);
            return;
          }

          const inbound = parseJaguarMessage(msg, { selfReferenceId }, log);
          if (inbound) {
            log.info(
              `[jaguar] inbound: ${inbound.subscribableKind} room=${inbound.roomId} ` +
                `from=${inbound.from} mention=${inbound.isMention}`,
            );
            ctx.setStatus({ accountId: account.accountId, lastInboundAt: Date.now() });
            handleMessage(inbound).catch((err) => {
              log.error(
                `[jaguar] dispatch error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        },
        onOtherEvent: (data) => {
          log.info(`[jaguar] non-message event: ${JSON.stringify(data).slice(0, 120)}`);
        },
        onConnect: () => {
          if (!isConnected) {
            isConnected = true;
            ctx.setStatus({ accountId: account.accountId, connected: true, lastConnectedAt: Date.now() });
          }
        },
        onDisconnect: () => {
          isConnected = false;
          ctx.setStatus({ accountId: account.accountId, connected: false });
        },
        onError: (err) => ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
      });

      const dolphin = createDolphinSocketClient({
        maestroUrl: account.maestroUrl,
        tokenManager,
        log,
        onEvent: (data) => {
          log.info(`[dolphin] event: ${JSON.stringify(data).slice(0, 120)}`);
          // TODO: handle task assignment/update events as they are discovered
        },
        onConnect: () => {
          if (!isConnected) {
            isConnected = true;
            ctx.setStatus({ accountId: account.accountId, connected: true, lastConnectedAt: Date.now() });
          }
        },
        onDisconnect: () => {
          isConnected = false;
          ctx.setStatus({ accountId: account.accountId, connected: false });
        },
        onError: (err) => ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
      });

      // Wire the jaguar socket into outbound deps now that it's created
      outboundDeps.jaguarSocket = jaguar;

      jaguar.connect();
      dolphin.connect();
      gatewayState.jaguar = jaguar;
      gatewayState.dolphin = dolphin;

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        tokenManager.stopAutoRefresh();
        jaguar.disconnect();
        dolphin.disconnect();
        gatewayState.tokenManager = null;
        gatewayState.jaguar = null;
        gatewayState.dolphin = null;
        gatewayState.sentTracker = null;
        lastPersistedToken = null;
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };

      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      cleanup();
    },
  },
};
