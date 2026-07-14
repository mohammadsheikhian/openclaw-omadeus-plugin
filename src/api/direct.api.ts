import { jaguarFetch, type OmadeusApiOptions } from "../utils/http.util.js";

/** A member of a direct room (only the fields we need to resolve a counterparty). */
export type OmadeusDirectMember = {
  referenceId: number;
};

/**
 * A Jaguar direct room. The room `id` is the same value that arrives as
 * `roomId` on inbound messages, so it keys the counterparty cache.
 */
export type OmadeusDirect = {
  id: number;
  subscribableKind?: string;
  members: OmadeusDirectMember[];
};

function readMembers(value: unknown): OmadeusDirectMember[] {
  if (!Array.isArray(value)) return [];
  const members: OmadeusDirectMember[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const ref = (entry as Record<string, unknown>).referenceId;
      if (typeof ref === "number" && Number.isFinite(ref)) {
        members.push({ referenceId: ref });
      }
    }
  }
  return members;
}

function parseDirects(payload: unknown): OmadeusDirect[] {
  if (!Array.isArray(payload)) return [];
  const directs: OmadeusDirect[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    directs.push({
      id: row.id,
      subscribableKind: typeof row.subscribableKind === "string" ? row.subscribableKind : undefined,
      members: readMembers(row.members),
    });
  }
  return directs;
}

/**
 * List Jaguar direct rooms with their members. Mirrors the frontend `directs` LIST call:
 * `filters` are encoded as `key=IN(v1,v2,…)` query params. Pass `{ id: [roomId] }` to fetch a
 * single direct by its room id.
 */
export async function listDirects(
  opts: OmadeusApiOptions,
  params: {
    filters?: Record<string, (string | number)[]>;
    skip?: number;
    take?: number;
    signal?: AbortSignal;
  } = {},
): Promise<OmadeusDirect[]> {
  const { filters, skip = 0, take = 100, signal } = params;
  const search = new URLSearchParams();
  if (take) search.set("take", String(take));
  if (skip) search.set("skip", String(skip));
  if (filters) {
    for (const [key, values] of Object.entries(filters)) {
      search.set(key, `IN(${values.join(",")})`);
    }
  }
  const qs = search.toString();
  const res = await jaguarFetch(opts, `/directs${qs ? `?${qs}` : ""}`, {
    method: "LIST",
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list directs failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return parseDirects(await res.json());
}
