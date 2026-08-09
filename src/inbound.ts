import type { OmadeusInboundMessage, OmadeusMessage } from "./types.js";

type Log = {
  debug?: (msg: string) => void;
};

const BOLD_MENTION_PREFIX_PATTERN = /^\*\*@[^*]+\*\*\s*/;

/** Determine whether a raw Jaguar socket payload is a chat message. */
export function isOmadeusMessage(data: unknown): data is OmadeusMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "message" && typeof obj.roomId === "number" && typeof obj.body === "string";
}

/**
 * Parse a Jaguar socket message into an OpenClaw inbound message.
 *
 * A message with no usable text (attachment-only, or a bare `**@mention**`) is
 * **not** dropped here: it comes back with empty `content` so the caller can
 * admit it first and answer only in the room this channel serves.
 */
export function parseJaguarMessage(
  msg: OmadeusMessage,
  log?: Log,
): OmadeusInboundMessage | null {
  if (msg.type !== "message") {
    log?.debug?.(`[jaguar-inbound] ignoring type: ${msg.type}`);
    return null;
  }
  if (msg.removedAt) return null;

  // Omadeus prefixes a mentioning message with `**@Display Name** …`; the agent
  // should see the text without it.
  const content = (msg.body ?? "").trim().replace(BOLD_MENTION_PREFIX_PATTERN, "").trim();

  return {
    messageId: msg.id,
    from: String(msg.senderReferenceId),
    fromReferenceId: msg.senderReferenceId,
    content,
    roomId: msg.roomId,
    timestamp: msg.createdAtTimestamp ? Math.floor(msg.createdAtTimestamp * 1000) : Date.now(),
  };
}

/** Why an inbound message was not handled, or `null` when it should be. */
export type OmadeusDropReason = "other_room" | "openclaw_authored";

/**
 * Decide whether to handle a message. This channel serves exactly one room, so
 * admission is a room-id match plus an author check.
 *
 * The author check is what suppresses echoes of our own replies: every send and
 * every read receipt goes out with `asOpenclaw`, so anything the channel itself
 * produced comes back authored by the OpenClaw bot. The operator's own messages
 * are authored by the operator and pass.
 *
 * Never widen this to compare message bodies. A reply and the operator
 * repeating it ("ok", "1") are indistinguishable by text, and a body match
 * would silently swallow the operator's real message.
 */
export function admitOmadeusMessage(params: {
  inbound: OmadeusInboundMessage;
  roomId: number;
  openClawMemberId: number;
}): OmadeusDropReason | null {
  const { inbound, roomId, openClawMemberId } = params;
  if (inbound.roomId !== roomId) return "other_room";
  if (inbound.fromReferenceId === openClawMemberId) return "openclaw_authored";
  return null;
}
