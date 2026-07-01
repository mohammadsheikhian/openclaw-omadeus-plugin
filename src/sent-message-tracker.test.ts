import { describe, expect, it } from "vitest";
import { SentMessageTracker } from "./sent-message-tracker.js";

describe("SentMessageTracker", () => {
  it("matches an echo by backend id", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ id: 42, temporaryId: "_abc", body: "hi" });
    expect(t.isEcho({ id: 42, fromSelf: true })).toBe(true);
  });

  it("matches an echo by temporaryId even before the id is known", () => {
    const t = new SentMessageTracker();
    t.trackTemporaryId("_abc");
    expect(t.isEcho({ temporaryId: "_abc", fromSelf: true })).toBe(true);
  });

  it("does not match unrelated messages", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ id: 42, temporaryId: "_abc", body: "hi" });
    expect(t.isEcho({ id: 7, temporaryId: "_xyz", body: "other", fromSelf: true })).toBe(false);
  });

  it("uses the content fallback only for self-authored messages", () => {
    const t = new SentMessageTracker();
    t.trackContent(10, "  hello world ");
    // Same text from someone else is NOT suppressed.
    expect(t.isEcho({ roomId: 10, body: "hello world", fromSelf: false })).toBe(false);
    // Same text echoed back to us (no id/tempId) IS suppressed.
    expect(t.isEcho({ roomId: 10, body: "hello world", fromSelf: true })).toBe(true);
  });

  it("scopes the content fallback by room so identical text in another room is not suppressed", () => {
    const t = new SentMessageTracker();
    t.trackContent(10, "same text");
    // Echoed back in the room it was sent to: suppressed.
    expect(t.isEcho({ roomId: 10, body: "same text", fromSelf: true })).toBe(true);
    // Identical self-authored text in a different room: NOT suppressed.
    expect(t.isEcho({ roomId: 20, body: "same text", fromSelf: true })).toBe(false);
  });

  it("matches outbound content regardless of room prefix form", () => {
    const t = new SentMessageTracker();
    // Outbound targets can be "room:123"; the socket echo carries numeric 123.
    t.trackOutbound({ roomId: "room:123", body: "ping" });
    expect(t.isEcho({ roomId: 123, body: "ping", fromSelf: true })).toBe(true);
  });

  it("does not track content without a room id", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ temporaryId: "_abc", body: "no room" });
    expect(t.isEcho({ roomId: 10, body: "no room", fromSelf: true })).toBe(false);
    expect(t.isEcho({ temporaryId: "_abc", fromSelf: true })).toBe(true);
  });

  it("expires entries after the TTL", () => {
    let now = 1000;
    const t = new SentMessageTracker({ ttlMs: 100, now: () => now });
    t.trackOutbound({ id: 5, temporaryId: "_t", body: "x" });
    now = 1050;
    expect(t.isEcho({ id: 5, fromSelf: true })).toBe(true);
    now = 1200; // past TTL
    expect(t.isEcho({ id: 5, temporaryId: "_t", body: "x", fromSelf: true })).toBe(false);
  });

  it("caps the number of tracked ids", () => {
    let now = 0;
    const t = new SentMessageTracker({ maxEntries: 2, now: () => now });
    t.trackId(1);
    now += 1;
    t.trackId(2);
    now += 1;
    t.trackId(3); // evicts the oldest (1)
    expect(t.isEcho({ id: 1, fromSelf: true })).toBe(false);
    expect(t.isEcho({ id: 2, fromSelf: true })).toBe(true);
    expect(t.isEcho({ id: 3, fromSelf: true })).toBe(true);
  });
});
