import { dolphinFetch, type OmadeusApiOptions } from "../utils/http.util.js";

type NuggetSearchParams = {
  /** Display nugget id from user text (e.g. N111 → 111). Matches API field `number`, not internal `id`. */
  nuggetNumber: number;
  signal?: AbortSignal;
};

export type OmadeusNuggetPriority = "low" | "medium" | "high" | "urgent";
export type OmadeusNuggetKind = "task" | "nugget";

export type CreateNuggetParams = {
  title: string;
  description: string;
  stage: string;
  kind: OmadeusNuggetKind;
  priority: OmadeusNuggetPriority;
  memberReferenceId: number;
  clientId: number;
  folderId: number;
  signal?: AbortSignal;
};

/** Omadeus nugget/task display number (`N###` in UI maps to this field). */
export function readNuggetNumber(record: Record<string, unknown>): number | undefined {
  const value = record["number"];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

export function findNuggetRowByNumber(
  rows: Record<string, unknown>[],
  nuggetNumber: number,
): Record<string, unknown> | undefined {
  return rows.find((row) => readNuggetNumber(row) === nuggetNumber);
}

export function resolveTaskChannelRoomId(record: Record<string, unknown>): number | undefined {
  return (
    readNumberField(record, "privateRoomId") ??
    readNumberField(record, "publicRoomId") ??
    readNumberField(record, "sharedRoomId")
  );
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
    );
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const envelope = payload as Record<string, unknown>;
  const candidateKeys = ["data", "results", "items", "rows"];
  for (const key of candidateKeys) {
    const value = envelope[key];
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
      );
    }
  }
  return [];
}

/**
 * Dolphin SEARCH on nuggetviews — arbitrary text query (e.g. N###, task title, or room id string).
 * Prefer filtering results with `findNuggetRowByNumber` or `findNuggetRowByRoomId`.
 */
export async function searchNuggetRowsByTextQuery(
  opts: OmadeusApiOptions,
  params: { query: string; take?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>[]> {
  const take = params.take ?? 100;
  const q = params.query.trim();
  if (!q) {
    return [];
  }
  const search = new URLSearchParams();
  search.set("take", String(take));
  const res = await dolphinFetch(opts, `/nuggetviews?${search.toString()}`, {
    method: "SEARCH",
    body: JSON.stringify({ query: q }),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus nugget search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const payload = (await res.json()) as unknown;
  return extractRows(payload);
}

/**
 * All keys on a row whose numeric value equals `roomId` and that look like a room reference
 * (`privateRoomId`, `publicRoomId`, `sharedRoomId`, `threadRoomId`, `roomId`, …). Used both to
 * match a row and to diagnose lookups where the room id lives under an unexpected field name.
 */
export function roomIdMatchKeys(row: Record<string, unknown>, roomId: number): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(row)) {
    if (!/room/i.test(key)) {
      continue;
    }
    if (readNumberField(row, key) === roomId) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Dolphin SEARCH on nuggetviews narrowed to an **exact `title`** via query param. The `{ query }`
 * body is still required (omitting it 400s "Query Parameter Not In Form Or Query String"); the
 * `?title=` param is what filters to the exact match. A fuzzy title like "test1" can otherwise return
 * 999+ rows and bury the target past `take`. Remaining same-title rows are disambiguated by room id.
 */
export async function searchNuggetRowsByExactTitle(
  opts: OmadeusApiOptions,
  params: { title: string; take?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>[]> {
  const title = params.title.trim();
  if (!title) {
    return [];
  }
  const search = new URLSearchParams();
  search.set("take", String(params.take ?? 100));
  search.set("title", title);
  const res = await dolphinFetch(opts, `/nuggetviews?${search.toString()}`, {
    method: "SEARCH",
    body: JSON.stringify({query: title}),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus nugget title search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const payload = (await res.json()) as unknown;
  return extractRows(payload);
}

/**
 * Picks a row whose task room id matches a Jaguar `roomId`. Matches any `*room*` numeric field
 * (private/public/shared/thread/…), not just a hardcoded three, so newly-shaped rows still resolve.
 */
export function findNuggetRowByRoomId(
  rows: Record<string, unknown>[],
  roomId: number,
): Record<string, unknown> | undefined {
  return rows.find((row) => roomIdMatchKeys(row, roomId).length > 0);
}

export type FindNuggetByTaskRoomParams = {
  roomId: number;
  roomName?: string | null;
  signal?: AbortSignal;
  /** Optional diagnostics sink; receives one line per attempted search query. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

/**
 * Resolve the nugget/task row for a Jaguar Task or Nugget **chat room** by matching any `*room*`
 * id field to `roomId` in Dolphin `nuggetviews` search results.
 * Tries search by `roomName` first (usually matches the task title), then by the numeric `roomId` as text.
 */
export async function findNuggetByTaskChannelRoom(
  opts: OmadeusApiOptions,
  params: FindNuggetByTaskRoomParams,
): Promise<Record<string, unknown> | null> {
  const { roomId, roomName, signal, log } = params;
  const trimmedName = typeof roomName === "string" ? roomName.trim() : "";

  // Ordered attempts, best-first. Exact `title=` filtering avoids the fuzzy 999+ result set that
  // buries the target past `take`; searching the numeric room id as text is a last-resort fallback
  // (and the only option when there is no room name to search by).
  const attempts: { label: string; run: () => Promise<Record<string, unknown>[]> }[] = [];
  if (trimmedName) {
    attempts.push({
      label: `title="${trimmedName}"`,
      run: () => searchNuggetRowsByExactTitle(opts, { title: trimmedName, take: 100, signal }),
    });
  }
  attempts.push({
    label: `query="${roomId}"`,
    run: () => searchNuggetRowsByTextQuery(opts, { query: String(roomId), take: 100, signal }),
  });

  for (const attempt of attempts) {
    const rows = await attempt.run();
    const match = findNuggetRowByRoomId(rows, roomId);
    if (log) {
      // Which fields (if any) across returned rows carry the target roomId — surfaces the case where
      // the row IS in the results but its room id lives under an unexpected key.
      const roomKeysSeen = Array.from(
        new Set(rows.flatMap((row) => roomIdMatchKeys(row, roomId))),
      );
      log(
        `omadeus nugget-room lookup ${attempt.label} rows=${rows.length} matched=${!!match}`,
        { roomId, roomKeysSeen },
      );
    }
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * Dolphin SEARCH on nuggetviews returns an array of nugget/task rows.
 * User-facing `N111` corresponds to `number: 111` on each row (not `id`).
 */
export async function searchNuggetByNumber(
  opts: OmadeusApiOptions,
  params: NuggetSearchParams,
): Promise<Record<string, unknown> | null> {
  const rows = await searchNuggetRowsByTextQuery(opts, {
    query: `N${params.nuggetNumber}`,
    take: 100,
    signal: params.signal,
  });
  const match = findNuggetRowByNumber(rows, params.nuggetNumber);
  return match ?? null;
}

export async function resolveTaskRoomIdByNumber(
  opts: OmadeusApiOptions,
  params: NuggetSearchParams,
): Promise<number | null> {
  const row = await searchNuggetByNumber(opts, params);
  if (!row) {
    return null;
  }
  return resolveTaskChannelRoomId(row) ?? null;
}

export async function createNugget(
  opts: OmadeusApiOptions,
  params: CreateNuggetParams,
): Promise<Record<string, unknown>> {
  const res = await dolphinFetch(opts, "/nuggets", {
    method: "CREATE",
    body: JSON.stringify({
      title: params.title,
      stage: params.stage,
      description: params.description,
      kind: params.kind,
      priority: params.priority,
      memberReferenceId: params.memberReferenceId,
      clientId: params.clientId,
      folderId: params.folderId,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus nugget create failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
