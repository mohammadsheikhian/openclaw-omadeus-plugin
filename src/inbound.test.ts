import { describe, expect, it } from "vitest";
import { admitOmadeusMessage, isOmadeusMessage, parseJaguarMessage } from "./inbound.js";
import type { OmadeusMessage } from "./types.js";

const ROOM = 777;
const OPERATOR = 8;
const OPENCLAW = 99;

function message(overrides: Partial<OmadeusMessage> = {}): OmadeusMessage {
  return {
    id: 1,
    type: "message",
    roomId: ROOM,
    senderReferenceId: OPERATOR,
    body: "hello",
    createdAtTimestamp: 1_700_000_000,
    removedAt: null,
    ...overrides,
  };
}

function inbound(overrides: Partial<OmadeusMessage> = {}) {
  const parsed = parseJaguarMessage(message(overrides));
  if (!parsed) throw new Error("expected the message to parse");
  return parsed;
}

describe("isOmadeusMessage", () => {
  it("accepts chat frames and rejects everything else", () => {
    expect(isOmadeusMessage(message())).toBe(true);
    expect(isOmadeusMessage({ type: "seen", roomId: ROOM })).toBe(false);
    expect(isOmadeusMessage(null)).toBe(false);
  });
});

describe("parseJaguarMessage", () => {
  it("strips a leading bold mention so the agent sees clean text", () => {
    expect(inbound({ body: "**@OpenClaw Bot** what is up?" }).content).toBe("what is up?");
  });

  it("keeps a bare mention as empty content rather than dropping the message", () => {
    // The caller answers "text only" instead of going silent, which it can only
    // do if the message survives parsing.
    expect(inbound({ body: "**@OpenClaw Bot**" }).content).toBe("");
  });

  it("drops removed messages", () => {
    expect(parseJaguarMessage(message({ removedAt: "2026-08-08T00:00:00Z" }))).toBeNull();
  });
});

describe("admitOmadeusMessage", () => {
  it("admits the operator's message in the served room", () => {
    expect(
      admitOmadeusMessage({ inbound: inbound(), roomId: ROOM, openClawMemberId: OPENCLAW }),
    ).toBeNull();
  });

  it("drops other rooms", () => {
    expect(
      admitOmadeusMessage({
        inbound: inbound({ roomId: 999 }),
        roomId: ROOM,
        openClawMemberId: OPENCLAW,
      }),
    ).toBe("other_room");
  });

  it("drops our own replies echoing back", () => {
    expect(
      admitOmadeusMessage({
        inbound: inbound({ senderReferenceId: OPENCLAW }),
        roomId: ROOM,
        openClawMemberId: OPENCLAW,
      }),
    ).toBe("openclaw_authored");
  });

  it("admits the operator repeating what OpenClaw just said", () => {
    // Regression guard: echo suppression must key off the author, never the
    // body. Matching on text would swallow the operator's own "ok" whenever it
    // followed an identical reply.
    expect(
      admitOmadeusMessage({
        inbound: inbound({ id: 2, body: "ok" }),
        roomId: ROOM,
        openClawMemberId: OPENCLAW,
      }),
    ).toBeNull();
  });
});
