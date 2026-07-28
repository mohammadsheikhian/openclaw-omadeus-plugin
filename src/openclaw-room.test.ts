import { describe, expect, it, vi, beforeEach } from "vitest";
import { createOpenClawRoomResolver } from "./openclaw-room.js";
import * as directApi from "./api/direct.api.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

const apiOpts = {} as OmadeusApiOptions;
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeResolver() {
  return createOpenClawRoomResolver({ apiOpts, log, sleep: async () => {} });
}

describe("createOpenClawRoomResolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    log.info.mockClear();
    log.warn.mockClear();
    log.debug.mockClear();
  });

  it("resolves the room id from the openclaw_bot alias", async () => {
    const spy = vi
      .spyOn(directApi, "getOpenClawDirect")
      .mockResolvedValue({ id: 7905, members: [] });
    const resolver = makeResolver();

    expect(await resolver.resolve()).toBe("7905");
    expect(resolver.peek()).toBe("7905");
    expect(spy).toHaveBeenCalledWith(apiOpts);
  });

  it("caches the result and does not refetch", async () => {
    const spy = vi
      .spyOn(directApi, "getOpenClawDirect")
      .mockResolvedValue({ id: 7905, members: [] });
    const resolver = makeResolver();

    expect(await resolver.resolve()).toBe("7905");
    expect(await resolver.resolve()).toBe("7905");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight lookup between concurrent callers", async () => {
    const spy = vi
      .spyOn(directApi, "getOpenClawDirect")
      .mockResolvedValue({ id: 7905, members: [] });
    const resolver = makeResolver();

    const [a, b] = await Promise.all([resolver.resolve(), resolver.resolve()]);
    expect(a).toBe("7905");
    expect(b).toBe("7905");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 404 is Jaguar's "no such direct yet", a normal state on a fresh account. It must not be
  // cached, or a DM created later in the session would never resolve.
  it("does not cache a missing direct, so a later resolve can still succeed", async () => {
    const spy = vi.spyOn(directApi, "getOpenClawDirect").mockResolvedValue(undefined);
    const resolver = makeResolver();

    expect(await resolver.resolve()).toBeUndefined();
    expect(resolver.peek()).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();

    spy.mockResolvedValue({ id: 7905, members: [] });
    expect(await resolver.resolve()).toBe("7905");
  });

  it("retries a transient failure before giving up", async () => {
    const spy = vi
      .spyOn(directApi, "getOpenClawDirect")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: 7905, members: [] });

    expect(await makeResolver().resolve()).toBe("7905");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined and warns once retries are exhausted", async () => {
    vi.spyOn(directApi, "getOpenClawDirect").mockRejectedValue(new Error("down"));
    const resolver = makeResolver();

    expect(await resolver.resolve()).toBeUndefined();
    expect(resolver.peek()).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not cache a failure", async () => {
    const spy = vi.spyOn(directApi, "getOpenClawDirect").mockRejectedValue(new Error("down"));
    const resolver = makeResolver();
    expect(await resolver.resolve()).toBeUndefined();

    spy.mockResolvedValue({ id: 7905, members: [] });
    expect(await resolver.resolve()).toBe("7905");
  });
});

describe("remember", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    log.warn.mockClear();
  });

  it("caches a room confirmed by the inbound policy without any API call", async () => {
    const spy = vi.spyOn(directApi, "getOpenClawDirect");
    const resolver = makeResolver();

    resolver.remember(7905);
    expect(resolver.peek()).toBe("7905");
    expect(await resolver.resolve()).toBe("7905");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts numeric strings and rejects junk", () => {
    const resolver = makeResolver();

    resolver.remember("7905");
    expect(resolver.peek()).toBe("7905");

    resolver.remember("room:8000");
    resolver.remember("");
    expect(resolver.peek()).toBe("7905");
  });
});
