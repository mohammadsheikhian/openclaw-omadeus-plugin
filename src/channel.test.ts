import { describe, expect, it } from "vitest";
import { omadeusPlugin } from "./channel.js";

const actions = omadeusPlugin.actions;

function sendCtx(params: Record<string, unknown>) {
  return { action: "send", params } as never;
}

describe("omadeus message actions", () => {
  describe("supportsAction", () => {
    it("claims the actions handleAction implements", () => {
      for (const action of ["send", "edit", "delete", "react"] as const) {
        expect(actions?.supportsAction?.({ action })).toBe(true);
      }
    });

    // Unclaimed actions must fall back to the SDK's shared handling instead of
    // reaching handleAction, which throws on anything it does not recognize.
    it("declines actions it does not implement", () => {
      expect(actions?.supportsAction?.({ action: "sendPoll" as never })).toBe(false);
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

    // create_task is not a message delivery, so it has to stay on the plugin-owned path.
    it("defers a create_task send to handleAction", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: sendCtx({ op: "create_task", title: "t", description: "d" }),
        to: "119313",
        payload,
      } as never);
      expect(prepared ?? null).toBeNull();
    });

    it("defers a title+description send to handleAction", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: sendCtx({ title: "t", description: "d" }),
        to: "119313",
        payload,
      } as never);
      expect(prepared ?? null).toBeNull();
    });

    it("ignores non-send actions", async () => {
      const prepared = await actions?.prepareSendPayload?.({
        ctx: { action: "react", params: { emoji: "👍" } } as never,
        to: "119313",
        payload,
      } as never);
      expect(prepared ?? null).toBeNull();
    });
  });
});
