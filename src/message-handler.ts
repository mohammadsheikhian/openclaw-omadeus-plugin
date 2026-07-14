import {
  DEFAULT_ACCOUNT_ID,
  logInboundDrop,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import {
  createNugget,
  findNuggetByTaskChannelRoom,
  readNuggetNumber,
  resolveTaskChannelRoomId,
  searchNuggetByNumber,
} from "./api/nugget.api.js";
import { seeMessage } from "./api/message.api.js";
import { createDirectCounterpartyResolver } from "./direct-resolver.js";
import {
  appendNuggetContextForTaskOrNuggetRoom,
  appendNuggetLookupContextForAgent,
  messageNeedsTaskRoomNuggetContext,
  parseChannelTaskCreateIntent,
  parseNuggetLookupIntent,
  parseRecurringScheduleIntent,
} from "./nugget-lookup.js";
import type { OutboundDeps } from "./outbound.js";
import { createOmadeusReplyDispatcher } from "./reply-dispatcher.js";
import { getOmadeusChannelConfig } from "./config.js";
import { evaluateOmadeusInboundPolicy } from "./inbound-policy.js";
import { getOmadeusRuntime } from "./runtime.js";
import {
  type OmadeusInboundMessage,
  OMADEUS_INBOUND_ENTITY_KIND_SET,
} from "./types.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
};

const SK = "`subscribableKind`";

/** Injected into BodyForAgent so the model uses Jaguar room kind, not invented OpenClaw `task/...` keys. */
function buildOmadeusEntityRoomContextLine(kind: string): string {
  if (kind === "task") {
    return `This chat is an **Omadeus Task** room (${SK} \`task\`). If the user asks about the Task, its status, or says \"the task\", they mean **this** Omadeus Task / this thread — not an OpenClaw \"task\" or a \"session id\" for it.`;
  }
  if (kind === "nugget") {
    return `This chat is an **Omadeus Nugget** room (${SK} \`nugget\`). If the user asks about the Nugget, its status, or colloquially says \"the task\", they mean **this** Omadeus Nugget / this thread — not an OpenClaw \"task\" or a \"session id\" for it. (Task and Nugget are different; infer from this room's ${SK}.)`;
  }
  const other: Record<string, string> = {
    project: "Project",
    release: "Release",
    sprint: "Sprint",
    summary: "Summary",
    client: "Client",
    folder: "Folder",
  };
  const label = other[kind] ?? kind;
  return `This chat is an **Omadeus ${label}** room (${SK} \`${kind}\`). User questions refer to that Omadeus ${label} in this thread — not an OpenClaw \"session id\" for it.`;
}

export type OmadeusMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
  /** Authenticated Omadeus user reference id. */
  selfReferenceId: number;
};

export function createOmadeusMessageHandler(deps: OmadeusMessageHandlerDeps) {
  const { cfg, runtime, log, outboundDeps, selfReferenceId } = deps;
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
    const isDirectMessage = inbound.subscribableKind === "direct";
    // Task/Nugget/Project/… Jaguar rooms are 1:1-style threads with the bot. A message only
    // reaches dispatch here after the inbound policy has already enforced any mention requirement,
    // so anything that arrives is addressed to the bot and must get a reply — treat it like a DM.
    const isEntityRoom =
      !isDirectMessage && OMADEUS_INBOUND_ENTITY_KIND_SET.has(String(inbound.subscribableKind));
    const senderId = String(inbound.fromReferenceId);
    const senderName = inbound.from;
    const roomId = String(inbound.roomId);
    const rawBody = inbound.content;

    if (!rawBody.trim()) {
      log.debug?.("skipping empty message");
      return;
    }

    const directCounterpartyReferenceId = isDirectMessage
      ? await directResolver.resolve(inbound.roomId)
      : undefined;

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

    const useAccessGroups =
      (cfg.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;

    const hasControlCommand = core.channel.text.hasControlCommand(rawBody, cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [],
      allowTextCommands: true,
      hasControlCommand,
    });

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: (msg) => log.debug?.(msg),
        channel: "omadeus",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    // Committed to dispatching to the agent — mark the source message(s) seen.
    // Never mark our own messages seen (the user can DM their own instance).
    if (inbound.fromReferenceId !== selfReferenceId) {
      markMessagesSeen(ackMessageIds);
    }

    let bodyForAgent = rawBody;
    const createIntent = parseChannelTaskCreateIntent(rawBody);
    if (createIntent) {
      try {
        const memberReferenceId = inbound.fromReferenceId;
        const created = await createNugget(outboundDeps.apiOpts, {
          title: createIntent.title,
          description: createIntent.description,
          kind: createIntent.kind,
          priority: createIntent.priority,
          stage: "Triage",
          memberReferenceId,
          clientId: 1,
          folderId: 1,
        });
        const createdLabel =
          typeof created["number"] === "number"
            ? `N${created["number"]}`
            : String(created["id"] ?? "created");
        const recurring = parseRecurringScheduleIntent(rawBody);
        if (recurring && typeof created["number"] === "number") {
          const cronExpr = recurring.everyMinutes === 60 ? "0 * * * *" : `*/${recurring.everyMinutes} * * * *`;
          const taskRoomId = resolveTaskChannelRoomId(created);
          const taskTarget = taskRoomId ? `room:${taskRoomId}` : `N${created["number"]}`;
          bodyForAgent =
            `${rawBody}\n\n` +
            `[Omadeus create] Created ${createIntent.kind} ${createdLabel}.\n` +
            `[Scheduling required] The user asked for recurring execution.\n` +
            `You MUST use the cron tool now (no simulation) to add a job with:\n` +
            `- schedule.kind: "cron"\n` +
            `- schedule.expr: "${cronExpr}"\n` +
            `- payload.kind: "agentTurn"\n` +
            `- payload.message: "${createIntent.description}"\n` +
            `- payload.deliver: true\n` +
            `- payload.channel: "omadeus"\n` +
            `- payload.to: "${taskTarget}"\n` +
            `- sessionTarget: "isolated"\n` +
            `- delivery.mode: "announce"\n` +
            `- delivery.channel: "omadeus"\n` +
            `- delivery.to: "${taskTarget}"\n` +
            `Do NOT deliver to the current selected channel; delivery must go only to the created task private channel target above.\n` +
            `Then confirm cron job creation to the user.`;
        } else {
          bodyForAgent = `${rawBody}\n\n[Omadeus create] Created ${createIntent.kind} ${createdLabel}.`;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        runtime.error?.(`omadeus channel-triggered task create failed: ${errorMessage}`);
      }
    }

    const nuggetIntent = parseNuggetLookupIntent(rawBody);
    if (nuggetIntent) {
      try {
        const nugget = await searchNuggetByNumber(outboundDeps.apiOpts, {
          nuggetNumber: nuggetIntent.nuggetNumber,
        });
        bodyForAgent = await appendNuggetLookupContextForAgent(
          rawBody,
          nuggetIntent.nuggetNumber,
          nugget,
          outboundDeps.apiOpts,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        runtime.error?.(`omadeus nugget lookup failed: ${errorMessage}`);
        bodyForAgent = await appendNuggetLookupContextForAgent(
          rawBody,
          nuggetIntent.nuggetNumber,
          null,
          outboundDeps.apiOpts,
          errorMessage,
        );
      }
    }

    // Only enrich with (or reference) this room's live entity when the message actually asks about
    // the work item. Plain chatter ("Hello?", "thanks") must reach the model clean, so it reliably
    // just replies instead of being derailed by imperative data / session-key framing.
    const needsEntityContext = messageNeedsTaskRoomNuggetContext(rawBody);

    const isTaskOrNuggetRoom =
      !isDirectMessage && (inbound.subscribableKind === "task" || inbound.subscribableKind === "nugget");
    if (isTaskOrNuggetRoom && !nuggetIntent && !createIntent && needsEntityContext) {
      try {
        const nugget = await findNuggetByTaskChannelRoom(outboundDeps.apiOpts, {
          roomId: inbound.roomId,
          roomName: inbound.roomName,
          log: (msg, extra) => log.info(msg, extra),
        });
        log.info("omadeus: task-room nugget resolved", {
          roomId: inbound.roomId,
          roomName: inbound.roomName,
          matched: !!nugget,
          nuggetNumber: nugget ? (readNuggetNumber(nugget) ?? null) : null,
        });
        bodyForAgent = await appendNuggetContextForTaskOrNuggetRoom(
          bodyForAgent,
          inbound.roomId,
          inbound.roomName,
          nugget,
          outboundDeps.apiOpts,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        runtime.error?.(`omadeus task room nugget lookup failed: ${errorMessage}`);
        bodyForAgent = await appendNuggetContextForTaskOrNuggetRoom(
          bodyForAgent,
          inbound.roomId,
          inbound.roomName,
          null,
          outboundDeps.apiOpts,
          errorMessage,
        );
      }
    }

    const omadeusFrom = isDirectMessage ? `omadeus:${senderId}` : `omadeus:group:${roomId}`;
    const omadeusTo = isDirectMessage ? `room:${roomId}` : `room:${roomId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "omadeus",
      peer: {
        kind: isDirectMessage ? "direct" : "group",
        id: isDirectMessage ? senderId : roomId,
      },
    });

    // Omadeus entity rooms (Jaguar subscribableKind): see OmadeusInboundEntityKind,
    // OMADEUS_INBOUND_ENTITY_KINDS. Models conflate "task" with OpenClaw and invent `task/<title>` keys.
    // Only append this disambiguation when the message is actually about the entity/its status/session;
    // for a bare greeting it is noise that pushes the model toward internal-session behavior instead of a reply.
    if (isEntityRoom && needsEntityContext) {
      const entityLine = buildOmadeusEntityRoomContextLine(String(inbound.subscribableKind));
      bodyForAgent = `${bodyForAgent}\n\n[OpenClaw] ${entityLine} \`session_status\` is only for **OpenClaw** gateway session state (model/usage, etc.); for that, use this key or \`current\`: ${route.sessionKey} — never \`task/\` + a title as a session key.`;
    }

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Omadeus DM from ${senderName}`
      : `Omadeus message in ${inbound.subscribableKind}/${inbound.roomName ?? roomId} from ${senderName}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `omadeus:message:${roomId}:${inbound.timestamp}`,
    });

    const envelopeFrom = isDirectMessage ? senderName : (inbound.roomName ?? roomId);
    const storePath = core.channel.session.resolveStorePath(
      (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
      { agentId: route.agentId },
    );
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const timestamp = inbound.timestamp ? new Date(inbound.timestamp) : undefined;
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Omadeus",
      from: envelopeFrom,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyForAgent,
      RawBody: rawBody,
      CommandBody: rawBody.trim(),
      BodyForCommands: rawBody.trim(),
      /** Lets the message tool default `react` / `edit` to this Jaguar message id. */
      MessageSid: String(inbound.messageId),
      From: omadeusFrom,
      To: omadeusTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : "group",
      ConversationLabel: envelopeFrom,
      GroupSubject: !isDirectMessage ? (inbound.roomName ?? inbound.subscribableKind) : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "omadeus" as const,
      Surface: "omadeus" as const,
      Timestamp: inbound.timestamp ?? Date.now(),
      WasMentioned: isDirectMessage || isEntityRoom || inbound.isMention,
      CommandAuthorized: commandGate.commandAuthorized,
      OriginatingChannel: "omadeus" as const,
      OriginatingTo: omadeusTo,
    });

    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        log.debug?.(`omadeus: failed updating session meta: ${String(err)}`);
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createOmadeusReplyDispatcher({
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
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions,
          }),
      });

      log.info("dispatch complete", { queuedFinal, counts });
      const finalCount = counts.final;
      if (queuedFinal) {
        log.debug?.(
          `omadeus: delivered ${finalCount} repl${finalCount === 1 ? "y" : "ies"} to room ${roomId}`,
        );
      }
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
