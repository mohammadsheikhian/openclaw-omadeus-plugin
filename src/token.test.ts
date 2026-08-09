import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth.js";
import { createApiKeyTokenManager, createBearerTokenManager, openOmadeusToken } from "./token.js";
import type { ResolvedOmadeusAccount } from "./types.js";

vi.mock("./auth.js", () => ({ authenticate: vi.fn() }));

const authenticateMock = vi.mocked(authenticate);

/** A JWT whose payload expires `seconds` from now. Only `exp` is read. */
function jwtExpiringIn(seconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      id: 1,
      email: "op@test",
      referenceId: 8,
      sessionId: "s",
      organizationId: 1,
      exp: Math.floor(Date.now() / 1000) + seconds,
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const passwordAccount: Pick<
  ResolvedOmadeusAccount,
  "apiKey" | "casUrl" | "omadeusUrl" | "email" | "password" | "organizationId"
> = {
  casUrl: "https://cas.test",
  omadeusUrl: "https://omadeus.test",
  email: "op@test",
  password: "pw",
  organizationId: 1,
};

beforeEach(() => {
  authenticateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("static credentials", () => {
  it("sends the API key with its scheme on both reads, because Jaguar needs it", async () => {
    const manager = createApiKeyTokenManager("k1");
    await expect(manager.authorization()).resolves.toBe("ApiToken k1");
    await expect(manager.wsToken()).resolves.toBe("ApiToken k1");
  });

  it("sends a bearer JWT raw on the socket and schemed on REST", async () => {
    const manager = createBearerTokenManager("jwt");
    await expect(manager.authorization()).resolves.toBe("Bearer jwt");
    await expect(manager.wsToken()).resolves.toBe("jwt");
  });
});

describe("openOmadeusToken", () => {
  it("takes the API key without logging in, when both credentials are present", async () => {
    const manager = await openOmadeusToken({ ...passwordAccount, apiKey: "k1" });

    await expect(manager.authorization()).resolves.toBe("ApiToken k1");
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it("logs in before returning, so a bad credential fails where it is started", async () => {
    authenticateMock.mockRejectedValueOnce(new Error("CAS token request failed (401): "));

    await expect(openOmadeusToken(passwordAccount)).rejects.toThrow(/401/);
  });

  it("resolves with a usable credential once the login works", async () => {
    const token = jwtExpiringIn(3600);
    authenticateMock.mockResolvedValue({ dolphinToken: token, payload: {} as never });

    const manager = await openOmadeusToken(passwordAccount);

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    await expect(manager.authorization()).resolves.toBe(`Bearer ${token}`);
    await expect(manager.wsToken()).resolves.toBe(token);
    // A fresh token is not re-fetched on every read.
    expect(authenticateMock).toHaveBeenCalledTimes(1);
    manager.close();
  });

  it("refreshes on read when the token is inside the expiry margin", async () => {
    // Refresh margin is 5 minutes, so a 60-second token is already stale.
    authenticateMock
      .mockResolvedValueOnce({ dolphinToken: jwtExpiringIn(60), payload: {} as never })
      .mockResolvedValueOnce({ dolphinToken: jwtExpiringIn(3600), payload: {} as never });

    const manager = await openOmadeusToken(passwordAccount);
    await manager.authorization();

    expect(authenticateMock).toHaveBeenCalledTimes(2);
    manager.close();
  });

  it("opens one login for a burst of concurrent reads", async () => {
    // Every read can now trigger a refresh, so without a single in-flight login
    // a burst of REST calls against a stale token would each open a CAS session.
    authenticateMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { dolphinToken: jwtExpiringIn(60), payload: {} as never };
    });

    const manager = await openOmadeusToken(passwordAccount);
    authenticateMock.mockClear();

    await Promise.all([manager.authorization(), manager.authorization(), manager.wsToken()]);

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    manager.close();
  });

  it("reports a refresh failure without swallowing it", async () => {
    const onError = vi.fn();
    authenticateMock
      .mockResolvedValueOnce({ dolphinToken: jwtExpiringIn(60), payload: {} as never })
      .mockRejectedValueOnce(new Error("CAS down"));

    const manager = await openOmadeusToken(passwordAccount, { onError });

    await expect(manager.authorization()).rejects.toThrow("CAS down");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "CAS down" }));
    manager.close();
  });

  it("stops refreshing after close, so a failed account cannot hold the process open", async () => {
    vi.useFakeTimers();
    authenticateMock.mockResolvedValue({ dolphinToken: jwtExpiringIn(3600), payload: {} as never });

    const manager = await openOmadeusToken(passwordAccount);
    authenticateMock.mockClear();

    manager.close();
    manager.close();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(authenticateMock).not.toHaveBeenCalled();
  });
});
