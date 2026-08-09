import type { OmadeusInboundMessage } from "./types.js";

const CHANNEL = "omadeus" as const;
const PREVIEW_LIMIT = 160;

/** Where the turn kernel should route this message, resolved before the turn is built. */
export type OmadeusTurnRoute = {
  agentId: string;
  accountId: string;
  sessionKey: string;
};

/**
 * Everything one admitted message becomes, as a value.
 *
 * This is the channel's most detailed contract with the turn kernel — the
 * sender, the room, the session, the reply target, and the mention-stripped
 * body, some twenty fields in all. It used to be assembled inside a closure
 * inside the kernel invocation, so the only way to see any of it was to stand
 * up a fake of the whole runtime. Building it as a value costs nothing at
 * runtime and makes every field assertable.
 */
export type OmadeusTurn = {
  senderId: string;
  /** The reply target: `room:<id>`, and there is never another one. */
  to: string;
  /** Whitespace-collapsed and truncated, for logs and the system event. */
  preview: string;
  body: string;
  systemEvent: { text: string; contextKey: string };
  context: OmadeusTurnContext;
};

/** The payload handed to `core.channel.inbound.buildContext`. */
export type OmadeusTurnContext = {
  channel: typeof CHANNEL;
  accountId: string;
  provider: typeof CHANNEL;
  surface: typeof CHANNEL;
  messageId: string;
  timestamp: number;
  from: string;
  sender: { id: string; name: string };
  conversation: { kind: "direct"; id: string; label: string };
  route: {
    agentId: string;
    accountId: string;
    routeSessionKey: string;
    dispatchSessionKey: string;
  };
  reply: { to: string; originatingTo: string };
  message: {
    rawBody: string;
    bodyForAgent: string;
    commandBody: string;
    envelopeFrom: string;
    preview: string;
  };
  extra: { WasMentioned: true; OriginatingChannel: typeof CHANNEL };
};

export function buildOmadeusTurn(params: {
  inbound: OmadeusInboundMessage;
  route: OmadeusTurnRoute;
  roomId: number;
}): OmadeusTurn {
  const { inbound, route, roomId } = params;

  const senderId = String(inbound.fromReferenceId);
  const body = inbound.content;
  const preview = body.replace(/\s+/g, " ").slice(0, PREVIEW_LIMIT);
  const to = `room:${roomId}`;

  return {
    senderId,
    to,
    preview,
    body,
    systemEvent: {
      text: `Omadeus DM from ${senderId}: ${preview}`,
      contextKey: `omadeus:message:${roomId}:${inbound.timestamp}`,
    },
    context: {
      channel: CHANNEL,
      accountId: route.accountId,
      provider: CHANNEL,
      surface: CHANNEL,
      messageId: String(inbound.messageId),
      timestamp: inbound.timestamp,
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
        rawBody: body,
        bodyForAgent: body,
        commandBody: body.trim(),
        envelopeFrom: senderId,
        preview,
      },
      extra: {
        // The channel only serves the OpenClaw DM, so every admitted message is
        // addressed to the bot.
        WasMentioned: true,
        OriginatingChannel: CHANNEL,
      },
    },
  };
}
