import {
  DEFAULT_ACCOUNT_ID,
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import { seeMessage } from "./api/message.api.js";
import { createDirectCounterpartyResolver } from "./direct-resolver.js";
import { sendOmadeusMessage } from "./outbound.js";
import type { OutboundDeps } from "./outbound.js";
import { createOmadeusTurnDelivery } from "./reply-dispatcher.js";
import { getOmadeusChannelConfig } from "./config.js";
import { evaluateOmadeusInboundPolicy } from "./inbound-policy.js";
import { getOmadeusRuntime } from "./runtime.js";
import type { OpenClawRoomResolver } from "./openclaw-room.js";
import type { OmadeusInboundMessage } from "./types.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type OmadeusMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
  /** Authenticated Omadeus user reference id. */
  selfReferenceId: number;
  /** Kept warm from admitted traffic so targetless outbound sends have a room. */
  openClawRoom?: Pick<OpenClawRoomResolver, "remember">;
};

export function createOmadeusMessageHandler(deps: OmadeusMessageHandlerDeps) {
  const { cfg, runtime, log, outboundDeps, selfReferenceId, openClawRoom } = deps;
  const core = getOmadeusRuntime();
  const omadeusCfg = getOmadeusChannelConfig(cfg);

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "omadeus",
  });

  // Resolves the counterparty of a direct room so admission is gated on WHO the DM is
  // with, not on the sender (the operator shares the bot's account). See direct-resolver.ts.
  const directResolver = createDirectCounterpartyResolver({
    apiOpts: outboundDeps.apiOpts,
    selfReferenceId,
    log,
  });

  /** Mark inbound messages as seen in Omadeus (fire-and-forget). */
  const markMessagesSeen = (messageIds: number[]) => {
    for (const messageId of messageIds) {
      if (!Number.isFinite(messageId)) continue;
      log.info(`omadeus: marking message ${messageId} seen`);
      seeMessage(outboundDeps.apiOpts, { messageId })
        .then(() => log.debug?.(`omadeus: marked message ${messageId} seen`))
        .catch((err) => {
          log.warn(
            `omadeus: failed to mark message ${messageId} seen: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  };

  const handleMessageNow = async (
    inbound: OmadeusInboundMessage,
    ackMessageIds: number[] = [inbound.messageId],
  ) => {
    const senderId = String(inbound.fromReferenceId);
    const senderName = inbound.from;
    const roomId = String(inbound.roomId);
    const rawBody = inbound.content;

    const directCounterpartyReferenceId = await directResolver.resolve(inbound.roomId);

    const policyDecision = evaluateOmadeusInboundPolicy({
      inbound,
      omadeusCfg,
      selfReferenceId,
      directCounterpartyReferenceId,
    });
    if (!policyDecision.allow) {
      log.info("omadeus: dropped message by inbound policy", {
        reason: policyDecision.reason,
        ...(policyDecision.details ?? {}),
        roomId: inbound.roomId,
        kind: inbound.subscribableKind,
        fromReferenceId: inbound.fromReferenceId,
        isMention: inbound.isMention,
      });
      return;
    }

    // Past the policy this room is, by construction, the operator's DM with the OpenClaw
    // member — the exact room a targetless cron announce needs. Recording it here keeps the
    // cache correct for free and covers the case where the connect-time lookup failed.
    openClawRoom?.remember(inbound.roomId);

    const useAccessGroups =
      (cfg.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;

    // The only room this channel serves is the operator's own DM with the OpenClaw bot, so
    // the sender is by construction the account owner. Without an authorizer the shared gate
    // can never authorize (`[].some(...)` is false), which silently swallowed every
    // `/command` instead of running it.
    const hasControlCommand = core.channel.text.hasControlCommand(rawBody, cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [{ configured: true, allowed: true }],
      allowTextCommands: true,
      hasControlCommand,
    });

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: (msg) => log.info(msg),
        channel: "omadeus",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    // Admitted but unusable (attachment-only, or a bare @mention). Answer rather than going
    // silent — but only here, after the policy has confirmed this is the OpenClaw DM.
    if (!rawBody.trim()) {
      log.info("omadeus: message has no usable text", { roomId: inbound.roomId });
      markMessagesSeen(ackMessageIds);
      try {
        await sendOmadeusMessage(outboundDeps, {
          to: roomId,
          text: "I can only read text messages — attachments and media aren't supported yet.",
        });
      } catch (err) {
        log.warn(`omadeus: failed to answer a text-less message: ${String(err)}`);
      }
      return;
    }

    // Committed to dispatching to the agent — mark the source message(s) seen.
    // These are always authored by the operator (the gateway shares their account), so the
    // receipt is recorded as the OpenClaw bot via `asOpenclaw`; see seeMessage.
    markMessagesSeen(ackMessageIds);

    const bodyForAgent = rawBody;
    const omadeusFrom = `omadeus:${senderId}`;
    const omadeusTo = `room:${roomId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "omadeus",
      peer: { kind: "direct", id: senderId },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = `Omadeus DM from ${senderName}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `omadeus:message:${roomId}:${inbound.timestamp}`,
    });

    const envelopeFrom = senderName;
    const storePath = core.channel.session.resolveStorePath(
      (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
      { agentId: route.agentId },
    );

    const { delivery, dispatcherOptions, replyOptions } = createOmadeusTurnDelivery({
      cfg,
      agentId: route.agentId,
      accountId: route.accountId,
      runtime,
      log,
      outboundDeps,
      roomId,
    });

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      await core.channel.inbound.run({
        channel: "omadeus",
        accountId: route.accountId,
        raw: inbound,
        adapter: {
          ingest: (msg) => ({
            id: String(msg.messageId),
            timestamp: msg.timestamp ?? Date.now(),
            rawText: rawBody,
            textForAgent: bodyForAgent,
            textForCommands: rawBody.trim(),
            raw: msg,
          }),
          resolveTurn: (input) => {
            const ctxPayload = core.channel.inbound.buildContext({
              channel: "omadeus",
              accountId: route.accountId,
              provider: "omadeus",
              surface: "omadeus",
              messageId: String(inbound.messageId),
              timestamp: input.timestamp,
              from: omadeusFrom,
              sender: { id: senderId, name: senderName },
              conversation: {
                kind: "direct",
                id: senderId,
                label: envelopeFrom,
              },
              route: {
                agentId: route.agentId,
                accountId: route.accountId,
                routeSessionKey: route.sessionKey,
                dispatchSessionKey: route.sessionKey,
              },
              reply: { to: omadeusTo, originatingTo: omadeusTo },
              message: {
                rawBody,
                bodyForAgent,
                commandBody: rawBody.trim(),
                envelopeFrom,
                preview,
              },
              access: { commands: { authorized: commandGate.commandAuthorized } },
              extra: {
                // The channel only serves the OpenClaw DM, so every admitted message is
                // addressed to the bot.
                WasMentioned: true,
                OriginatingChannel: "omadeus" as const,
              },
            });

            return {
              cfg,
              channel: "omadeus",
              accountId: route.accountId,
              agentId: route.agentId,
              routeSessionKey: route.sessionKey,
              storePath,
              ctxPayload,
              recordInboundSession: core.channel.session.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher:
                core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
              delivery,
              dispatcherOptions,
              replyOptions,
              record: {
                onRecordError: (err: unknown) => {
                  log.debug?.(`omadeus: failed updating session meta: ${String(err)}`);
                },
              },
            };
          },
        },
        log: (event) => {
          if (event.event === "error") {
            log.error("turn error", { stage: event.stage, error: String(event.error) });
            return;
          }
          log.debug?.(`omadeus turn ${event.stage}:${event.event}`, {
            ...(event.reason ? { reason: event.reason } : {}),
          });
        },
      });
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(`omadeus dispatch failed: ${String(err)}`);
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<OmadeusInboundMessage>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      return `omadeus:${entry.roomId}:${entry.fromReferenceId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.content.trim()) return false;
      return !core.channel.text.hasControlCommand(entry.content, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;

      if (entries.length === 1) {
        await handleMessageNow(last);
        return;
      }

      // Combine debounced messages into a single inbound
      const combinedContent = entries
        .map((e) => e.content)
        .filter(Boolean)
        .join("\n");
      if (!combinedContent.trim()) return;

      await handleMessageNow(
        {
          ...last,
          content: combinedContent,
          isMention: entries.some((e) => e.isMention),
        },
        entries.map((e) => e.messageId),
      );
    },
    onError: (err) => {
      runtime.error?.(`omadeus debounce flush failed: ${String(err)}`);
    },
  });

  return async function handleOmadeusMessage(inbound: OmadeusInboundMessage) {
    await inboundDebouncer.enqueue(inbound);
  };
}
