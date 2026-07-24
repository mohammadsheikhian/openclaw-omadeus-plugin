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
        direct: { enabled: true, requireMention: "never" },
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

  it("default config blocks direct messages (no OpenClaw member configured)", () => {
    // Without `openClawMemberId` there is no room that can qualify, so every
    // direct is dropped rather than defaulting open.
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct" }),
      omadeusCfg: {},
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("direct_not_openclaw_room");
  });

  it("ignores the direct sender allowlist outside the OpenClaw room", () => {
    // The allowlist no longer admits anyone on its own: room identity is the only gate.
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
        direct: { enabled: true, requireMention: "never" },
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
    // same shape as "operator talking to a third party". `openClawMemberId` is what tells
    // the two apart; without it every message to OpenClaw is dropped as self-authored.
    const cfg: OmadeusChannelConfig = {
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
        direct: { enabled: true, requireMention: "never" },
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
        direct: { enabled: true, requireMention: "never" },
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
        direct: { enabled: true, requireMention: "never" },
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
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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
      openClawMemberId: 300,
      inbound: {
        direct: { enabled: true, requireMention: "never" },
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


  // The channel serves the OpenClaw DM only; every other Jaguar surface is refused here
  // rather than relying on config to keep it disabled.
  it("drops every non-direct room kind", () => {
    const cfg: OmadeusChannelConfig = { openClawMemberId: 900 };
    for (const kind of ["channel", "task", "nugget", "project", "sprint", "release"] as const) {
      const d = evaluateOmadeusInboundPolicy({
        inbound: baseInbound({ subscribableKind: kind, fromReferenceId: 900 }),
        omadeusCfg: cfg,
        selfReferenceId: selfRef,
      });
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toBe("not_direct_room");
    }
  });
});

describe("evaluateOmadeusInboundPolicy — mention handling", () => {
  // There is no way to @mention inside a Jaguar direct, so honouring requireMention
  // would drop every message and silently brick the channel.
  it("admits an unmentioned message even when requireMention is 'always'", () => {
    const cfg: OmadeusChannelConfig = {
      openClawMemberId: 900,
      inbound: { version: 1, direct: { enabled: true, requireMention: "always" } },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: selfRef, isMention: false }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 900,
    });
    expect(d.allow).toBe(true);
  });
});
