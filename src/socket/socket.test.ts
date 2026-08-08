import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { OmadeusTokenManager } from "../token.js";
import type { OmadeusJwtPayload } from "../types.js";
import { createOmadeusSocketClient, type OmadeusSocketClient } from "./socket.js";

const payload: OmadeusJwtPayload = {
  id: 1,
  email: "bot@example.com",
  referenceId: 10,
  sessionId: "session",
  organizationId: 20,
  roles: [],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const tokenManager: OmadeusTokenManager = {
  getToken: () => "token",
  getPayload: () => payload,
  refresh: async () => {},
  startAutoRefresh: () => {},
  stopAutoRefresh: () => {},
  needsRefresh: () => false,
  authorizationHeader: () => "Bearer token",
  wsToken: () => "token",
};

let client: OmadeusSocketClient | null = null;
let server: WebSocketServer | null = null;

async function createServer(): Promise<{ server: WebSocketServer; omadeusUrl: string }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected WebSocket server to listen on a TCP port");
  }
  return { server: wss, omadeusUrl: `http://127.0.0.1:${address.port}` };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

describe("createOmadeusSocketClient", () => {
  afterEach(async () => {
    client?.disconnect();
    client = null;

    if (server) {
      for (const socket of server.clients) {
        socket.close();
      }
      const closing = once(server, "close");
      server.close();
      await closing;
      server = null;
    }
  });

  it("treats Omadeus content keep-alive frames as server acknowledgements", async () => {
    const setup = await createServer();
    server = setup.server;

    const receivedMessages = new Promise<unknown[]>((resolve, reject) => {
      server?.on("connection", (socket) => {
        const messages: unknown[] = [];
        socket.on("message", (raw) => {
          messages.push(JSON.parse(String(raw)));
          if (messages.length === 1) {
            socket.send(JSON.stringify({ content: "keep-alive", action: "answer" }));
            setTimeout(() => resolve(messages), 50);
          }
          if (messages.length === 2) {
            reject(new Error("Client echoed the server keep-alive acknowledgement"));
          }
        });
      });
    });
    const onEvent = vi.fn();

    client = createOmadeusSocketClient({
      omadeusUrl: setup.omadeusUrl,
      tokenManager,
      pathSuffix: "ws",
      logPrefix: "[test]",
      onEvent,
    });
    client.connect();

    const messages = await withTimeout(receivedMessages, "keep-alive answer");
    expect(messages).toEqual([{ data: "keep-alive", action: "answer" }]);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("passes non-heartbeat socket events through", async () => {
    const setup = await createServer();
    server = setup.server;
    const chatEvent = { type: "message", roomId: 123, body: "hello" };
    const receivedEvent = new Promise<Record<string, unknown>>((resolve) => {
      server?.on("connection", (socket) => {
        socket.send(JSON.stringify(chatEvent));
      });
      client = createOmadeusSocketClient({
        omadeusUrl: setup.omadeusUrl,
        tokenManager,
        pathSuffix: "ws",
        logPrefix: "[test]",
        onEvent: resolve,
      });
      client.connect();
    });

    await expect(withTimeout(receivedEvent, "chat event")).resolves.toMatchObject(chatEvent);
  });
});
