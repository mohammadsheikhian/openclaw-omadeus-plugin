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
 * The logged-in user (`selfReferenceId`) is always treated as an allowed sender
 * so they can message their own OpenClaw even if the stored allowlist predates
 * them. Self-authored *echoes* (the reply loop) are filtered earlier, at socket
 * ingestion, by the {@link SentMessageTracker} — not here.
 */
export function evaluateOmadeusInboundPolicy(params: {
  inbound: OmadeusInboundMessage;
  omadeusCfg: OmadeusChannelConfig | undefined;
  selfReferenceId: number;
}): InboundPolicyDecision {
  const { inbound, omadeusCfg, selfReferenceId } = params;

  const policy = mergePolicy(omadeusCfg);
  const surface = surfaceForKind(inbound.subscribableKind);

  if (surface === "direct") {
    if (!policy.direct.enabled) {
      return { allow: false, reason: "direct_disabled", details: { surface } };
    }
    if (
      !senderAllowed(policy.direct.allowedSenderReferenceIds, inbound.fromReferenceId, selfReferenceId)
    ) {
      return {
        allow: false,
        reason: "direct_sender_not_allowed",
        details: { fromReferenceId: inbound.fromReferenceId },
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
