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
  createChannelMessageAdapterFromOutbound,
  DEFAULT_ACCOUNT_ID,
  missingTargetError,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../runtime-api.js";
import { generateTemporaryId } from "./utils/http.util.js";
import { configureOpenClawBot, verifyApiKey } from "./api/auth.api.js";
import {
  getOmadeusChannelConfig,
  listOmadeusAccountIds,
  resolveDefaultOmadeusAccountId,
  resolveOmadeusAccount,
  resolveOpenClawMemberId,
} from "./config.js";
import { parseJaguarMessage } from "./inbound.js";
import { createOmadeusMessageHandler } from "./message-handler.js";
import { sendOmadeusMessage, type OutboundDeps } from "./outbound.js";
import { getOmadeusRuntime } from "./runtime.js";
import { SentMessageTracker } from "./sent-message-tracker.js";
import { omadeusSetupAdapter } from "./setup-core.js";
import { omadeusSetupWizard } from "./setup-surface.js";
import { createJaguarSocketClient, type JaguarSocketClient } from "./socket/jaguar.socket.js";
import {
  createApiKeyTokenManager,
  createTokenManager,
  type OmadeusTokenManager,
} from "./token.js";
import type { ResolvedOmadeusAccount as Account } from "./types.js";

const CHANNEL_ID = "omadeus" as const;

const gatewayState: {
  tokenManager: OmadeusTokenManager | null;
  jaguar: JaguarSocketClient | null;
  sentTracker: SentMessageTracker | null;
} = { tokenManager: null, jaguar: null, sentTracker: null };

const isUnconfigured = (account: Account) => account.credentialSource === "none";

let lastPersistedToken: string | null = null;

async function persistSessionToken(token: string): Promise<void> {
  if (lastPersistedToken === token) return;
  const runtime = getOmadeusRuntime();
  const cfg = runtime.config.current() as OpenClawConfig;
  const section = getOmadeusChannelConfig(cfg) ?? {};
  if (section.sessionToken === token) {
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
        },
      };
    },
  });
  lastPersistedToken = token;
}

/** Actions `handleAction` implements; anything else falls back to the shared SDK path. */
const OMADEUS_MESSAGE_ACTIONS = new Set(["send"]);

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
    "casUrl",
    "omadeusUrl",
    "email",
    "password",
    "organizationId",
    "sessionToken",
    "apiKey",
    "openClawMemberId",
    "openClawReferenceId",
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

function readStringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Single outbound send path shared by the outbound adapter and the message adapter. */
async function sendOmadeusText(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  if (!gatewayState.jaguar || !gatewayState.tokenManager) {
    throw new Error("Omadeus: not connected. Is the gateway running with Omadeus enabled?");
  }
  const deps: OutboundDeps = {
    apiOpts: {
      omadeusUrl: resolveOmadeusAccount({ cfg: params.cfg }).omadeusUrl,
      tokenManager: gatewayState.tokenManager,
    },
    sentTracker: gatewayState.sentTracker ?? undefined,
  };
  return await sendOmadeusMessage(deps, { to: params.to, text: params.text });
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
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Omadeus routing: **send** uses the **room id** of this DM (`to` / `target`, e.g. `room:117947` or `117947`).",
      "- This channel only serves the OpenClaw direct room. There are no group, channel, or entity rooms to target.",
      "- `session_status` / SessionKey: **OpenClaw** gateway only. Use the inbound SessionKey or \"current\" — never a fake `task/<...>` string from a title.",
      "- Reply in chat with plain text; use the message tool only for proactive sends.",
    ],
  },
  actions: {
    describeMessageTool: ({ cfg }) => {
      const enabled =
        cfg.channels?.omadeus?.enabled !== false &&
        !isUnconfigured(resolveOmadeusAccount({ cfg }));
      return {
        actions: enabled ? ["send"] : [],
        capabilities: [],
        schema: null,
      };
    },
    supportsAction: ({ action }) => OMADEUS_MESSAGE_ACTIONS.has(action),
    /**
     * Routes `message(action=send)` onto core's durable send path (persist, retry, recover,
     * ack) via the outbound adapter, instead of the legacy plugin-owned `handleAction` path.
     */
    prepareSendPayload: ({ ctx, payload }) => (ctx.action === "send" ? payload : null),
    handleAction: async (ctx) => {
      const account = resolveOmadeusAccount({ cfg: ctx.cfg });
      const apiOpts = () => {
        if (!gatewayState.tokenManager) {
          throw new Error("Omadeus: not connected; gateway must be running with Omadeus enabled.");
        }
        return { omadeusUrl: account.omadeusUrl, tokenManager: gatewayState.tokenManager };
      };

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
            "Omadeus send requires a target: room:<roomId> or a numeric room id.",
            "Missing target.",
          );
        }

        const roomId = normalizeOmadeusRoomId(rawTarget);
        if (!roomId) {
          return actionError(
            `Omadeus send could not resolve target \`${rawTarget}\`. Use room:<roomId> or a numeric room id.`,
            "Unresolved target.",
          );
        }

        try {
          const sent = await sendOmadeusMessage(
            {
              apiOpts: apiOpts(),
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
      "Omadeus requires an apiKey, or email, password, and organizationId. " +
      "Run: openclaw setup omadeus",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: !isUnconfigured(account),
      credentialSource: account.credentialSource,
      baseUrl: account.omadeusUrl,
    }),
  },

  // Used by shared message-tool target resolution.
  messaging: {
    targetResolver: {
      hint: "Use room:<roomId> (matches OpenClaw OriginatingTo) or a numeric Jaguar room id.",
      looksLikeId: (raw) => {
        const t = raw.trim();
        return /^room:\d+$/i.test(t) || /^\d+$/.test(t);
      },
      resolveTarget: async ({ input }) => {
        const id = normalizeOmadeusRoomId(input);
        if (!id) {
          return null;
        }
        return {
          to: id,
          // "user" keeps the outbound session route a direct peer, matching the inbound
          // direct route. "group" here is what produced stray omadeus:group:<room> sessions.
          kind: "user" as const,
          display: `room:${id}`,
          source: "normalized" as const,
        };
      },
    },
  },

  /**
   * Durable send + inbound ack policy, the same contract the bundled channels use.
   *
   * `live` is deliberately absent. Live preview capabilities (`draftPreview`,
   * `progressUpdates`, `previewFinalization`) are *declarations* — the shape carries no
   * implementation hook — and the machinery that edits a streaming draft in place lives in
   * each channel's own outbound builder, not in the shared SDK. Declaring them here would
   * advertise a capability nothing backs. See the note in CLAUDE.md before adding them.
   */
  message: createChannelMessageAdapterFromOutbound<OpenClawConfig>({
    id: CHANNEL_ID,
    outbound: {
      sendText: async (ctx) => {
        const sent = await sendOmadeusText({
          cfg: ctx.cfg as OpenClawConfig,
          to: ctx.to,
          text: ctx.text,
        });
        return { messageId: sent.messageId };
      },
    },
    receive: {
      // Jaguar read receipts are sent once the message reaches the agent, matching the
      // markMessagesSeen call the handler already makes at that point.
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    },
  }),

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: (text, limit) => getOmadeusRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    ...createAttachedChannelResultAdapter({
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text }) => await sendOmadeusText({ cfg, to, text }),
    }),
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      const id = normalizeOmadeusRoomId(trimmed);
      if (!id) {
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
        // Without this id the inbound policy cannot recognise the OpenClaw DM, so every
        // message is dropped while the account otherwise looks healthy. Surface it.
        if (
          entry.enabled !== false &&
          entry.configured === true &&
          resolveOpenClawMemberId(
            getOmadeusChannelConfig(getOmadeusRuntime().config.current() as OpenClawConfig),
          ) === undefined
        ) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: String(entry.accountId ?? DEFAULT_ACCOUNT_ID),
            kind: "config",
            message:
              "Omadeus openClawMemberId is missing; no direct messages will be answered.",
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
      baseUrl: account.omadeusUrl,
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
      if (!account.apiKey && !account.password && !hasCachedSession) {
        ctx.log?.warn("[omadeus] skipping start: apiKey/password/sessionToken not set");
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: "apiKey/password/sessionToken not set",
        });
        return;
      }

      const log = ctx.log ?? { info: () => {}, warn: () => {}, error: () => {} };
      let isConnected = false;

      let tokenManager: OmadeusTokenManager;
      let selfReferenceId: number;

      if (account.apiKey) {
        // API-key mode: nothing to refresh or persist. Verify the key once so
        // a revoked/typoed key fails loudly at start, and resolve the member
        // identity from it (there is no JWT payload to read).
        tokenManager = createApiKeyTokenManager(account.apiKey);
        try {
          const identity = await verifyApiKey({
            omadeusUrl: account.omadeusUrl,
            apiKey: account.apiKey,
          });
          selfReferenceId = identity.memberId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[omadeus] API key verification failed: ${msg}`);
          ctx.setStatus({ accountId: account.accountId, running: false, lastError: msg });
          return;
        }
      } else {
        const casTokenManager = createTokenManager({
          casUrl: account.casUrl,
          omadeusUrl: account.omadeusUrl,
          email: account.email,
          password: account.password,
          organizationId: account.organizationId,
          initialToken: account.sessionToken,
          onRefresh: (token) => {
            log.info("[omadeus] token refreshed");
            void persistSessionToken(token).catch((err) =>
              log.warn(`[omadeus] failed to persist session token: ${String(err)}`),
            );
          },
          onError: (err) => {
            log.error(`[omadeus] token refresh failed: ${err.message}`);
            ctx.setStatus({ accountId: account.accountId, lastError: err.message });
          },
        });

        try {
          await casTokenManager.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[omadeus] initial auth failed: ${msg}`);
          ctx.setStatus({ accountId: account.accountId, running: false, lastError: msg });
          return;
        }

        casTokenManager.startAutoRefresh();
        tokenManager = casTokenManager;
        selfReferenceId = casTokenManager.getPayload().referenceId;
      }

      gatewayState.tokenManager = tokenManager;

      const sentTracker = new SentMessageTracker();
      gatewayState.sentTracker = sentTracker;

      const outboundDeps: OutboundDeps = {
        apiOpts: { omadeusUrl: account.omadeusUrl, tokenManager },
        sentTracker,
      };

      /**
       * Report `connected` to Omadeus once the websocket is up. Never throws:
       * the socket is already healthy at this point, and losing the gateway
       * over a status call would be a worse failure than a stale status.
       */
      const announceConnected = () => {
        configureOpenClawBot({
          omadeusUrl: account.omadeusUrl,
          authorization: tokenManager.authorizationHeader(),
          openclawStatus: "connected",
        })
          .then(() => log.info("[omadeus] reported OpenClaw status: connected"))
          .catch((err) =>
            log.warn(
              "[omadeus] failed to report connected status; the OpenClaw DM will " +
                `keep going to the setup assistant: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            ),
          );
      };

      const handleMessage = createOmadeusMessageHandler({
        cfg,
        runtime: ctx.runtime,
        log,
        outboundDeps,
        selfReferenceId,
      });

      const jaguar = createJaguarSocketClient({
        omadeusUrl: account.omadeusUrl,
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
            sentTracker.isEcho({ id: msg.id, temporaryId: msg.temporaryId })
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
            // Tell Omadeus the gateway is live. Until this lands, Jaguar keeps
            // routing the member's OpenClaw DM to the setup assistant and
            // refuses `asOpenclaw` on send/see, so the bot cannot answer.
            //
            // Fire-and-forget: a failure here must not tear down a healthy
            // socket, and `onDisconnect` clears `isConnected`, so the next
            // reconnect retries. Hosted instances reach this path too — they
            // boot with OPENCLAW_SKIP_ONBOARDING=1 and never run the wizard.
            announceConnected();
          }
        },
        onDisconnect: () => {
          isConnected = false;
          ctx.setStatus({ accountId: account.accountId, connected: false });
        },
        onError: (err) => ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
      });

      jaguar.connect();
      gatewayState.jaguar = jaguar;

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
        gatewayState.tokenManager = null;
        gatewayState.jaguar = null;
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
