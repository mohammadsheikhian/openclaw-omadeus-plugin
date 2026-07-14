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
  it("always allows the logged-in user as a direct sender, even when not in the allowlist", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        // Allowlist deliberately excludes self (e.g. a config written before
        // self was auto-added). Self must still get through.
        direct: { enabled: true, allowedSenderReferenceIds: [201], requireMention: "never" },
      },
    };
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
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

  it("default config allows direct without mention", () => {
    const d = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct" }),
      omadeusCfg: {},
      selfReferenceId: selfRef,
    });
    expect(d.allow).toBe(true);
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

  it("honors direct sender allowlist", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [201], requireMention: "never" },
      },
    };
    const denied = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: 200 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(denied.allow).toBe(false);

    const ok = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: 201 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(ok.allow).toBe(true);
  });

  it("blocks a self-authored direct to an unlisted counterparty", () => {
    // The regression: OpenClaw runs as self (100). The operator DMs an unlisted bot
    // (38) from that shared account, so the message arrives from=self. It's dropped as
    // self-authored (the operator talking to 38), regardless of the allowlist.
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
    if (!d.allow) expect(d.reason).toBe("direct_self_authored");
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
    if (!d.allow) expect(d.reason).toBe("direct_counterparty_not_allowed");
  });

  it("allows a direct from the allowlisted counterparty", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    // Message sent by the allowed counterparty.
    const fromPeer = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 11, fromReferenceId: 210 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: 210,
    });
    expect(fromPeer.allow).toBe(true);
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
    if (!d.allow) expect(d.reason).toBe("direct_self_authored");
  });

  it("still allows a self-authored self-DM (no distinct counterparty) to reach own OpenClaw", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [210], requireMention: "never" },
      },
    };
    // Self-DM: the resolver reports self as the counterparty (or cannot resolve one).
    const asSelfCounterparty = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 5, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
      directCounterpartyReferenceId: selfRef,
    });
    expect(asSelfCounterparty.allow).toBe(true);

    const unresolved = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", roomId: 5, fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(unresolved.allow).toBe(true);
  });

  it("falls back to the sender check when the direct counterparty is unresolved", () => {
    const cfg: OmadeusChannelConfig = {
      inbound: {
        direct: { enabled: true, allowedSenderReferenceIds: [selfRef, 210], requireMention: "never" },
      },
    };
    // Unresolved counterparty + unlisted sender → blocked.
    const denied = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: 999 }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(denied.allow).toBe(false);

    // Unresolved counterparty + self sender → allowed (self shortcut preserved as fallback).
    const ok = evaluateOmadeusInboundPolicy({
      inbound: baseInbound({ subscribableKind: "direct", fromReferenceId: selfRef }),
      omadeusCfg: cfg,
      selfReferenceId: selfRef,
    });
    expect(ok.allow).toBe(true);
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
