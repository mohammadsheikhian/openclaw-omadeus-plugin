import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { createOmadeusMessageHandler } from "./handler.js";
import { parseJaguarMessage } from "./inbound.js";
import { setOmadeusRuntime } from "./runtime.js";
import { createJaguarSocket, type JaguarSocket } from "./socket/socket.js";
import { createApiKeyTokenManager } from "./token.js";
import type { OmadeusMessage } from "./types.js";

/**
 * The one test that runs a message all the way through: socket frame → parse →
 * admission → handler → REST reply. Everything this channel has ever broken —
 * silent drops, echo loops, answering the wrong room — lives in the seams
 * between those steps, which no unit test touches.
 */

const ROOM = 777;
const OPERATOR = 8;
const OPENCLAW = 99;
const REPLY_TEXT = "pong";

type RecordedRequest = { method: string; path: string; body: unknown };

let server: WebSocketServer | null = null;
let socket: JaguarSocket | null = null;
let requests: RecordedRequest[] = [];
let sentMessageId = 1000;

/** Everything the handler needs from the OpenClaw core, and nothing more. */
function fakeRuntime(): PluginRuntime {
  return {
    system: { enqueueSystemEvent: () => {} },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        // Flush immediately. Debouncing itself is SDK behaviour; what matters
        // here is that the handler's flush path is wired to the delivery path.
        createInboundDebouncer: <T>(opts: { onFlush: (entries: T[]) => Promise<void> }) => ({
          enqueue: async (entry: T) => {
            await opts.onFlush([entry]);
          },
        }),
      },
      routing: {
        resolveAgentRoute: () => ({
          agentId: "main",
          accountId: "default",
          sessionKey: `omadeus:direct:${OPERATOR}`,
        }),
      },
      session: {
        resolveStorePath: () => "",
        recordInboundSession: () => {},
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: () => {} },
      text: {
        resolveTextChunkLimit: () => 4000,
        resolveChunkMode: () => "markdown",
        chunkTextWithMode: (text: string) => [text],
        chunkMarkdownText: (text: string) => [text],
      },
      inbound: {
        buildContext: (payload: unknown) => payload,
        // Stands in for the turn kernel: ingest, resolve, and deliver a canned
        // answer, which is what a real agent turn ends up doing.
        run: async ({
          raw,
          adapter,
        }: {
          raw: unknown;
          adapter: {
            ingest: (raw: unknown) => unknown;
            resolveTurn: (input: unknown) => {
              delivery: { deliver: (payload: { text: string }) => Promise<unknown> };
            };
          };
        }) => {
          const input = adapter.ingest(raw);
          const turn = adapter.resolveTurn(input);
          await turn.delivery.deliver({ text: REPLY_TEXT });
        },
      },
    },
  } as unknown as PluginRuntime;
}

function frame(overrides: Partial<OmadeusMessage> = {}): OmadeusMessage {
  return {
    id: 1,
    type: "message",
    roomId: ROOM,
    senderReferenceId: OPERATOR,
    body: "ping",
    createdAtTimestamp: Math.floor(Date.now() / 1000),
    removedAt: null,
    ...overrides,
  };
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Requests to `POST /rooms/:id/messages`, i.e. replies the channel produced. */
const sends = () => requests.filter((r) => r.method === "SEND");
const seens = () => requests.filter((r) => r.method === "SEE");

beforeEach(() => {
  requests = [];
  setOmadeusRuntime(fakeRuntime());

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      requests.push({
        method,
        path: new URL(url).pathname,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      sentMessageId += 1;
      return new Response(JSON.stringify({ id: sentMessageId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(async () => {
  socket?.disconnect();
  socket = null;
  vi.restoreAllMocks();
  if (server) {
    for (const client of server.clients) client.close();
    const closing = once(server, "close");
    server.close();
    await closing;
    server = null;
  }
});

describe("omadeus gateway", () => {
  it("answers the operator, ignores its own echo, and stays out of other rooms", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    server = wss;
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP port");

    const apiOpts = {
      omadeusUrl: `http://127.0.0.1:${address.port}`,
      tokenManager: createApiKeyTokenManager("key"),
    };

    const handleMessage = createOmadeusMessageHandler({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      apiOpts,
      roomId: ROOM,
      openClawMemberId: OPENCLAW,
    });

    const connected = once(wss, "connection");
    socket = createJaguarSocket({
      omadeusUrl: apiOpts.omadeusUrl,
      tokenManager: apiOpts.tokenManager,
      onMessage: (msg) => {
        const inbound = parseJaguarMessage(msg);
        if (inbound) void handleMessage(inbound);
      },
    });
    socket.connect();
    const [client] = (await connected) as [import("ws").WebSocket];

    // 1. The operator writes in the served room and gets an answer.
    client.send(JSON.stringify(frame({ id: 1, body: "ping" })));
    await waitFor("the reply", () => sends().length === 1);

    expect(sends()[0]?.path).toBe(`/jaguar/apiv1/rooms/${ROOM}/messages`);
    expect(sends()[0]?.body).toMatchObject({ body: REPLY_TEXT, asOpenclaw: true });
    // Read receipts are posted as the bot; a plain SEE would be the operator
    // seeing their own message, which Jaguar rejects (status 1058).
    expect(seens()[0]?.body).toEqual({ asOpenclaw: true });

    // 2. That reply echoes back over the socket authored by OpenClaw. Answering
    //    it would loop forever.
    client.send(
      JSON.stringify(frame({ id: 2, senderReferenceId: OPENCLAW, body: REPLY_TEXT })),
    );

    // 3. A message in a room this channel does not serve.
    client.send(JSON.stringify(frame({ id: 3, roomId: 12345, body: "not for you" })));

    // Give both a chance to produce a wrong reply before asserting they didn't.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sends()).toHaveLength(1);
  });

  it("answers an attachment-only message instead of going silent", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    server = wss;
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP port");

    const apiOpts = {
      omadeusUrl: `http://127.0.0.1:${address.port}`,
      tokenManager: createApiKeyTokenManager("key"),
    };
    const handleMessage = createOmadeusMessageHandler({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      apiOpts,
      roomId: ROOM,
      openClawMemberId: OPENCLAW,
    });

    const connected = once(wss, "connection");
    socket = createJaguarSocket({
      omadeusUrl: apiOpts.omadeusUrl,
      tokenManager: apiOpts.tokenManager,
      onMessage: (msg) => {
        const inbound = parseJaguarMessage(msg);
        if (inbound) void handleMessage(inbound);
      },
    });
    socket.connect();
    const [client] = (await connected) as [import("ws").WebSocket];

    client.send(JSON.stringify(frame({ id: 4, body: "" })));
    await waitFor("the text-only notice", () => sends().length === 1);

    expect(String((sends()[0]?.body as { body?: string }).body)).toContain("text messages");
  });
});
