import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { openOmadeusSession, type OmadeusSessionDeps } from "./session.js";
import type { OmadeusTokenManager } from "./token.js";
import type { ResolvedOmadeusAccount } from "./types.js";
import { OmadeusHttpError } from "./utils/http.util.js";

/**
 * The gateway lifecycle, which nothing could reach while `startAccount`
 * constructed every adapter it used. What is asserted here is ordering and
 * cleanup — that a credential is opened before a room is pinned, that a socket
 * only starts once both worked, and that nothing is left running when a step
 * fails.
 */

const ROOM = 777;
const OPENCLAW = 99;

const account = (overrides: Partial<ResolvedOmadeusAccount> = {}) =>
  ({
    accountId: "default",
    name: "Omadeus",
    enabled: true,
    config: {},
    casUrl: "https://cas.test",
    omadeusUrl: "https://omadeus.test",
    email: "op@test",
    password: "pw",
    organizationId: 1,
    openClawMemberId: OPENCLAW,
    credentialSource: "password",
    ...overrides,
  }) as ResolvedOmadeusAccount & { openClawMemberId: number };

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function fakeDeps(overrides: Partial<OmadeusSessionDeps> = {}) {
  const order: string[] = [];
  const tokenClose = vi.fn(() => order.push("token.close"));
  const socketDisconnect = vi.fn(() => order.push("socket.disconnect"));
  const socketConnect = vi.fn(() => order.push("socket.connect"));

  const tokenManager: OmadeusTokenManager = {
    authorization: async () => "Bearer jwt",
    wsToken: async () => "jwt",
    close: tokenClose,
  };

  let socketOpts: Parameters<OmadeusSessionDeps["createSocket"]>[0] | null = null;

  const deps: OmadeusSessionDeps = {
    openToken: async () => {
      order.push("openToken");
      return tokenManager;
    },
    pinRoom: async () => {
      order.push("pinRoom");
      return ROOM;
    },
    createSocket: (opts) => {
      order.push("createSocket");
      socketOpts = opts;
      return { connect: socketConnect, disconnect: socketDisconnect };
    },
    createHandler: () => {
      order.push("createHandler");
      return async () => {};
    },
    reportStatus: async () => {
      order.push("reportStatus");
    },
    sendMessage: async () => {
      order.push("sendMessage");
      return { messageId: "1" };
    },
    ...overrides,
  };

  return {
    deps,
    order,
    tokenClose,
    socketConnect,
    socketDisconnect,
    socketOpts: () => socketOpts,
  };
}

const open = (deps: OmadeusSessionDeps, acct = account()) =>
  openOmadeusSession({
    account: acct,
    cfg: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
    log: silentLog,
    deps,
  });

describe("openOmadeusSession", () => {
  it("authenticates, pins the room, then starts reading — in that order", async () => {
    const f = fakeDeps();
    const session = await open(f.deps);

    expect(f.order).toEqual([
      "openToken",
      "pinRoom",
      "createHandler",
      "createSocket",
      "socket.connect",
    ]);
    expect(session.roomId).toBe(ROOM);
  });

  it("releases the credential when the room cannot be pinned", async () => {
    // A 404 here means the gateway is pointed at the wrong Omadeus. Leaving an
    // auto-refresh timer running would keep the process alive for a session
    // that never started.
    const f = fakeDeps({
      pinRoom: async () => {
        throw new OmadeusHttpError("Omadeus get OpenClaw direct failed (404): ", 404);
      },
    });

    await expect(open(f.deps)).rejects.toThrow(OmadeusHttpError);
    expect(f.tokenClose).toHaveBeenCalledTimes(1);
    expect(f.socketConnect).not.toHaveBeenCalled();
  });

  it("never opens a socket when the credential fails", async () => {
    const f = fakeDeps({
      openToken: async () => {
        throw new Error("CAS token request failed (401): ");
      },
    });

    await expect(open(f.deps)).rejects.toThrow(/401/);
    expect(f.order).toEqual([]);
  });

  it("sends to the pinned room, with no target from the caller", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "m1" }));
    const f = fakeDeps({ sendMessage });
    const session = await open(f.deps);

    await expect(session.send("pong")).resolves.toEqual({ messageId: "m1" });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ omadeusUrl: "https://omadeus.test" }),
      { roomId: ROOM, text: "pong" },
    );
  });

  it("closes the socket and the credential, once, however many times close is called", async () => {
    const f = fakeDeps();
    const session = await open(f.deps);

    session.close();
    session.close();

    expect(f.socketDisconnect).toHaveBeenCalledTimes(1);
    expect(f.tokenClose).toHaveBeenCalledTimes(1);
    expect(f.order.slice(-2)).toEqual(["socket.disconnect", "token.close"]);
  });

  it("reports `connected` to Omadeus when the socket comes up", async () => {
    // Until this lands Jaguar keeps routing the DM to the setup assistant and
    // refuses `asOpenclaw`, so the bot cannot answer at all.
    const reportStatus = vi.fn(async () => {});
    const f = fakeDeps({ reportStatus });
    await open(f.deps);

    f.socketOpts()?.onConnect?.();
    await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledTimes(1));

    expect(reportStatus).toHaveBeenCalledWith({
      omadeusUrl: "https://omadeus.test",
      authorization: "Bearer jwt",
      openclawStatus: "connected",
    });
  });

  it("survives a failed status report, because the socket is healthy either way", async () => {
    const f = fakeDeps({
      reportStatus: async () => {
        throw new Error("500");
      },
    });
    const session = await open(f.deps);

    f.socketOpts()?.onConnect?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(session.roomId).toBe(ROOM);
    expect(f.socketDisconnect).not.toHaveBeenCalled();
  });

  it("mirrors socket events onto the account", async () => {
    const events = {
      onInbound: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const f = fakeDeps();
    await openOmadeusSession({
      account: account(),
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      log: silentLog,
      events,
      deps: f.deps,
    });

    const opts = f.socketOpts();
    opts?.onConnect?.();
    opts?.onDisconnect?.("code=1006");
    opts?.onError?.(new Error("boom"));
    opts?.onMessage?.({
      id: 1,
      type: "message",
      roomId: ROOM,
      senderReferenceId: 8,
      body: "hi",
      createdAtTimestamp: 1,
      removedAt: null,
    });

    expect(events.onConnect).toHaveBeenCalledTimes(1);
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    expect(events.onInbound).toHaveBeenCalledTimes(1);
  });
});
