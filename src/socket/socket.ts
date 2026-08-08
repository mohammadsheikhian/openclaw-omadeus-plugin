import { WebSocket } from "ws";
import { isOmadeusMessage } from "../inbound.js";
import type { OmadeusTokenManager } from "../token.js";
import type { OmadeusMessage } from "../types.js";

export type JaguarSocketOptions = {
  omadeusUrl: string;
  tokenManager: OmadeusTokenManager;
  onMessage?: (msg: OmadeusMessage) => void;
  /** Called for any non-message events (typing, presence, seen receipts, …). */
  onOtherEvent?: (data: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export type JaguarSocket = {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  /** Send a raw JSON payload over the socket. */
  send(data: unknown): void;
};

const WS_PATH = "ws";
const LOG_PREFIX = "[jaguar]";
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
// Heartbeat tuning knobs for Omadeus sockets.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MISSED_MAX = 5;
const KEEP_ALIVE_CONTENT = "keep-alive";
const KEEP_ALIVE_ACTION = "answer";

function isServerKeepAlive(data: Record<string, unknown>): boolean {
  return (data as { content?: unknown }).content === KEEP_ALIVE_CONTENT;
}

function isClientKeepAlive(data: Record<string, unknown>): boolean {
  return (data as { data?: unknown }).data === KEEP_ALIVE_CONTENT;
}

export function createJaguarSocket(opts: JaguarSocketOptions): JaguarSocket {
  const { omadeusUrl, tokenManager, onMessage, onOtherEvent, onConnect, onDisconnect, onError, log } =
    opts;
  const logPrefix = LOG_PREFIX;

  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatMissCount = 0;
  let intentionalClose = false;

  function buildWsUrl(): string {
    const base = omadeusUrl.replace(/^http/, "ws");
    const token = tokenManager.wsToken();
    return `${base}/${WS_PATH}?token=${encodeURIComponent(token)}`;
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    log?.info(`${logPrefix} reconnecting in ${delayMs}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => connect(), delayMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function resetHeartbeat() {
    heartbeatMissCount = 0;
  }

  function sendKeepAlive() {
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    heartbeatMissCount += 1;
    sendKeepAliveFrame();

    if (heartbeatMissCount >= HEARTBEAT_MISSED_MAX) {
      log?.warn(
        `${logPrefix} heartbeat unanswered ${heartbeatMissCount} times; reconnecting socket`,
      );
      ws.close();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendKeepAlive();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function sendKeepAliveFrame() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ data: KEEP_ALIVE_CONTENT, action: KEEP_ALIVE_ACTION }));
    }
  }

  function connect() {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
    intentionalClose = false;
    stopHeartbeat();
    resetHeartbeat();

    if (tokenManager.needsRefresh()) {
      tokenManager
        .refresh()
        .then(() => connect())
        .catch((err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
          scheduleReconnect();
        });
      return;
    }

    const url = buildWsUrl();
    log?.info(`${logPrefix} connecting...`);

    ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectAttempt = 0;
      log?.info(`${logPrefix} connected`);
      onConnect?.();
      resetHeartbeat();
      sendKeepAlive();
      startHeartbeat();
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw)) as Record<string, unknown>;

        const action = (data as { action?: unknown }).action;
        if (isServerKeepAlive(data) && action === KEEP_ALIVE_ACTION) {
          resetHeartbeat();
          return;
        }

        if (isClientKeepAlive(data) && action === KEEP_ALIVE_ACTION) {
          resetHeartbeat();
          return;
        }

        // If backend sends a heartbeat ping, answer it immediately.
        if (isServerKeepAlive(data) && action === "heartbeat") {
          resetHeartbeat();
          sendKeepAliveFrame();
          return;
        }

        resetHeartbeat();
        if (isOmadeusMessage(data)) {
          onMessage?.(data);
        } else {
          onOtherEvent?.(data);
        }
      } catch {
        log?.warn(`${logPrefix} unparseable message: ${String(raw).slice(0, 200)}`);
      }
    });

    ws.on("close", (code, reason) => {
      const msg = `code=${code} reason=${String(reason)}`;
      log?.info(`${logPrefix} disconnected: ${msg}`);
      onDisconnect?.(msg);
      ws = null;
      stopHeartbeat();
      resetHeartbeat();
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log?.error(`${logPrefix} error: ${err.message}`);
      onError?.(err);
    });
  }

  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopHeartbeat();
    resetHeartbeat();
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  }

  return {
    connect,
    disconnect,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
  };
}
