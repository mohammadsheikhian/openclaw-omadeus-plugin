import { afterEach, describe, expect, it, vi } from "vitest";
import { pinOpenClawRoom } from "./room.js";
import { createApiKeyTokenManager } from "./token.js";
import { OmadeusHttpError } from "./utils/http.util.js";

const apiOpts = {
  omadeusUrl: "https://omadeus.test",
  tokenManager: createApiKeyTokenManager("key"),
};
const log = { info: vi.fn(), warn: vi.fn() };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  log.info.mockClear();
  log.warn.mockClear();
});

describe("pinOpenClawRoom", () => {
  it("returns the room id of the OpenClaw direct", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: 777, members: [{ referenceId: 8 }, { referenceId: 99 }] })),
    );

    await expect(pinOpenClawRoom({ apiOpts, openClawMemberId: 99, log })).resolves.toBe(777);
  });

  it("retries a 5xx and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse({ id: 777, members: [{ referenceId: 99 }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pinOpenClawRoom({ apiOpts, openClawMemberId: 99, log, delay: async () => {} }),
    ).resolves.toBe(777);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404, because the DM always exists by then", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pinOpenClawRoom({ apiOpts, openClawMemberId: 99, log, delay: async () => {} }),
    ).rejects.toThrow(OmadeusHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when openClawMemberId is not in the room, without retrying", async () => {
    // Otherwise this only shows up later as the channel answering itself. And
    // the request succeeded — only the config is wrong — so there is nothing to
    // retry. Classifying by `err.name` used to make this transient, costing the
    // operator 5 attempts over 8 seconds before the error surfaced.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 777, members: [{ referenceId: 8 }, { referenceId: 12 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pinOpenClawRoom({ apiOpts, openClawMemberId: 99, log, delay: async () => {} }),
    ).rejects.toThrow(/openClawMemberId 99 is not a member/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure, since a pod can start before its gateway is up", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ id: 777, members: [{ referenceId: 99 }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pinOpenClawRoom({ apiOpts, openClawMemberId: 99, log, delay: async () => {} }),
    ).resolves.toBe(777);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
