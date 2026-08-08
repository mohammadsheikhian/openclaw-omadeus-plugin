import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { seeMessage } from "./api/message.api.js";
import { admitOmadeusMessage } from "./inbound.js";
import { sendOmadeusMessage } from "./outbound.js";
import { createOmadeusTurnDelivery } from "./reply.js";
import { getOmadeusRuntime } from "./runtime.js";
import type { OmadeusInboundMessage } from "./types.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

/**
 * Message-only on purpose. The gateway logger accepts a structured second
 * argument and then prints only the message, so anything put there is lost —
 * which is how a drop reason ends up invisible. Narrowing the type here makes
 * that mistake impossible rather than merely discouraged.
 */
type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

const TEXT_ONLY_REPLY =
  "I can only read text messages — attachments and media aren't supported yet.";

export type OmadeusMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  log: Log;
  apiOpts: OmadeusApiOptions;
  /** The one room this channel serves, pinned at startup. */
  roomId: number;
  /** The OpenClaw bot's member reference id, from config. */
  openClawMemberId: number;
};

export function createOmadeusMessageHandler(deps: OmadeusMessageHandlerDeps) {
  const { cfg, runtime, log, apiOpts, roomId, openClawMemberId } = deps;
  const core = getOmadeusRuntime();

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "omadeus",
  });

  /**
   * Mark inbound messages as seen (fire-and-forget).
   *
   * Posted with `asOpenclaw` because the gateway authenticates as the operator
   * and every admitted message is authored by them — Jaguar refuses to let a
   * member see their own message (status 1058).
   */
  const markSeen = (messageIds: number[]) => {
    for (const messageId of messageIds) {
      if (!Number.isFinite(messageId)) continue;
      log.info(`[omadeus] marking message ${messageId} seen`);
      seeMessage(apiOpts, { messageId }).catch((err) => {
        log.warn(
          `[omadeus] failed to mark message ${messageId} seen: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  };

  const handleMessageNow = async (
    inbound: OmadeusInboundMessage,
    ackMessageIds: number[] = [inbound.messageId],
  ) => {
    const senderId = String(inbound.fromReferenceId);
    const rawBody = inbound.content;

    // Admitted but unusable (attachment-only, or a bare @mention). Answer
    // rather than going silent; safe because we only reach it in the one room
    // the channel serves.
    if (!rawBody.trim()) {
      log.info(`[omadeus] message ${inbound.messageId} has no usable text; answering text-only`);
      markSeen(ackMessageIds);
      try {
        await sendOmadeusMessage(apiOpts, { roomId, text: TEXT_ONLY_REPLY });
      } catch (err) {
        log.warn(`[omadeus] failed to answer a text-less message: ${String(err)}`);
      }
      return;
    }

    // Committed to dispatching — acknowledge the source message(s).
    markSeen(ackMessageIds);

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "omadeus",
      peer: { kind: "direct", id: senderId },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const to = `room:${roomId}`;

    core.system.enqueueSystemEvent(`Omadeus DM from ${senderId}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `omadeus:message:${roomId}:${inbound.timestamp}`,
    });

    const storePath = core.channel.session.resolveStorePath(
      (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
      { agentId: route.agentId },
    );

    const { delivery, dispatcherOptions, replyOptions } = createOmadeusTurnDelivery({
      cfg,
      agentId: route.agentId,
      accountId: route.accountId,
      runtime,
      apiOpts,
      roomId,
    });

    log.info(`[omadeus] dispatching message ${inbound.messageId} to agent (session=${route.sessionKey})`);
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
            textForAgent: rawBody,
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
              from: `omadeus:${senderId}`,
              sender: { id: senderId, name: senderId },
              conversation: { kind: "direct", id: senderId, label: `Omadeus DM ${senderId}` },
              route: {
                agentId: route.agentId,
                accountId: route.accountId,
                routeSessionKey: route.sessionKey,
                dispatchSessionKey: route.sessionKey,
              },
              reply: { to, originatingTo: to },
              message: {
                rawBody,
                bodyForAgent: rawBody,
                commandBody: rawBody.trim(),
                envelopeFrom: senderId,
                preview,
              },
              extra: {
                // The channel only serves the OpenClaw DM, so every admitted
                // message is addressed to the bot.
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
                  log.debug?.(`[omadeus] failed updating session meta: ${String(err)}`);
                },
              },
            };
          },
        },
        log: (event) => {
          if (event.event === "error") {
            log.error(`[omadeus] turn error at ${event.stage}: ${String(event.error)}`);
            return;
          }
          log.debug?.(`[omadeus] turn ${event.stage}:${event.event}`);
        },
      });
    } catch (err) {
      log.error(`[omadeus] dispatch failed: ${String(err)}`);
      runtime.error?.(`omadeus dispatch failed: ${String(err)}`);
    }
  };

  const debouncer = core.channel.debounce.createInboundDebouncer<OmadeusInboundMessage>({
    debounceMs: inboundDebounceMs,
    buildKey: () => `omadeus:${roomId}`,
    shouldDebounce: (entry) => Boolean(entry.content.trim()),
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleMessageNow(last);
        return;
      }

      const combined = entries
        .map((e) => e.content)
        .filter(Boolean)
        .join("\n");
      if (!combined.trim()) return;

      await handleMessageNow(
        { ...last, content: combined },
        entries.map((e) => e.messageId),
      );
    },
    onError: (err) => {
      runtime.error?.(`omadeus debounce flush failed: ${String(err)}`);
    },
  });

  return async function handleOmadeusMessage(inbound: OmadeusInboundMessage) {
    // Admission failures log at info, not debug: every silent failure this
    // channel has had was invisible at the default log level.
    const drop = admitOmadeusMessage({ inbound, roomId, openClawMemberId });
    if (drop) {
      // Interpolated, not passed as a second argument: the gateway logger
      // prints the message and discards structured extras, so a drop reason
      // put there is invisible in exactly the situation it exists for.
      log.info(
        `[omadeus] dropped message ${inbound.messageId}: ${drop} ` +
          `(room=${inbound.roomId} from=${inbound.fromReferenceId})`,
      );
      return;
    }

    await debouncer.enqueue(inbound);
  };
}
