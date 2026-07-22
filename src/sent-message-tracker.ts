/**
 * Tracks messages this plugin sent so their Jaguar socket echoes can be
 * suppressed, instead of dropping every message authored by the logged-in
 * account.
 *
 * OpenClaw sends over the same Jaguar socket it listens on, so each outbound
 * message is broadcast back to us. We register two keys per send:
 *
 * - the client-generated `temporaryId` — known *before* the HTTP round-trip, so
 *   it matches even when the socket echo beats the send response (the common
 *   race);
 * - the backend message `id` — known once the send response returns.
 *
 * Both are authoritative. There is deliberately **no body-matching fallback**:
 * replies are posted with `asOpenclaw`, so they echo back authored by the
 * OpenClaw bot, never by the operator. A body match could therefore only ever
 * fire on the operator's *own* genuine message — silently swallowing it
 * whenever they happened to repeat something OpenClaw had just said ("1",
 * "ok", "yes") within the TTL.
 *
 * Entries expire after a short TTL and each map is size-capped, so the tracker
 * cannot grow unbounded.
 */

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes — comfortably covers echo latency.
const DEFAULT_MAX_ENTRIES = 500;

export type SentMessageTrackerOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

export class SentMessageTracker {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly ids = new Map<number, number>();
  private readonly temporaryIds = new Map<string, number>();

  constructor(options: SentMessageTrackerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Register a client-generated temporaryId. Call before sending. */
  trackTemporaryId(temporaryId: string): void {
    if (!temporaryId) return;
    this.remember(this.temporaryIds, temporaryId);
  }

  /** Register the backend message id once the send response returns. */
  trackId(id: number): void {
    if (!Number.isFinite(id)) return;
    this.remember(this.ids, id);
  }

  /** Convenience: register whichever keys are available for one outbound message. */
  trackOutbound(params: { temporaryId?: string; id?: number }): void {
    if (params.temporaryId) this.trackTemporaryId(params.temporaryId);
    if (typeof params.id === "number") this.trackId(params.id);
  }

  /** Returns true when an inbound socket message is an echo of something we sent. */
  isEcho(msg: { id?: number; temporaryId?: string }): boolean {
    if (typeof msg.id === "number" && this.has(this.ids, msg.id)) return true;
    if (msg.temporaryId && this.has(this.temporaryIds, msg.temporaryId)) return true;
    return false;
  }

  private remember<K>(map: Map<K, number>, key: K): void {
    // Delete-then-set so re-registered keys move to the end, keeping insertion
    // order aligned with expiry order (the TTL is constant).
    map.delete(key);
    map.set(key, this.now() + this.ttlMs);
    this.prune(map);
  }

  private has<K>(map: Map<K, number>, key: K): boolean {
    const expiry = map.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      map.delete(key);
      return false;
    }
    return true;
  }

  private prune<K>(map: Map<K, number>): void {
    const now = this.now();
    for (const [key, expiry] of map) {
      if (expiry <= now) {
        map.delete(key);
      } else {
        // Insertion order matches expiry order, so the first live entry means
        // everything after it is also live.
        break;
      }
    }
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
