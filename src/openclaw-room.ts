import { getOpenClawDirect } from "./api/direct.api.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
};

/**
 * Resolves the caller's direct room with the OpenClaw bot — the one room this channel
 * serves — so targetless outbound deliveries have somewhere to land.
 *
 * The motivating case is an isolated cron run. A job created without a `delivery` block
 * still announces its result: OpenClaw resolves the *channel* (Omadeus is the only one
 * configured) but the fresh run session carries no delivery context, so `to` arrives empty
 * and `outbound.resolveTarget` rejects it. The room does not depend on that context — it is
 * a property of the account — so resolve it once and cache it.
 *
 * **User scoping is Jaguar's job here.** `GET /directs/openclaw_bot` resolves the room from
 * `Member.current()`, i.e. the identity behind the token in `apiOpts`. There is no client
 * side member matching to get wrong, and no way to name another user's room: the request
 * carries no room or member id at all.
 */
export type OpenClawRoomResolver = {
  /** Cached room id, or `undefined` when it has not been resolved yet. Never blocks. */
  peek: () => string | undefined;
  /** Resolve the room id, hitting the directs API on a cache miss. */
  resolve: () => Promise<string | undefined>;
  /** Fire-and-forget {@link resolve}, for callers that cannot await (sync SDK hooks). */
  warm: () => void;
  /**
   * Record a room the inbound policy has already confirmed is the OpenClaw DM. Free, exact,
   * and it keeps the cache warm across the whole session without another API round trip.
   */
  remember: (roomId: number | string) => void;
};

/** Retry schedule for transient `directs` API failures, in milliseconds. */
const RESOLVE_RETRY_DELAYS_MS = [250, 1000];

export function createOpenClawRoomResolver(params: {
  apiOpts: OmadeusApiOptions;
  log: Log;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}): OpenClawRoomResolver {
  const { apiOpts, log } = params;
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let cached: string | undefined;
  // Concurrent callers (a cron announce racing the connect-time prime) share one lookup.
  let inFlight: Promise<string | undefined> | undefined;

  const lookup = async (): Promise<string | undefined> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // A 404 comes back as undefined: the DM does not exist yet. That is not retryable,
        // and it is deliberately not cached — the room may be created later in the session.
        const direct = await getOpenClawDirect(apiOpts);
        return direct ? String(direct.id) : undefined;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delayMs = RESOLVE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          log.warn(`omadeus: failed to resolve the OpenClaw DM room: ${message}`);
          return undefined;
        }
        log.debug?.(
          `omadeus: OpenClaw DM room lookup failed (${message}); retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  };

  const resolve = async (): Promise<string | undefined> => {
    if (cached) return cached;
    inFlight ??= lookup().finally(() => {
      inFlight = undefined;
    });
    const roomId = await inFlight;
    if (roomId) {
      cached = roomId;
      log.info(`omadeus: resolved OpenClaw DM room ${roomId}`);
    } else {
      log.warn(
        "omadeus: no direct room with the OpenClaw bot yet; targetless deliveries " +
          "(isolated cron announces) will fail until the DM exists",
      );
    }
    return roomId;
  };

  return {
    peek: () => cached,
    resolve,
    warm: () => {
      void resolve().catch(() => {});
    },
    remember: (roomId) => {
      const normalized = String(roomId).trim();
      if (!normalized || !/^\d+$/.test(normalized) || cached === normalized) return;
      cached = normalized;
      log.debug?.(`omadeus: OpenClaw DM room set to ${normalized} from inbound traffic`);
    },
  };
}
