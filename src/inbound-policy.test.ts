import { describe, expect, it } from "vitest";
import { evaluateOmadeusInboundPolicy } from "./inbound-policy.js";
import type { OmadeusChannelConfig, OmadeusInboundMessage } from "./types.js";

const selfRef = 100;

function baseInbound(
  overrides: Partial<OmadeusInboundMessage> & Pick<OmadeusInboundMessage, "subscribableKind">,
): OmadeusInboundMessage {
  const { subscribableKind, subscribableType, ...rest } = overrides;
  return {
    messageId: 1,
    from: "200",
    fromReferenceId: 200,
    content: "hello",
    roomId: 10,
    roomName: "room",
    subscribableType: subscribableType ?? subscribableKind,
    subscribableKind,
    isMention: false,
    timestamp: Date.now(),
    ...rest,
  };
}

describe("evaluateOmadeusInboundPolicy", () => {
  it("drops a self-authored direct that is not the OpenClaw room", () => {
    // TEMPORARY semantics: the logged-in user no longer gets a blanket pass on directs.
    // Only the DM whose counterparty is the OpenClaw member is answered.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [201], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("always allows the logged-in user in channels, even when not in the sender allowlist", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        channels: {
          enabled: true,
          allowedRoomIds: [10],
          // Sender allowlist deliberately excludes self.
          allowedSenderReferenceIds: [201],
          requireMention: "never",
        },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "channel", roomId: 10, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
  });

  it("always allows the logged-in user in entity rooms, even when not in the sender allowlist", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        entities: {
          enabled: true,
          allowedKinds: ["task"],
          // Sender allowlist deliberately excludes self.
          allowedSenderReferenceIds: [201],
          requireMention: "never",
        },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "task", fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
  });

  it("default config blocks direct messages (no OpenClaw member configured)", () => {
    // Without `openClawReferenceId` there is no room that can qualify, so every
    // direct is dropped rather than defaulting open.
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct" }),
      omadeusCfg: {},
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("default config blocks channel messages", () => {
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "channel" }),
      omadeusCfg: {},
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("channels_disabled");
  });

  it("default config blocks entity messages", () => {
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "task" }),
      omadeusCfg: {},
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("entities_disabled");
  });

  it("ignores the direct sender allowlist outside the OpenClaw room", () => {
    // The allowlist no longer admits anyone on its own: room identity is the only gate.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [201], requireMention: "never" },
      },
    };
    for (const fromReferenceId of [200, 201]) {
      const d = evaluateOmadeusInboundPolicy({
        inbound: baseInbound({ subscribableKind: "direct", fromReferenceId }),
        omadeusCfg: cfg,
        selfReferenceId: selfRef,
        directCounterpartyReferenceId: fromReferenceId,
      });
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
    }
  });

  it("blocks a self-authored direct to an unlisted counterparty", () => {
    // The regression: OpenClaw runs as self (100). The operator DMs an unlisted bot
    // (38) from that shared account, so the message arrives from=self. Dropped because
    // 38 is not the OpenClaw member, regardless of the allowlist.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7905, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 38,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("allows the operator's self-authored direct to the OpenClaw member", () => {
    // The setup flow's DM: the room is {operator (self, 100), OpenClaw (300)}. OpenClaw is a
    // distinct Omadeus user but the gateway authenticates as the operator, so a message the
    // operator types to OpenClaw arrives from=self with OpenClaw as the counterparty — the
    // same shape as "operator talking to a third party". `openClawReferenceId` is what tells
    // the two apart; without it every message to OpenClaw is dropped as self-authored.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [300, selfRef], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7905, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 300,
    });
    expect(d.allow).toBe(true);
  });

  it("allows the operator's direct to OpenClaw even when the allowlist omits them", () => {
    // The OpenClaw room is the operator's own instance; it never consults the allowlist.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [210], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7905, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 300,
    });
    expect(d.allow).toBe(true);
  });

  it("never answers a direct authored by OpenClaw itself", () => {
    // OpenClaw's own replies are authored by the OpenClaw member (we post with `asOpenclaw`).
    // The SentMessageTracker normally suppresses these at ingestion; this is the backstop
    // that keeps a missed echo from becoming a reply loop.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [300, selfRef], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7905, fromReferenceId: 300 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 300,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_openclaw_authored");
  });

  it("still drops a self-authored direct to a third party when OpenClaw is configured", () => {
    // The OpenClaw exception is scoped to the OpenClaw room: a DM with a real person (38)
    // keeps main's protection, so the operator's messages to them are never answered.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [300, selfRef, 38], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7906, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 38,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("blocks a direct from an unlisted counterparty", () => {
    // Message genuinely sent BY the counterparty (38), who is not allowlisted.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 7905, fromReferenceId: 38 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 38,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("blocks a direct from an allowlisted counterparty who is not OpenClaw", () => {
    // Previously allowed. Being on the allowlist is no longer sufficient — a real
    // person's DM is not the OpenClaw room.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    const fromPeer = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 11, fromReferenceId: 210 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 210,
    });
    expect(fromPeer.allow).toBe(false);
    if (!fromPeer.allow) expect(fromPeer.reason).toBe("direct_not_openclaw_room");
  });

  it("drops a self-authored direct to a distinct counterparty (operator talking to the other person)", () => {
    // Direct 117870: members self (100) and 210, with 210 allowlisted. When the operator
    // types a message to 210 from the shared account it arrives from=self. OpenClaw must not
    // treat that as a message addressed to it and reply — even though 210 is allowlisted.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 117870, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 210,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("drops the operator's notes-to-self DM", () => {
    // Real case: room 112423 has exactly one member (the operator). `pickCounterparty`
    // finds no non-self member and returns undefined, which used to fall through to the
    // self-sender escape hatch and get processed. A notes-to-self room is not OpenClaw.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [300], requireMention: "never" },
      },
    };
    // Resolver reports self as the counterparty...
    const asSelfCounterparty = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 112423, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: selfRef,
    });
    expect(asSelfCounterparty.allow).toBe(false);
    if (!asSelfCounterparty.allow) {
      expect(asSelfCounterparty.reason).toBe("direct_not_openclaw_room");
    }

    // ...or cannot resolve one at all (the single-member shape above).
    const unresolved = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 112423, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(unresolved.allow).toBe(false);
    if (!unresolved.allow) expect(unresolved.reason).toBe("direct_not_openclaw_room");
  });

  it("drops directs whose counterparty is unresolved, whoever sent them", () => {
    // An unresolved counterparty can mean a self-DM or a failed membership lookup. Both
    // now drop: if the directs API is down OpenClaw goes quiet rather than answering a
    // room it cannot identify.
    const cfg: OmadeusChannelConfig = {
      openClawReferenceId: 300,
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    for (const fromReferenceId of [999, selfRef, 210]) {
      const d = evaluateOmadeusInboundPolicy({
        inbound: baseInbound({ subscribableKind: "direct", fromReferenceId }),
        omadeusCfg: cfg,
        selfReferenceId: selfRef,
      });
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
    }
  });

  it("channel outsideAllowlist: no mention in allowlisted room", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        channels: {
          enabled: true,
          allowedRoomIds: [10],
          allowedSenderReferenceIds: [200],
          requireMention: "outsideAllowlist",
        },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "channel", roomId: 10, isMention: false }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
  });

  it("channel outsideAllowlist: mention required outside room", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        channels: {
          enabled: true,
          allowedRoomIds: [10],
          allowedSenderReferenceIds: [200],
          requireMention: "outsideAllowlist",
        },
      },
    };
    const denied = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "channel", roomId: 99, isMention: false }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(denied.allow).toBe(false);

    const ok = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "channel", roomId: 99, isMention: true }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(ok.allow).toBe(true);
  });

  it("entities: disallowed kind", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        entities: {
          enabled: true,
          allowedKinds: ["task"],
          allowedSenderReferenceIds: [200],
          requireMention: "never",
        },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "project" }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("entity_kind_not_allowed");
  });

  it("entities: summary kind allowed when default entity set applies", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        entities: {
          enabled: true,
          allowedSenderReferenceIds: [200],
          requireMention: "always",
        },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "summary", isMention: true }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
  });

  it("entities: allowed kind with requireMention always", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        entities: {
          enabled: true,
          allowedKinds: ["task"],
          allowedSenderReferenceIds: [200],
          requireMention: "always",
        },
      },
    };
    const denied = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "task", isMention: false }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(denied.allow).toBe(false);

    const ok = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "task", isMention: true }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(ok.allow).toBe(true);
  });
});
