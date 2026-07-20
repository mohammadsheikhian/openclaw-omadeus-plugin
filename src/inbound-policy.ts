import {
  type OmadeusChannelConfig,
  type OmadeusInboundMessage,
  type OmadeusInboundPolicy,
  OMADEUS_INBOUND_ENTITY_KIND_SET,
  type OmadeusSubscribableKind,
} from "./types.js";

/** Default inbound policy when `channels.omadeus.inbound` is absent. */
export const DEFAULT_INBOUND_POLICY: Required<
  Pick<OmadeusInboundPolicy, "direct" | "channels" | "entities">
> & { version: number } = {
  version: 1,
  direct: { enabled: true, requireMention: "never" },
  channels: { enabled: false, requireMention: "outsideAllowlist" },
  entities: { enabled: false, requireMention: "always" },
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
  const channels = {
    ...DEFAULT_INBOUND_POLICY.channels,
    ...inbound?.channels,
    requireMention:
      inbound?.channels?.requireMention ?? DEFAULT_INBOUND_POLICY.channels.requireMention,
  };
  const entities = {
    ...DEFAULT_INBOUND_POLICY.entities,
    ...inbound?.entities,
    requireMention:
      inbound?.entities?.requireMention ?? DEFAULT_INBOUND_POLICY.entities.requireMention,
  };
  return { version, direct, channels, entities };
}

function surfaceForKind(kind: OmadeusSubscribableKind): "direct" | "channel" | "entity" {
  if (kind === "direct") return "direct";
  if (kind === "channel") return "channel";
  return "entity";
}

function senderAllowed(
  allowed: number[] | undefined,
  fromReferenceId: number,
  selfReferenceId: number,
): boolean {
  // The logged-in user can always reach their own instance, regardless of the
  // configured allowlist. Their own echoes are filtered earlier by the
  // SentMessageTracker, so this cannot create a reply loop.
  if (fromReferenceId === selfReferenceId) return true;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(fromReferenceId);
}

/**
 * Admission for a **direct** room. Directs are keyed by the counterparty (the other
 * participant), not by the message sender: because OpenClaw runs as an Omadeus user, a
 * DM the operator sends from that shared account arrives with `fromReferenceId === self`
 * and would slip past a sender-based allowlist (see the loop this caused with an
 * unlisted bot account). We therefore gate on the counterparty instead.
 *
 * When the counterparty can't be resolved (membership lookup failed) we fall back to the
 * sender check so a transient API failure doesn't silently drop every DM.
 *
 * TEMPORARILY UNUSED: the direct branch now admits only the OpenClaw room.
 */
function directAllowed(params: {
  allowed: number[] | undefined;
  counterpartyReferenceId: number | undefined;
  fromReferenceId: number;
  selfReferenceId: number;
}): boolean {
  const { allowed, counterpartyReferenceId, fromReferenceId, selfReferenceId } = params;
  if (!allowed || allowed.length === 0) return true;
  // Gate on the counterparty only when there is a distinct one. A self-DM (counterparty
  // is self, or unresolved) falls back to the sender check so the operator can always
  // reach their own OpenClaw.
  if (counterpartyReferenceId !== undefined && counterpartyReferenceId !== selfReferenceId) {
    return allowed.includes(counterpartyReferenceId);
  }
  return senderAllowed(allowed, fromReferenceId, selfReferenceId);
}

function channelGeoAllowed(params: {
  roomId: number;
  channelViewId?: number;
  allowedRoomIds?: number[];
  allowedChannelViewIds?: number[];
}): { geoInAllowlist: boolean; details: Record<string, unknown> } {
  const { roomId, channelViewId, allowedRoomIds = [], allowedChannelViewIds = [] } = params;
  const hasRooms = allowedRoomIds.length > 0;
  const hasViews = allowedChannelViewIds.length > 0;
  let geoInAllowlist = true;
  if (hasRooms && hasViews) {
    geoInAllowlist =
      allowedRoomIds.includes(roomId) ||
      (channelViewId !== undefined && allowedChannelViewIds.includes(channelViewId));
  } else if (hasRooms) {
    geoInAllowlist = allowedRoomIds.includes(roomId);
  } else if (hasViews) {
    geoInAllowlist = channelViewId !== undefined && allowedChannelViewIds.includes(channelViewId);
  }
  return {
    geoInAllowlist,
    details: {
      roomId,
      channelViewId,
      allowedRoomIds,
      allowedChannelViewIds,
      hasRooms,
      hasViews,
      geoInAllowlist,
    },
  };
}

function entityKindAllowed(kind: OmadeusSubscribableKind, allowedKinds?: string[]): boolean {
  if (!allowedKinds || allowedKinds.length === 0) {
    return OMADEUS_INBOUND_ENTITY_KIND_SET.has(String(kind));
  }
  return allowedKinds.includes(String(kind));
}

function entityRoomOk(roomId: number, allowedRoomIds?: number[]): boolean {
  if (!allowedRoomIds || allowedRoomIds.length === 0) return true;
  return allowedRoomIds.includes(roomId);
}

function mentionRequired(params: {
  requireMention?: "never" | "always" | "outsideAllowlist";
  inAllowlist: boolean;
  isMention: boolean;
}): boolean {
  const requireMention = params.requireMention ?? "never";
  const { inAllowlist, isMention } = params;
  if (requireMention === "never") return false;
  if (requireMention === "always") return !isMention;
  // outsideAllowlist
  if (inAllowlist) return false;
  return !isMention;
}

/**
 * Evaluate whether a normalized Jaguar inbound should be dispatched to OpenClaw.
 *
 * The logged-in user (`selfReferenceId`) is treated as an allowed sender for
 * channels, entities, and self-DMs so they can reach their own OpenClaw even if
 * the stored allowlist predates them. In a **direct with a distinct counterparty**
 * the opposite holds: a self-authored message is the operator talking to that other
 * person and is dropped here.
 *
 * The operator's DM with the **OpenClaw member** is the exception to that rule — see the
 * direct branch below. Self-authored *echoes* of OpenClaw's own replies are filtered even
 * earlier, at socket ingestion, by the {@link SentMessageTracker}.
 */
export function evaluateOmadeusInboundPolicy(params: {
  inbound: OmadeusInboundMessage;
  omadeusCfg: OmadeusChannelConfig | undefined;
  selfReferenceId: number;
  /**
   * Resolved counterparty of a direct room (the non-self member). Only meaningful for
   * `subscribableKind === "direct"`. Undefined when unknown/unresolved.
   */
  directCounterpartyReferenceId?: number;
}): InboundPolicyDecision {
  const { inbound, omadeusCfg, selfReferenceId, directCounterpartyReferenceId } = params;

  const policy = mergePolicy(omadeusCfg);
  const surface = surfaceForKind(inbound.subscribableKind);

  if (surface === "direct") {
    if (!policy.direct.enabled) {
      return { allow: false, reason: "direct_disabled", details: { surface } };
    }
    const openClawReferenceId = omadeusCfg?.openClawReferenceId;

    // OpenClaw's own replies are authored by the OpenClaw member (we post them with
    // `asOpenclaw`), so answering them would talk to ourselves. Echoes are normally
    // suppressed at socket ingestion by the SentMessageTracker; this is the structural
    // backstop for when that misses (TTL expiry, gateway restart).
    if (openClawReferenceId !== undefined && inbound.fromReferenceId === openClawReferenceId) {
      return {
        allow: false,
        reason: "direct_openclaw_authored",
        details: { fromReferenceId: inbound.fromReferenceId },
      };
    }

    // The operator's DM with the OpenClaw member IS their own OpenClaw room. OpenClaw is a
    // distinct Omadeus user while the gateway authenticates as the operator, so the
    // operator's messages to it arrive self-authored with OpenClaw as the counterparty.
    const isOpenClawDirect =
      openClawReferenceId !== undefined && directCounterpartyReferenceId === openClawReferenceId;

    // TEMPORARY: the DM with the OpenClaw member is the ONLY room OpenClaw answers.
    // Every other direct is dropped, including:
    //  - 1:1s with other people (the operator talking to them, not to OpenClaw),
    //  - the operator's self-DM (a notes-to-self room; `pickCounterparty` leaves it
    //    unresolved, which previously fell through to the self-sender escape hatch),
    //  - any direct whose counterparty could not be resolved.
    // Note this collapses "self-DM" and "membership lookup failed" into one drop: if the
    // directs API is failing, OpenClaw goes quiet rather than answering the wrong room.
    if (!isOpenClawDirect) {
      return {
        allow: false,
        reason: "direct_not_openclaw_room",
        details: {
          fromReferenceId: inbound.fromReferenceId,
          counterpartyReferenceId: directCounterpartyReferenceId,
          openClawReferenceId,
        },
      };
    }
    const req = policy.direct.requireMention ?? "never";
    if (mentionRequired({ requireMention: req, inAllowlist: true, isMention: inbound.isMention })) {
      return { allow: false, reason: "direct_mention_required", details: { requireMention: req } };
    }
    return { allow: true };
  }

  if (surface === "channel") {
    if (!policy.channels.enabled) {
      return { allow: false, reason: "channels_disabled", details: { surface } };
    }
    if (
      !senderAllowed(policy.channels.allowedSenderReferenceIds, inbound.fromReferenceId, selfReferenceId)
    ) {
      return {
        allow: false,
        reason: "channel_sender_not_allowed",
        details: { fromReferenceId: inbound.fromReferenceId },
      };
    }
    const rv = channelGeoAllowed({
      roomId: inbound.roomId,
      channelViewId: inbound.channelViewId,
      allowedRoomIds: policy.channels.allowedRoomIds,
      allowedChannelViewIds: policy.channels.allowedChannelViewIds,
    });
    const senderInList =
      inbound.fromReferenceId === selfReferenceId ||
      !policy.channels.allowedSenderReferenceIds ||
      policy.channels.allowedSenderReferenceIds.length === 0 ||
      policy.channels.allowedSenderReferenceIds.includes(inbound.fromReferenceId);
    const inAllowlist = rv.geoInAllowlist && senderInList;
    const channelMention =
      policy.channels.requireMention ?? DEFAULT_INBOUND_POLICY.channels.requireMention;
    if (
      mentionRequired({
        requireMention: channelMention,
        inAllowlist,
        isMention: inbound.isMention,
      })
    ) {
      return {
        allow: false,
        reason: "channel_mention_required",
        details: {
          requireMention: channelMention,
          inAllowlist,
          isMention: inbound.isMention,
        },
      };
    }
    return { allow: true };
  }

  // entity
  if (!policy.entities.enabled) {
    return { allow: false, reason: "entities_disabled", details: { kind: inbound.subscribableKind } };
  }
  if (!entityKindAllowed(inbound.subscribableKind, policy.entities.allowedKinds)) {
    return {
      allow: false,
      reason: "entity_kind_not_allowed",
      details: { kind: inbound.subscribableKind, allowedKinds: policy.entities.allowedKinds },
    };
  }
  if (
    !senderAllowed(policy.entities.allowedSenderReferenceIds, inbound.fromReferenceId, selfReferenceId)
  ) {
    return {
      allow: false,
      reason: "entity_sender_not_allowed",
      details: { fromReferenceId: inbound.fromReferenceId },
    };
  }
  if (!entityRoomOk(inbound.roomId, policy.entities.allowedRoomIds)) {
    return {
      allow: false,
      reason: "entity_room_not_allowed",
      details: { roomId: inbound.roomId, allowedRoomIds: policy.entities.allowedRoomIds },
    };
  }

  const roomList = policy.entities.allowedRoomIds ?? [];
  const inAllowlist =
    roomList.length === 0 || roomList.includes(inbound.roomId);
  const entityMention =
    policy.entities.requireMention ?? DEFAULT_INBOUND_POLICY.entities.requireMention;
  if (
    mentionRequired({
      requireMention: entityMention,
      inAllowlist,
      isMention: inbound.isMention,
    })
  ) {
    return {
      allow: false,
      reason: "entity_mention_required",
      details: {
        requireMention: entityMention,
        inAllowlist,
        isMention: inbound.isMention,
      },
    };
  }

  return { allow: true };
}
