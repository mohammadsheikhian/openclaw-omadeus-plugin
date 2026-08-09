import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat, KEEP_ALIVE_FRAME } from "./heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides: { maxSilentIntervals?: number } = {}) {
  const sent: unknown[] = [];
  const onStale = vi.fn();
  const heartbeat = createHeartbeat({
    send: (payload) => sent.push(payload),
    onStale,
    intervalMs: 1_000,
    ...overrides,
  });
  return { heartbeat, sent, onStale };
}

describe("createHeartbeat", () => {
  it("consumes both spellings of a keep-alive answer", () => {
    const { heartbeat } = setup();
    // The server phrases it with `content`; our own frame echoes back as `data`.
    expect(heartbeat.observe({ content: "keep-alive", action: "answer" })).toBe(true);
    expect(heartbeat.observe({ data: "keep-alive", action: "answer" })).toBe(true);
  });

  it("answers a server ping and consumes it", () => {
    const { heartbeat, sent } = setup();
    expect(heartbeat.observe({ content: "keep-alive", action: "heartbeat" })).toBe(true);
    expect(sent).toEqual([KEEP_ALIVE_FRAME]);
  });

  it("passes a chat frame through", () => {
    const { heartbeat, sent } = setup();
    expect(heartbeat.observe({ type: "message", roomId: 1, body: "hi" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("calls onStale after the tolerated number of quiet intervals", () => {
    vi.useFakeTimers();
    const { heartbeat, onStale } = setup({ maxSilentIntervals: 3 });
    heartbeat.start();

    vi.advanceTimersByTime(2_000);
    expect(onStale).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("counts quiet intervals, so any inbound frame keeps the connection alive", () => {
    vi.useFakeTimers();
    const { heartbeat, onStale } = setup({ maxSilentIntervals: 3 });
    heartbeat.start();

    // Traffic of any kind — not just a keep-alive answer — proves liveness.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(1_000);
      heartbeat.observe({ type: "message", roomId: 1, body: "still here" });
    }

    expect(onStale).not.toHaveBeenCalled();
  });

  it("stops sending after stop(), and start is idempotent", () => {
    vi.useFakeTimers();
    const { heartbeat, sent } = setup();
    heartbeat.start();
    heartbeat.start();
    expect(sent).toHaveLength(1); // the immediate announce, once

    vi.advanceTimersByTime(2_000);
    expect(sent).toHaveLength(3);

    heartbeat.stop();
    heartbeat.stop();
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(3);
  });
});
