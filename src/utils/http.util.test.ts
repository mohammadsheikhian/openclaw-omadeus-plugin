import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmadeusTokenManager } from "../token.js";
import {
  isTransientFailure,
  jaguarRequest,
  MALFORMED_RESPONSE_STATUS,
  NETWORK_ERROR_STATUS,
  omadeusRequest,
  OmadeusHttpError,
  type OmadeusApiOptions,
} from "./http.util.js";

/**
 * One error type for every failure is what makes retry policy answerable.
 * When some calls threw `OmadeusHttpError` and others threw a plain `Error`,
 * `pinOpenClawRoom` classified by `err.name` and got it wrong.
 */

const tokenManager: OmadeusTokenManager = {
  authorization: async () => "Bearer jwt",
  wsToken: async () => "jwt",
  close: () => {},
};
const apiOpts: OmadeusApiOptions = { omadeusUrl: "https://omadeus.test", tokenManager };

afterEach(() => {
  vi.restoreAllMocks();
});

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
};

describe("omadeusRequest", () => {
  it("returns the decoded body, never a Response", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }));
    await expect(
      omadeusRequest("https://omadeus.test/x", { label: "x", method: "GET" }),
    ).resolves.toEqual({ id: 7 });
  });

  it("decodes an empty body as undefined", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    await expect(
      omadeusRequest("https://omadeus.test/x", { label: "x", method: "POST" }),
    ).resolves.toBeUndefined();
  });

  it("raises OmadeusHttpError carrying the status", async () => {
    stubFetch(async () => new Response("nope", { status: 404 }));
    await expect(
      omadeusRequest("https://omadeus.test/x", { label: "Get thing", method: "GET" }),
    ).rejects.toMatchObject({ name: "OmadeusHttpError", status: 404 });
  });

  it("raises the same error type when the request never reaches the server", async () => {
    stubFetch(async () => {
      throw new Error("fetch failed");
    });
    const err = await omadeusRequest("https://omadeus.test/x", {
      label: "Get thing",
      method: "GET",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OmadeusHttpError);
    expect((err as OmadeusHttpError).status).toBe(NETWORK_ERROR_STATUS);
    expect((err as Error).message).toContain("Get thing (GET https://omadeus.test/x)");
  });

  it("sends a string body as-is and anything else as JSON", async () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }));

    await omadeusRequest("https://x.test/a", { label: "a", method: "CREATE", body: "" });
    expect(mock.mock.calls[0]?.[1]).toMatchObject({ body: "" });

    await omadeusRequest("https://x.test/b", { label: "b", method: "POST", body: { a: 1 } });
    expect(mock.mock.calls[1]?.[1]).toMatchObject({ body: '{"a":1}' });
  });

  it("omits the body entirely when there is none", async () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }));
    await omadeusRequest("https://x.test/a", { label: "a", method: "GET" });
    expect(mock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });
});

describe("jaguarRequest", () => {
  it("prefixes the path and attaches the credential", async () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }));
    await jaguarRequest(apiOpts, "/directs/openclaw_bot", { label: "direct", method: "GET" });

    expect(mock.mock.calls[0]?.[0]).toBe(
      "https://omadeus.test/jaguar/apiv1/directs/openclaw_bot",
    );
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer jwt" });
  });

  it("reads the credential on every call, so a refresh can happen first", async () => {
    const authorization = vi.fn(async () => "Bearer fresh");
    stubFetch(async () => new Response("{}", { status: 200 }));

    const opts = { omadeusUrl: "https://omadeus.test", tokenManager: { ...tokenManager, authorization } };
    await jaguarRequest(opts, "/a", { label: "a", method: "GET" });
    await jaguarRequest(opts, "/b", { label: "b", method: "GET" });

    expect(authorization).toHaveBeenCalledTimes(2);
  });
});

describe("isTransientFailure", () => {
  it("is true for 5xx, a network fault, and an unreadable response", () => {
    expect(isTransientFailure(new OmadeusHttpError("x", 502))).toBe(true);
    expect(isTransientFailure(new OmadeusHttpError("x", NETWORK_ERROR_STATUS))).toBe(true);
    expect(isTransientFailure(new OmadeusHttpError("x", MALFORMED_RESPONSE_STATUS))).toBe(true);
  });

  it("is false for credentials and missing resources, which retrying never fixes", () => {
    expect(isTransientFailure(new OmadeusHttpError("x", 401))).toBe(false);
    expect(isTransientFailure(new OmadeusHttpError("x", 404))).toBe(false);
  });

  it("is false for an error that is not a request failure at all", () => {
    // The regression: a misconfigured `openClawMemberId` raises a plain Error
    // alongside a successful request, and used to be retried as transient.
    expect(isTransientFailure(new Error("openClawMemberId 99 is not a member"))).toBe(false);
  });
});
