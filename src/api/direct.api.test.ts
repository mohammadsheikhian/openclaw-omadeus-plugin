import { afterEach, describe, expect, it, vi } from "vitest";
import { getOpenClawDirect } from "./direct.api.js";
import type { OmadeusApiOptions } from "../utils/http.util.js";

const apiOpts = {
  maestroUrl: "https://maestro.example",
  tokenManager: {
    getToken: () => "token",
    authorizationHeader: () => "ApiToken token",
  },
} as unknown as OmadeusApiOptions;

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getOpenClawDirect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the server-side openclaw_bot alias", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ id: 7905, subscribableKind: "direct", members: [] }), {
        status: 200,
      }),
    );

    await expect(getOpenClawDirect(apiOpts)).resolves.toMatchObject({ id: 7905 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://maestro.example/jaguar/apiv1/directs/openclaw_bot",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  // Jaguar answers 404 when the direct does not exist yet — a normal state on a fresh
  // account, not a failure the caller should retry or log as an error.
  it("maps 404 to undefined", async () => {
    stubFetch(new Response("", { status: 404 }));
    await expect(getOpenClawDirect(apiOpts)).resolves.toBeUndefined();
  });

  it("throws on other error statuses", async () => {
    stubFetch(new Response("nope", { status: 500 }));
    await expect(getOpenClawDirect(apiOpts)).rejects.toThrow(/500/);
  });
});
