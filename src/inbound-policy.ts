import { resolveOpenClawMemberId } from "./config.js";
import {
  type OmadeusChannelConfig,
  type OmadeusInboundMessage,
  type OmadeusInboundPolicy,
} from "./types.js";

/** Default inbound policy when `channels.omadeus.inbound` is absent. */
export const DEFAULT_INBOUND_POLICY: Required<Pick<OmadeusInboundPolicy, "direct">> & {
  version: number;
} = {
  version: 1,
  direct: { enabled: true, requireMention: "never" },
};

export type InboundPolicyDecision =
  | { allow: true }
  | { allow: false; reason: string; details?: Record<string, unknown> };

function mergePolicy(cfg: OmadeusChannelConfig | undefined) {
  const inbound = cfg?.inbound;
  const version = typeof inbound?.version === "number" && inbound.version >= 1 ? inbound.version : 1;
  const direct = {
    ...DEFAULT_INBOUND_POLICY.direct,
    ...inbound?.direct,
    requireMention: inbound?.direct?.requireMention ?? DEFAULT_INBOUND_POLICY.direct.requireMention,
  };
  return { version, direct };
}

/**
 * Evaluate whether a normalized Jaguar inbound should be dispatched to OpenClaw.
 *
 * This channel serves exactly one room: the operator's DM with the **OpenClaw member**.
 * Everything else — channels, entity rooms (task/nugget/project/…), 1:1s with other
 * people, and the operator's own self-DM — is dropped here.
 *
 * The gateway authenticates as the operator while OpenClaw is a distinct Omadeus user, so
 * the operator's messages to it arrive *self-authored* with OpenClaw as the counterparty.
 * That is why admission keys off the resolved counterparty rather than the sender. Echoes
 * of OpenClaw's own replies are filtered earlier, at socket ingestion, by the
 * {@link SentMessageTracker}; the OpenClaw-authored check below is the structural backstop
 * for when that misses (TTL expiry, gateway restart).
 */
export function evaluateOmadeusInboundPolicy(params: {
  inbound: OmadeusInboundMessage;
  omadeusCfg: OmadeusChannelConfig | undefined;
  selfReferenceId: number;
  /**
   * Resolved counterparty of a direct room (the non-self member).
   * Undefined when unknown/unresolved.
   */
  directCounterpartyReferenceId?: number;
}): InboundPolicyDecision {
  const { inbound, omadeusCfg, directCounterpartyReferenceId } = params;

  const policy = mergePolicy(omadeusCfg);

  if (inbound.subscribableKind !== "direct") {
    return {
      allow: false,
      reason: "not_direct_room",
      details: { kind: inbound.subscribableKind, roomId: inbound.roomId },
    };
  }

  if (!policy.direct.enabled) {
    return { allow: false, reason: "direct_disabled" };
  }

  const openClawMemberId = resolveOpenClawMemberId(omadeusCfg);

  if (openClawMemberId !== undefined && inbound.fromReferenceId === openClawMemberId) {
    return {
      allow: false,
      reason: "direct_openclaw_authored",
      details: { fromReferenceId: inbound.fromReferenceId },
    };
  }

  // Collapses "self-DM" and "membership lookup failed" into one drop: if the directs API is
  // failing, OpenClaw goes quiet rather than answering the wrong room.
  const isOpenClawDirect =
    openClawMemberId !== undefined && directCounterpartyReferenceId === openClawMemberId;
  if (!isOpenClawDirect) {
    return {
      allow: false,
      reason: "direct_not_openclaw_room",
      details: {
        fromReferenceId: inbound.fromReferenceId,
        counterpartyReferenceId: directCounterpartyReferenceId,
        openClawMemberId,
      },
    };
  }

  // `requireMention` is intentionally not enforced here. There is no way to @mention in a
  // Jaguar direct, so honouring "always" would drop every message and silently brick the
  // channel. The room itself is the allowlist.
  return { allow: true };
}
