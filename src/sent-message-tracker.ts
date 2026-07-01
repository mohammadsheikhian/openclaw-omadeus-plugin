/**
 * Tracks messages this plugin sent so their Jaguar socket echoes can be
 * suppressed, instead of dropping every message authored by the logged-in
 * account.
 *
 * OpenClaw sends as the same Omadeus account it listens on, so each outbound
 * message is broadcast back to us over the socket. We register up to three keys
 * per send:
 *
 * - the client-generated `temporaryId` — known *before* the HTTP round-trip, so
 *   it matches even when the socket echo beats the send response (the common
 *   race);
 * - the backend message `id` — known once the send response returns;
 * - a normalized copy of the body scoped to its room — a last-resort fallback
 *   used only for self-authored echoes that somehow arrive without a
 *   recognizable id. Scoping by room prevents the same text sent in one chat
 *   from suppressing an identical message in a different chat.
 *
 * `id` and `temporaryId` are kept in separate maps. Entries expire after a
 * short TTL and each map is size-capped, so the tracker cannot grow unbounded.
 */

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes — comfortably covers echo latency.
const DEFAULT_MAX_ENTRIES = 500;

export type SentMessageTrackerOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

function normalizeContent(body: string): string {
  return body.trim();
}

/** Normalize a room identity so outbound (`"room:123"`/`"123"`) and the socket
 * echo (numeric `123`) map to the same key. */
function roomKey(roomId: string | number): string {
  return String(roomId).replace(/^room:/, "").trim();
}

/** Build the room-scoped content key, or undefined when the body is empty. */
function contentKey(roomId: string | number, body: string): string | undefined {
  const normalized = normalizeContent(body);
  if (!normalized) return undefined;
  return `${roomKey(roomId)}\n${normalized}`;
}

export class SentMessageTracker {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly ids = new Map<number, number>();
  private readonly temporaryIds = new Map<string, number>();
  private readonly contents = new Map<string, number>();

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

  /** Register a message body, scoped to its room, as a fallback match key. */
  trackContent(roomId: string | number, body: string): void {
    const key = contentKey(roomId, body);
    if (!key) return;
    this.remember(this.contents, key);
  }

  /** Convenience: register whichever keys are available for one outbound message. */
  trackOutbound(params: {
    temporaryId?: string;
    id?: number;
    body?: string;
    roomId?: string | number;
  }): void {
    if (params.temporaryId) this.trackTemporaryId(params.temporaryId);
    if (typeof params.id === "number") this.trackId(params.id);
    if (typeof params.body === "string" && params.roomId !== undefined) {
      this.trackContent(params.roomId, params.body);
    }
  }

  /**
   * Returns true when an inbound socket message is an echo of something we sent.
   *
   * `id`/`temporaryId` matches are authoritative. The content fallback only
   * applies to self-authored messages — the only ones that can form a reply
   * loop — and is scoped to the message's room, so a different user repeating
   * our text (or the same text in another room) is never suppressed.
   */
  isEcho(msg: {
    id?: number;
    temporaryId?: string;
    body?: string;
    roomId?: string | number;
    fromSelf: boolean;
  }): boolean {
    if (typeof msg.id === "number" && this.has(this.ids, msg.id)) return true;
    if (msg.temporaryId && this.has(this.temporaryIds, msg.temporaryId)) return true;
    if (msg.fromSelf && typeof msg.body === "string" && msg.roomId !== undefined) {
      const key = contentKey(msg.roomId, msg.body);
      if (key && this.has(this.contents, key)) return true;
    }
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
