/**
 * The Jaguar keep-alive protocol.
 *
 * Jaguar speaks keep-alive in three shapes — our answer echoed back, the
 * server's own answer, and a server ping we must answer — and liveness is
 * judged by whether *any* frame arrived, not by matching answers to sends.
 * All of that lives here so the socket's message handler is "observe, then
 * route", and so the protocol can be tested against frame fixtures with no
 * server and no socket.
 */

const KEEP_ALIVE_CONTENT = "keep-alive";
const KEEP_ALIVE_ACTION = "answer";
const HEARTBEAT_ACTION = "heartbeat";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Consecutive quiet intervals tolerated before the connection is called stale. */
export const HEARTBEAT_SILENT_INTERVALS_MAX = 5;

/** The frame we send, and the one Jaguar echoes back. */
export const KEEP_ALIVE_FRAME = { data: KEEP_ALIVE_CONTENT, action: KEEP_ALIVE_ACTION } as const;

export type Heartbeat = {
  /**
   * Feed every inbound frame here, before routing it.
   *
   * Returns `true` when the frame was keep-alive traffic this module has fully
   * handled and the caller should stop. Every frame — consumed or not — counts
   * as proof the connection is alive.
   */
  observe(frame: Record<string, unknown>): boolean;
  /** Begin sending keep-alives. Idempotent. */
  start(): void;
  /** Stop sending keep-alives. Idempotent, and safe before `start`. */
  stop(): void;
};

function isKeepAliveAnswer(frame: Record<string, unknown>): boolean {
  if (frame.action !== KEEP_ALIVE_ACTION) return false;
  // `content` is the server's phrasing, `data` is our own echoed back.
  return frame.content === KEEP_ALIVE_CONTENT || frame.data === KEEP_ALIVE_CONTENT;
}

function isServerPing(frame: Record<string, unknown>): boolean {
  return frame.action === HEARTBEAT_ACTION && frame.content === KEEP_ALIVE_CONTENT;
}

export function createHeartbeat(opts: {
  /** Write a frame to the socket. May be a no-op when the socket is not open. */
  send: (payload: unknown) => void;
  /** The connection has gone quiet for too long and should be replaced. */
  onStale: () => void;
  intervalMs?: number;
  maxSilentIntervals?: number;
}): Heartbeat {
  const {
    send,
    onStale,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    maxSilentIntervals = HEARTBEAT_SILENT_INTERVALS_MAX,
  } = opts;

  let timer: ReturnType<typeof setInterval> | null = null;
  // Intervals elapsed since the last inbound frame of any kind.
  let silentIntervals = 0;

  const tick = () => {
    silentIntervals += 1;
    send(KEEP_ALIVE_FRAME);
    if (silentIntervals >= maxSilentIntervals) onStale();
  };

  return {
    observe(frame) {
      silentIntervals = 0;
      if (isServerPing(frame)) {
        send(KEEP_ALIVE_FRAME);
        return true;
      }
      return isKeepAliveAnswer(frame);
    },
    start() {
      if (timer) return;
      silentIntervals = 0;
      // Announce ourselves immediately rather than waiting out the first
      // interval, which is what the server expects on a fresh connection.
      send(KEEP_ALIVE_FRAME);
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      silentIntervals = 0;
    },
  };
}
