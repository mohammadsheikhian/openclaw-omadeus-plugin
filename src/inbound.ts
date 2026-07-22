import type {
  OmadeusInboundMessage,
  OmadeusMessage,
  OmadeusMessageDetails,
} from "./types.js";

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

const USER_REF_PATTERN = /\{user_reference_id:(\d+)\}/g;
const BOLD_MENTION_PREFIX_PATTERN = /^\*\*@[^*]+\*\*/;

/**
 * Parse the `details` JSON string to extract the rawMessage with mention
 * template tokens like `{user_reference_id:87}`.
 */
function parseDetails(raw: string | null): OmadeusMessageDetails | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OmadeusMessageDetails;
  } catch {
    return null;
  }
}

/**
 * Check whether the bot user (by referenceId) is @-mentioned in the message.
 * Omadeus encodes mentions as `{user_reference_id:N}` in details.rawMessage.
 */
function isBotMentioned(details: OmadeusMessageDetails | null, selfReferenceId: number): boolean {
  const raw = details?.rawMessage;
  if (!raw) return false;
  for (const match of raw.matchAll(USER_REF_PATTERN)) {
    if (Number(match[1]) === selfReferenceId) return true;
  }
  return false;
}

/**
 * Fallback mention detection when details.rawMessage is absent.
 * Omadeus often prefixes mentioned messages with `**@Display Name** ...`.
 */
function hasMentionPrefixInBody(body: string): boolean {
  return BOLD_MENTION_PREFIX_PATTERN.test(body.trim());
}

/**
 * Strip the formatted @mention from the body so the agent sees clean text.
 * The body contains `**@Display Name** actual text`; this strips the bold
 * mention prefix when it appears at the start.
 */
function stripLeadingMention(body: string): string {
  return body.replace(/^\*\*@[^*]+\*\*\s*/, "").trim();
}


/**
 * Determine whether a raw Jaguar socket payload is an OmadeusMessage.
 */
export function isOmadeusMessage(data: unknown): data is OmadeusMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "message" && typeof obj.roomId === "number" && typeof obj.body === "string";
}

/**
 * Parse a Jaguar socket message into an OpenClaw inbound message.
 *
 * Returns null when the event is not a chat message, or the message was removed.
 *
 * A message with no usable text (attachment-only, or a bare @mention) is **not** dropped
 * here: it is returned with empty `content` so the caller can run it through the inbound
 * policy first and answer only in the room this channel serves. Dropping it at parse time
 * would either lose it silently or, if answered here, reply in rooms we must stay out of.
 */
export function parseJaguarMessage(
  msg: OmadeusMessage,
  opts: {
    selfReferenceId: number;
  },
  log?: Log,
): OmadeusInboundMessage | null {
  if (msg.type !== "message") {
    log?.debug?.(`[jaguar-inbound] ignoring type: ${msg.type}`);
    return null;
  }

  if (msg.removedAt) return null;

  const body = (msg.body ?? "").trim();
  const details = parseDetails(msg.details);
  const mentioned = isBotMentioned(details, opts.selfReferenceId) || hasMentionPrefixInBody(body);
  const content = mentioned ? stripLeadingMention(body) : body;


  return {
    messageId: msg.id,
    from: String(msg.senderReferenceId),
    fromReferenceId: msg.senderReferenceId,
    content,
    roomId: msg.roomId,
    roomName: msg.roomName,
    subscribableType: msg.subscribableType,
    subscribableKind: msg.subscribableKind,
    isMention: mentioned,
    timestamp: msg.createdAtTimestamp
      ? Math.floor(msg.createdAtTimestamp * 1000)
      : Date.now(),
  };
}
