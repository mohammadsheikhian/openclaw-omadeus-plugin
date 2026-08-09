import { describe, expect, it } from "vitest";
import type { OmadeusInboundMessage } from "./types.js";
import { buildOmadeusTurn } from "./turn.js";

const ROOM = 777;

const inbound = (overrides: Partial<OmadeusInboundMessage> = {}): OmadeusInboundMessage => ({
  messageId: 42,
  from: "8",
  fromReferenceId: 8,
  content: "hello",
  roomId: ROOM,
  timestamp: 1_700_000_000_000,
  ...overrides,
});

const route = { agentId: "main", accountId: "default", sessionKey: "omadeus:direct:8" };

describe("buildOmadeusTurn", () => {
  it("addresses the reply to the pinned room, not to the sender", () => {
    const turn = buildOmadeusTurn({ inbound: inbound(), route, roomId: ROOM });
    expect(turn.to).toBe(`room:${ROOM}`);
    expect(turn.context.reply).toEqual({ to: `room:${ROOM}`, originatingTo: `room:${ROOM}` });
  });

  it("marks every message as mentioned, because the channel only serves the bot's DM", () => {
    const turn = buildOmadeusTurn({ inbound: inbound(), route, roomId: ROOM });
    expect(turn.context.extra).toEqual({ WasMentioned: true, OriginatingChannel: "omadeus" });
  });

  it("carries the sender id everywhere the owner check will look for it", () => {
    // `senderIsOwner` is decided by matching this against commands.ownerAllowFrom.
    const turn = buildOmadeusTurn({ inbound: inbound(), route, roomId: ROOM });
    expect(turn.senderId).toBe("8");
    expect(turn.context.sender).toEqual({ id: "8", name: "8" });
    expect(turn.context.from).toBe("omadeus:8");
    expect(turn.context.message.envelopeFrom).toBe("8");
    expect(turn.context.conversation).toEqual({ kind: "direct", id: "8", label: "Omadeus DM 8" });
  });

  it("routes both session keys to the resolved route", () => {
    const turn = buildOmadeusTurn({ inbound: inbound(), route, roomId: ROOM });
    expect(turn.context.route).toEqual({
      agentId: "main",
      accountId: "default",
      routeSessionKey: "omadeus:direct:8",
      dispatchSessionKey: "omadeus:direct:8",
    });
  });

  it("collapses whitespace and truncates the preview", () => {
    const turn = buildOmadeusTurn({
      inbound: inbound({ content: `a\n\n  b ${"x".repeat(300)}` }),
      route,
      roomId: ROOM,
    });
    expect(turn.preview).toHaveLength(160);
    expect(turn.preview.startsWith("a b x")).toBe(true);
    expect(turn.context.message.preview).toBe(turn.preview);
  });

  it("keys the system event on room and frame timestamp, so a redelivery dedupes", () => {
    const turn = buildOmadeusTurn({ inbound: inbound(), route, roomId: ROOM });
    expect(turn.systemEvent.contextKey).toBe(`omadeus:message:${ROOM}:1700000000000`);
    expect(turn.systemEvent.text).toBe("Omadeus DM from 8: hello");
  });

  it("passes the body to the agent unchanged, and trims it for command matching", () => {
    const turn = buildOmadeusTurn({
      inbound: inbound({ content: "  /help  " }),
      route,
      roomId: ROOM,
    });
    expect(turn.context.message.rawBody).toBe("  /help  ");
    expect(turn.context.message.bodyForAgent).toBe("  /help  ");
    expect(turn.context.message.commandBody).toBe("/help");
  });
});
