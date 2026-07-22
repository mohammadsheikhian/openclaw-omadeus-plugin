import { listDirects, type OmadeusDirect } from "./api/direct.api.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
};

/**
 * Resolve the counterparty (the non-self member) of a Jaguar **direct** room.
 *
 * Directs are keyed by *who the other participant is*, not by who sent a given
 * message. Because OpenClaw runs as an Omadeus user, every DM the operator sends
 * from that shared account arrives with `senderReferenceId === selfReferenceId`;
 * gating admission on the sender therefore lets the operator's own outbound DMs
 * to *anyone* through. Gating on the counterparty instead confines processing to
 * the DM conversations the operator actually allowlisted.
 *
 * Membership isn't on the socket payload, so it's fetched from the `directs` API
 * and cached by room id. A cache miss fetches just that room (`filters.id`); if
 * that still doesn't resolve it, a full list is fetched once as a fallback.
 *
 * A failed lookup drops the message, so transient API errors are retried with a
 * short backoff before giving up — otherwise a one-second blip silently swallows
 * whatever the user just sent. A genuine outage still fails closed.
 */
export type DirectCounterpartyResolver = {
  /** Counterparty referenceId for a direct room, or `undefined` if it can't be resolved. */
  resolve: (roomId: number) => Promise<number | undefined>;
};

function pickCounterparty(direct: OmadeusDirect, selfReferenceId: number): number | undefined {
  const others = direct.members
    .map((member) => member.referenceId)
    .filter((referenceId) => referenceId !== selfReferenceId);
  // A well-formed direct has exactly one non-self member. If self appears on both
  // sides (self-DM) there is no counterparty; leave it unresolved.
  return others.length > 0 ? others[0] : undefined;
}

/** Retry schedule for transient `directs` API failures, in milliseconds. */
const RESOLVE_RETRY_DELAYS_MS = [250, 1000];

export function createDirectCounterpartyResolver(params: {
  apiOpts: OmadeusApiOptions;
  selfReferenceId: number;
  log: Log;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}): DirectCounterpartyResolver {
  const { apiOpts, selfReferenceId, log } = params;
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const cache = new Map<number, number>();

  const cacheDirects = (directs: OmadeusDirect[]) => {
    for (const direct of directs) {
      const counterparty = pickCounterparty(direct, selfReferenceId);
      if (counterparty !== undefined) {
        cache.set(direct.id, counterparty);
      }
    }
  };

  const lookup = async (roomId: number): Promise<number | undefined> => {
    // Miss: fetch just this room first.
    cacheDirects(await listDirects(apiOpts, { filters: { id: [roomId] } }));
    if (cache.has(roomId)) return cache.get(roomId);

    // Still unknown (e.g. filter unsupported or stale): fall back to a full list once.
    cacheDirects(await listDirects(apiOpts, {}));
    return cache.get(roomId);
  };

  const resolve = async (roomId: number): Promise<number | undefined> => {
    const cached = cache.get(roomId);
    if (cached !== undefined) return cached;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await lookup(roomId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delayMs = RESOLVE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          log.warn(
            `omadeus: failed to resolve direct counterparty for room ${roomId}: ${message}`,
          );
          return undefined;
        }
        log.debug?.(
          `omadeus: direct counterparty lookup for room ${roomId} failed (${message}); retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  };

  return { resolve };
}
