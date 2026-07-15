import { describe, expect, it, vi } from "vitest";
import {
  appendNuggetLookupContextForAgent,
  messageNeedsTaskRoomNuggetContext,
  parseChannelTaskCreateIntent,
  parseNuggetLookupIntent,
  parseRecurringScheduleIntent,
  parseTaskChannelTargetIntent,
  pickNuggetFieldsForAgent,
} from "./nugget-lookup.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

vi.mock("./api/auth.api.js", () => ({
  listOrganizationMembers: vi.fn(async () => [
    { id: 1, referenceId: 210, firstName: "Casey", lastName: "Demo" },
  ]),
}));

describe("parseNuggetLookupIntent", () => {
  it("matches terse nugget id queries", () => {
    expect(parseNuggetLookupIntent("N111")).toEqual({ nuggetNumber: 111 });
    expect(parseNuggetLookupIntent("n222?")).toEqual({ nuggetNumber: 222 });
  });

  it("matches natural language nugget lookup text", () => {
    expect(parseNuggetLookupIntent("can you get info for nugget N333")).toEqual({
      nuggetNumber: 333,
    });
    expect(parseNuggetLookupIntent("show details for N444")).toEqual({
      nuggetNumber: 444,
    });
  });

  it("ignores unrelated text", () => {
    expect(parseNuggetLookupIntent("hello team")).toBeNull();
    expect(parseNuggetLookupIntent("nugget someday maybe")).toBeNull();
  });
});

describe("messageNeedsTaskRoomNuggetContext", () => {
  it("triggers on questions about this work item", () => {
    for (const q of [
      "What is the status of this nugget?",
      "Who is working on this?",
      "Who is assigned to the phases?",
      "Why is this nugget delayed?",
      "Why is this at risk?",
      "Give me a summary of this nugget",
      "Give me a summary of this",
      "What sprint does this nugget belong to?",
      "When is this due?",
      "who's the owner",
    ]) {
      expect(messageNeedsTaskRoomNuggetContext(q), q).toBe(true);
    }
  });

  it("skips greetings, acknowledgements, and unrelated chatter", () => {
    for (const q of [
      "Hello?",
      "hi there",
      "thanks!",
      "ok",
      "sounds good",
      "Can you help me write an email?",
      "",
      "   ",
    ]) {
      expect(messageNeedsTaskRoomNuggetContext(q), q).toBe(false);
    }
  });
});

describe("parseTaskChannelTargetIntent", () => {
  it("parses N/T style task targets", () => {
    expect(parseTaskChannelTargetIntent("N123")).toEqual({ nuggetNumber: 123, rawPrefix: "n" });
    expect(parseTaskChannelTargetIntent("t44")).toEqual({ nuggetNumber: 44, rawPrefix: "t" });
  });

  it("ignores non-target text", () => {
    expect(parseTaskChannelTargetIntent("room:123")).toBeNull();
    expect(parseTaskChannelTargetIntent("hello")).toBeNull();
  });
});

describe("parseChannelTaskCreateIntent", () => {
  it("extracts create task intent and defaults", () => {
    const parsed = parseChannelTaskCreateIntent("create task Fix production bug asap");
    expect(parsed).toEqual({
      kind: "task",
      title: "Fix production bug asap",
      description: "create task Fix production bug asap",
      priority: "urgent",
    });
  });

  it("returns null for non-create chatter", () => {
    expect(parseChannelTaskCreateIntent("task list please")).toBeNull();
  });
});

describe("parseRecurringScheduleIntent", () => {
  it("parses minute recurrence", () => {
    expect(parseRecurringScheduleIntent("every 5 minutes")).toEqual({ everyMinutes: 5 });
    expect(parseRecurringScheduleIntent("check every 15 min please")).toEqual({ everyMinutes: 15 });
  });

  it("parses hourly recurrence", () => {
    expect(parseRecurringScheduleIntent("hourly reminder")).toEqual({ everyMinutes: 60 });
  });

  it("returns null when recurrence is not specified", () => {
    expect(parseRecurringScheduleIntent("create a task for this")).toBeNull();
  });
});

describe("pickNuggetFieldsForAgent", () => {
  it("includes known fields and drops unknown keys", () => {
    const picked = pickNuggetFieldsForAgent({
      number: 111,
      title: "T",
      noise: "drop me",
      status: "open",
    } as Record<string, unknown>);
    expect(picked).toEqual({ number: 111, title: "T", status: "open" });
    expect(picked).not.toHaveProperty("noise");
  });
});

const mockApiOpts = {
  maestroUrl: "https://maestro.test",
  tokenManager: {
    getToken: () => "t",
    getPayload: () => ({
      organizationId: 1,
      id: 1,
      email: "a@b.c",
      title: "t",
      referenceId: 1,
      sessionId: "s",
      roles: [] as string[],
      exp: 9_999_999_999,
    }),
  },
} as OmadeusApiOptions;

describe("appendNuggetLookupContextForAgent", () => {
  it("appends JSON payload when a record is found, with people from member list", async () => {
    const out = await appendNuggetLookupContextForAgent("What's N111?", 111, {
      number: 111,
      title: "Fix bug",
      status: "complete",
      memberReferenceId: 210,
    }, mockApiOpts);
    expect(out.startsWith("What's N111?")).toBe(true);
    expect(out.toLowerCase()).toContain("summarize for someone");
    expect(out).toContain('"number": 111');
    expect(out).toContain("Fix bug");
    expect(out).toContain("people");
    expect(out).toContain("Casey");
    expect(out).toContain("memberReferenceId");
  });

  it("instructs the agent when nothing matched", async () => {
    const out = await appendNuggetLookupContextForAgent("N999", 999, null, mockApiOpts);
    expect(out).toContain("not found");
  });

  it("instructs the agent on fetch error", async () => {
    const out = await appendNuggetLookupContextForAgent("N1", 1, null, mockApiOpts, "network down");
    expect(out).toContain("Lookup failed");
    expect(out).toContain("network down");
  });
});
