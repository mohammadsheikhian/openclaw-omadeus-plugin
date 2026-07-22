import { describe, expect, it } from "vitest";
import { omadeusPlugin } from "./channel.js";

const actions = omadeusPlugin.actions;

function sendCtx(params: Record<string, unknown>) {
  return { action: "send", params } as never;
}

describe("omadeus message actions", () => {
  describe("supportsAction", () => {
    it("claims the actions handleAction implements", () => {
      expect(actions?.supportsAction?.({ action: "send" })).toBe(true);
    });

    // Unclaimed actions must fall back to the SDK's shared handling instead of
    // reaching handleAction, which throws on anything it does not recognize.
    it("declines actions it does not implement", () => {
      for (const action of ["sendPoll", "react", "edit", "delete"] as const) {
        expect(actions?.supportsAction?.({ action: action as never })).toBe(false);
      }
    });
  });

  describe("prepareSendPayload", () => {
    const payload = { text: "hello" };

    it("routes a plain send onto core's durable path", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: sendCtx({ message: "hello" }),
        to: "119313",
        payload,
      } as never);
      expect(prepared).toBe(payload);
    });

    // The create_task/create_nugget carve-out is gone: this channel only delivers messages,
    // so no send is diverted back to the plugin-owned handleAction path.
    it("routes a send carrying nugget-ish params onto the durable path too", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: sendCtx({ op: "create_task", title: "t", description: "d" }),
        to: "119313",
        payload,
      } as never);
      expect(prepared).toBe(payload);
    });

    it("ignores non-send actions", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: { action: "sendPoll", params: {} } as never,
        to: "119313",
        payload,
      } as never);
      expect(prepared ?? null).toBeNull();
    });
  });
});

describe("omadeus message adapter", () => {
  it("declares a send path and the agent-dispatch ack policy", () => {
    expect(omadeusPlugin.message?.send).toBeDefined();
    expect(omadeusPlugin.message?.receive?.defaultAckPolicy).toBe("after_agent_dispatch");
  });

  // Live preview capabilities are declarations with no implementation hook in the shared
  // SDK; advertising them without the edit machinery behind them would be a lie to core.
  it("does not advertise live preview capabilities it cannot back", () => {
    expect(omadeusPlugin.message?.live).toBeUndefined();
  });
});
