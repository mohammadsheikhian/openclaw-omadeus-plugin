import { describe, expect, it } from "vitest";
import { SentMessageTracker } from "./sent-message-tracker.js";

describe("SentMessageTracker", () => {
  it("matches an echo by backend id", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ id: 42, temporaryId: "_abc" });
    expect(t.isEcho({ id: 42 })).toBe(true);
  });

  it("matches an echo by temporaryId even before the id is known", () => {
    const t = new SentMessageTracker();
    t.trackTemporaryId("_abc");
    expect(t.isEcho({ temporaryId: "_abc" })).toBe(true);
  });

  it("does not match unrelated messages", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ id: 42, temporaryId: "_abc" });
    expect(t.isEcho({ id: 7, temporaryId: "_xyz" })).toBe(false);
  });

  // Regression: replies are posted with `asOpenclaw`, so they never echo back as the
  // operator. A body-matching fallback could therefore only fire on the operator's own
  // genuine message — dropping it whenever they repeated something OpenClaw just said.
  it("never suppresses a message that merely repeats text we sent", () => {
    const t = new SentMessageTracker();
    t.trackOutbound({ id: 555, temporaryId: "tmp-1" });
    expect(t.isEcho({ id: 999, temporaryId: "tmp-2" })).toBe(false);
  });

  it("expires entries after the TTL", () => {
    let now = 1000;
    const t = new SentMessageTracker({ ttlMs: 100, now: () => now });
    t.trackOutbound({ id: 5, temporaryId: "_t" });
    now = 1050;
    expect(t.isEcho({ id: 5 })).toBe(true);
    now = 1200; // past TTL
    expect(t.isEcho({ id: 5, temporaryId: "_t" })).toBe(false);
  });

  it("caps the number of tracked ids", () => {
    let now = 0;
    const t = new SentMessageTracker({ maxEntries: 2, now: () => now });
    t.trackId(1);
    now += 1;
    t.trackId(2);
    now += 1;
    t.trackId(3); // evicts the oldest (1)
    expect(t.isEcho({ id: 1 })).toBe(false);
    expect(t.isEcho({ id: 2 })).toBe(true);
    expect(t.isEcho({ id: 3 })).toBe(true);
  });
});
