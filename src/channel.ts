import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { type ChannelStatusIssue } from "openclaw/plugin-sdk/channel-runtime";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { buildComputedAccountStatusSnapshot } from "openclaw/plugin-sdk/status-helpers";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import {
  createChannelMessageAdapterFromOutbound,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  getOmadeusChannelConfig,
  listOmadeusAccountIds,
  resolveDefaultOmadeusAccountId,
  resolveOmadeusAccount,
} from "./config.js";
import { omadeusSetupWizard } from "./onboarding.js";
import { getOmadeusRuntime } from "./runtime.js";
import { openOmadeusSession, type OmadeusSession } from "./session.js";
import type { OmadeusLog, ResolvedOmadeusAccount as Account } from "./types.js";

const CHANNEL_ID = "omadeus" as const;

/**
 * The running gateway, or `null`.
 *
 * One member is enough: everything a caller needs from a live connection is on
 * the session's own interface. A singleton is correct here — an Omadeus gateway
 * serves exactly one member's DM — but it is now a singleton *of a module*
 * rather than a bag of fields three call sites reach into.
 */
let activeSession: OmadeusSession | null = null;

const isUnconfigured = (account: Account) => account.credentialSource === "none";

function actionError(text: string, error = text) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    details: { error },
  };
}

function actionOk(payload: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ ok: true, channel: CHANNEL_ID, ...payload }) },
    ],
    details: { ok: true, channel: CHANNEL_ID, ...payload },
  };
}

/** Trim, drop empties, dedupe — mirrors the SDK's own string normalization. */
export function normalizeAllowFromEntries(allowFrom: readonly (string | number)[]): string[] {
  const seen: string[] = [];
  for (const entry of allowFrom) {
    const trimmed = String(entry ?? "").trim();
    if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
  }
  return seen;
}

function readStringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** The running session, or an explanation of why there isn't one. */
function requireSession(): OmadeusSession {
  if (!activeSession) {
    throw new Error("Omadeus: not connected. Is the gateway running with Omadeus enabled?");
  }
  return activeSession;
}

async function sendOmadeusText(text: string): Promise<{ messageId: string }> {
  return await requireSession().send(text);
}

const omadeusConfigAdapter = createTopLevelChannelConfigAdapter<Account>({
  sectionKey: "omadeus",
  resolveAccount: (cfg) => resolveOmadeusAccount({ cfg }),
  listAccountIds: listOmadeusAccountIds,
  defaultAccountId: resolveDefaultOmadeusAccountId,
  deleteMode: "clear-fields",
  clearBaseFields: [
    "apiKey",
    "email",
    "password",
    "organizationId",
    "openClawMemberId",
    "casUrl",
    "omadeusUrl",
  ],
  // This channel has no sender allowlist — the room is the allowlist — so
  // there is nothing to resolve.
  resolveAllowFrom: () => [],
  // Must pass values through. The SDK runs BOTH `commands.ownerAllowFrom` and
  // the inbound sender id through this one function
  // (`formatAllowFromList` / `normalizeAllowFromEntry`), then matches the two
  // lists against each other. A stub returning `[]` blanks both sides, so no
  // sender can ever match an owner, `senderIsOwner` stays false, and every
  // owner-only tool — `cron` among them — is silently stripped from the agent.
  // Omadeus senders are plain member reference ids, so trimming is all the
  // normalization they need.
  formatAllowFrom: (allowFrom) => normalizeAllowFromEntries(allowFrom),
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
};

export const omadeusPlugin: ChannelPlugin<Account> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Omadeus",
    selectionLabel: "Omadeus (API + WebSocket)",
    // Empty values make the gateway log "registered incomplete metadata" on
    // every boot and fill them in itself.
    docsPath: "https://github.com/brantrusnak/openclaw-omadeus-plugin#readme",
    docsLabel: "Omadeus plugin docs",
    blurb:
      "AI-native project management that knows your role, speaks your language, and keeps your team in sync. No noise.",
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
      "- Omadeus: reply in chat with plain text. The message tool is only for proactive sends, and it always goes to this one DM — there is no target to choose.",
    ],
  },
  actions: {
    describeMessageTool: ({ cfg }) => {
      const enabled =
        cfg.channels?.omadeus?.enabled !== false &&
        !isUnconfigured(resolveOmadeusAccount({ cfg }));
      return { actions: enabled ? ["send"] : [], capabilities: [], schema: null };
    },
    supportsAction: ({ action }) => action === "send",
    /**
     * Routes `message(action=send)` onto core's durable send path (persist,
     * retry, recover, ack) via the outbound adapter.
     */
    prepareSendPayload: ({ ctx, payload }) => (ctx.action === "send" ? payload : null),
    handleAction: async (ctx) => {
      if (ctx.action !== "send") {
        throw new Error(`Unhandled Omadeus action: ${String(ctx.action)}`);
      }

      // Fallback for harnesses whose `sourceVisibleReplies` default is
      // `message_tool` (Codex): they never auto-deliver final text, so this is
      // the only way their replies reach the room.
      const text = readStringParam(ctx.params, ["message", "text", "body"]);
      if (!text) {
        return actionError("Omadeus send requires `message`.", "Missing message.");
      }

      try {
        const sent = await sendOmadeusText(text);
        return actionOk({ action: "send", messageId: sent.messageId });
      } catch (err) {
        return actionError(err instanceof Error ? err.message : String(err));
      }
    },
  },
  reload: { configPrefixes: ["channels.omadeus"] },
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

  /**
   * Durable send + inbound ack policy, the same contract the bundled channels use.
   *
   * `live` is deliberately absent. Live preview capabilities (`draftPreview`,
   * `progressUpdates`, `previewFinalization`) are *declarations* — the shape carries no
   * implementation hook — and the machinery that edits a streaming draft in place lives in
   * each channel's own outbound builder, not in the shared SDK. Declaring them here would
   * advertise a capability nothing backs. See the note in AGENTS.md before adding them.
   */
  message: createChannelMessageAdapterFromOutbound<OpenClawConfig>({
    id: CHANNEL_ID,
    outbound: {
      sendText: async (ctx) => await sendOmadeusText(ctx.text),
    },
    receive: {
      // Jaguar read receipts are sent once the message reaches the agent, matching the
      // markSeen call the handler already makes at that point.
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
      sendText: async ({ text }) => await sendOmadeusText(text),
    }),
    // One room, so any target resolves to it. Whatever the caller passed is
    // discarded rather than validated: there is no second room a mistake could
    // reach, and rejecting it would only strand a reply the agent meant to send.
    resolveTarget: () => {
      if (!activeSession) {
        return { ok: false as const, error: new Error("Omadeus: not connected.") };
      }
      return { ok: true as const, to: String(activeSession.roomId) };
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
        // Without this id the channel cannot tell its own replies from the
        // operator's messages, so it refuses to start. Surface it as config,
        // not as a runtime error.
        if (
          entry.enabled !== false &&
          entry.configured === true &&
          getOmadeusChannelConfig(getOmadeusRuntime().config.current() as OpenClawConfig)
            ?.openClawMemberId === undefined
        ) {
          issues.push({
            channel: CHANNEL_ID,
            accountId: String(entry.accountId ?? DEFAULT_ACCOUNT_ID),
            kind: "config",
            message: "Omadeus openClawMemberId is missing; the channel will not start.",
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
      const log: OmadeusLog = ctx.log ?? { info: () => {}, warn: () => {}, error: () => {} };
      log.info(`[omadeus] starting for org ${account.organizationId}`);

      const fail = (message: string) => {
        log.error(`[omadeus] ${message}`);
        ctx.setStatus({ accountId: account.accountId, running: false, lastError: message });
      };

      if (isUnconfigured(account)) {
        fail("credentials not configured");
        return;
      }

      const openClawMemberId = account.openClawMemberId;
      if (openClawMemberId === undefined) {
        fail("openClawMemberId is not set; cannot tell OpenClaw's messages from the operator's");
        return;
      }

      let session: OmadeusSession;
      try {
        session = await openOmadeusSession({
          account: { ...account, openClawMemberId },
          cfg,
          runtime: ctx.runtime,
          log,
          events: {
            onInbound: () =>
              ctx.setStatus({ accountId: account.accountId, lastInboundAt: Date.now() }),
            onConnect: () =>
              ctx.setStatus({
                accountId: account.accountId,
                connected: true,
                lastConnectedAt: Date.now(),
              }),
            onDisconnect: () =>
              ctx.setStatus({ accountId: account.accountId, connected: false }),
            onError: (err) =>
              ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
          },
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }

      activeSession = session;
      ctx.setStatus({ accountId: account.accountId, running: true, lastStartAt: Date.now() });

      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      session.close();
      if (activeSession === session) activeSession = null;
      ctx.setStatus({ accountId: account.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};
