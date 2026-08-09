import { describe, expect, it } from "vitest";
import { normalizeAllowFromEntries, omadeusPlugin } from "./channel.js";

/**
 * OpenClaw runs both `commands.ownerAllowFrom` and the inbound sender id
 * through `config.formatAllowFrom`, then matches the two results against each
 * other to decide `senderIsOwner`. A stub returning `[]` blanks both sides, so
 * the match can never succeed and every owner-only tool (`cron`, and whatever
 * is added to that set later) is stripped from the agent with only a
 * "gateway sender owner-only tools.deny" line to show for it.
 *
 * These tests exist so that stub cannot come back.
 */
describe("formatAllowFrom", () => {
  const format = omadeusPlugin.config?.formatAllowFrom;

  it("is implemented", () => {
    expect(typeof format).toBe("function");
  });

  it("passes a member reference id through unchanged", () => {
    expect(format?.({ allowFrom: ["8"] } as never)).toEqual(["8"]);
  });

  it("never returns an empty list for a non-empty input", () => {
    expect(format?.({ allowFrom: ["8", "12"] } as never)).not.toHaveLength(0);
  });
});

describe("normalizeAllowFromEntries", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(normalizeAllowFromEntries([" 8 ", "", "8", "12"])).toEqual(["8", "12"]);
  });

  it("accepts numeric ids, since Omadeus members are numbers", () => {
    expect(normalizeAllowFromEntries([8, 12])).toEqual(["8", "12"]);
  });
});
