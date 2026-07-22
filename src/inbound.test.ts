import { describe, expect, it } from "vitest";
import { parseJaguarMessage } from "./inbound.js";
import type { OmadeusMessage } from "./types.js";

const selfRef = 100;

function baseMessage(overrides: Partial<OmadeusMessage> = {}): OmadeusMessage {
  return {
    type: "message",
    id: 1,
    body: "hello",
    senderReferenceId: 200,
    roomId: 10,
    roomName: "room",
    subscribableType: "direct",
    subscribableKind: "direct",
    details: null,
    removedAt: null,
    createdAtTimestamp: 1_700_000_000,
    ...overrides,
  } as OmadeusMessage;
}

describe("parseJaguarMessage", () => {
  it("parses a normal message", () => {
    const parsed = parseJaguarMessage(baseMessage(), { selfReferenceId: selfRef });
    expect(parsed?.content).toBe("hello");
    expect(parsed?.isMention).toBe(false);
  });

  it("strips a leading bold mention and flags it", () => {
    const parsed = parseJaguarMessage(baseMessage({ body: "**@OpenClaw** what is up" }), {
      selfReferenceId: selfRef,
    });
    expect(parsed?.content).toBe("what is up");
    expect(parsed?.isMention).toBe(true);
  });

  it("drops removed messages", () => {
    const parsed = parseJaguarMessage(baseMessage({ removedAt: "2026-01-01T00:00:00Z" }), {
      selfReferenceId: selfRef,
    });
    expect(parsed).toBeNull();
  });

  // Text-less messages must survive parsing so the caller can run them through the inbound
  // policy and answer only in the room this channel serves. Dropping them here would either
  // lose them silently or force a reply in rooms we must stay out of.
  it("keeps an attachment-only message with empty content", () => {
    const parsed = parseJaguarMessage(baseMessage({ body: "" }), {
      selfReferenceId: selfRef,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.content).toBe("");
  });

  it("keeps a bare mention with empty content", () => {
    const parsed = parseJaguarMessage(baseMessage({ body: "**@OpenClaw**" }), {
      selfReferenceId: selfRef,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.content).toBe("");
    expect(parsed?.isMention).toBe(true);
  });
});
