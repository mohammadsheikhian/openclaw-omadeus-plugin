import { WebSocket } from "ws";
import { isOmadeusMessage } from "../inbound.js";
import type { OmadeusTokenManager } from "../token.js";
import type { OmadeusMessage } from "../types.js";
import { createHeartbeat } from "./heartbeat.js";

export type JaguarSocketOptions = {
  omadeusUrl: string;
  tokenManager: OmadeusTokenManager;
  onMessage?: (msg: OmadeusMessage) => void;
  /**
   * Fired once per connection transition — not once per socket open. A
   * reconnect that restores an already-live connection does not fire it again,
   * so a caller can treat this as "we are now reachable" and act accordingly.
   */
  onConnect?: () => void;
  /** Fired once per connection transition, and only after an `onConnect`. */
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

/**
 * The inbound transport.
 *
 * Two methods, because there are two things a caller can decide: start, and
 * stop. Reconnect backoff, keep-alive, token freshness and connection-transition
 * bookkeeping are all implementation — a caller that had to know about any of
 * them would end up duplicating it, which is exactly what happened when
 * `onConnect` fired per socket rather than per transition.
 */
export type JaguarSocket = {
  connect(): void;
  disconnect(): void;
};

const WS_PATH = "ws";
const LOG_PREFIX = "[jaguar]";
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function createJaguarSocket(opts: JaguarSocketOptions): JaguarSocket {
  const { omadeusUrl, tokenManager, onMessage, onConnect, onDisconnect, onError, log } = opts;

  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;
  /** Whether `onConnect` has fired without a matching `onDisconnect`. */
  let reportedConnected = false;

  const heartbeat = createHeartbeat({
    send: (payload) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    },
    onStale: () => {
      log?.warn(`${LOG_PREFIX} connection went quiet; replacing the socket`);
      ws?.close();
    },
  });

  async function buildWsUrl(): Promise<string> {
    const base = omadeusUrl.replace(/^http/, "ws");
    // Reading the token refreshes it first when it is near expiry. The socket
    // does not orchestrate that itself — it used to, by re-entering `connect`.
    const token = await tokenManager.wsToken();
    return `${base}/${WS_PATH}?token=${encodeURIComponent(token)}`;
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    log?.info(`${LOG_PREFIX} reconnecting in ${delayMs}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => connect(), delayMs);
  }

  function discardSocket() {
    heartbeat.stop();
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  }

  function reportDisconnected(reason: string) {
    if (!reportedConnected) return;
    reportedConnected = false;
    onDisconnect?.(reason);
  }

  async function openSocket(): Promise<void> {
    discardSocket();
    intentionalClose = false;

    let url: string;
    try {
      url = await buildWsUrl();
    } catch (err) {
      onError?.(toError(err));
      scheduleReconnect();
      return;
    }
    // `disconnect()` can land while the credential is being refreshed.
    if (intentionalClose) return;

    log?.info(`${LOG_PREFIX} connecting...`);
    const socket = new WebSocket(url);
    ws = socket;

    socket.on("open", () => {
      reconnectAttempt = 0;
      log?.info(`${LOG_PREFIX} connected`);
      heartbeat.start();
      if (reportedConnected) return;
      reportedConnected = true;
      onConnect?.();
    });

    socket.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        log?.warn(`${LOG_PREFIX} unparseable message: ${String(raw).slice(0, 200)}`);
        return;
      }
      if (heartbeat.observe(frame)) return;
      // Anything that is not a chat message — typing, presence, seen receipts —
      // has no subscriber, and proving liveness was its whole contribution.
      if (isOmadeusMessage(frame)) onMessage?.(frame);
    });

    socket.on("close", (code, reason) => {
      const msg = `code=${code} reason=${String(reason)}`;
      log?.info(`${LOG_PREFIX} disconnected: ${msg}`);
      heartbeat.stop();
      if (ws === socket) ws = null;
      reportDisconnected(msg);
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      log?.error(`${LOG_PREFIX} error: ${err.message}`);
      onError?.(err);
    });
  }

  function connect() {
    void openSocket();
  }

  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    discardSocket();
    reportDisconnected("disconnect requested");
  }

  return { connect, disconnect };
}
