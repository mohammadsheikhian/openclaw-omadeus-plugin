import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDirectCounterpartyResolver } from "./direct-resolver.js";
import * as directApi from "./api/direct.api.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

const apiOpts = {} as OmadeusApiOptions;
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const selfRef = 100;

function makeResolver() {
  return createDirectCounterpartyResolver({ apiOpts, selfReferenceId: selfRef, log });
}

describe("createDirectCounterpartyResolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    log.warn.mockClear();
  });

  it("resolves the non-self member and caches it (no second fetch)", async () => {
    const spy = vi.spyOn(directApi, "listDirects").mockResolvedValue([
      { id: 7905, members: [{ referenceId: selfRef }, { referenceId: 38 }] },
    ]);
    const resolver = makeResolver();

    expect(await resolver.resolve(7905)).toBe(38);
    // Second call served from cache.
    expect(await resolver.resolve(7905)).toBe(38);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(apiOpts, { filters: { id: [7905] } });
  });

  it("falls back to a full list when the targeted fetch misses", async () => {
    const spy = vi
      .spyOn(directApi, "listDirects")
      .mockResolvedValueOnce([]) // targeted fetch by id misses
      .mockResolvedValueOnce([
        { id: 11, members: [{ referenceId: selfRef }, { referenceId: 210 }] },
      ]);
    const resolver = makeResolver();

    expect(await resolver.resolve(11)).toBe(210);
    expect(spy).toHaveBeenNthCalledWith(1, apiOpts, { filters: { id: [11] } });
    expect(spy).toHaveBeenNthCalledWith(2, apiOpts, {});
  });

  it("returns undefined and warns when the lookup throws", async () => {
    vi.spyOn(directApi, "listDirects").mockRejectedValue(new Error("boom"));
    const resolver = makeResolver();

    expect(await resolver.resolve(7905)).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns undefined for a self-only room (no counterparty)", async () => {
    vi.spyOn(directApi, "listDirects").mockResolvedValue([
      { id: 5, members: [{ referenceId: selfRef }] },
    ]);
    const resolver = makeResolver();

    expect(await resolver.resolve(5)).toBeUndefined();
  });
});
