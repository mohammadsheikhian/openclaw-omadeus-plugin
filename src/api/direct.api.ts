import { jaguarFetch, OmadeusHttpError, type OmadeusApiOptions } from "../utils/http.util.js";

/** A member of a direct room (only the field we need to tell the two members apart). */
export type OmadeusDirectMember = {
  referenceId: number;
};

/**
 * A Jaguar direct room. The room `id` is the same value that arrives as
 * `roomId` on inbound messages, which is what makes it usable as the single
 * admission key for this channel.
 */
export type OmadeusDirect = {
  id: number;
  members: OmadeusDirectMember[];
};

function readMembers(value: unknown): OmadeusDirectMember[] {
  if (!Array.isArray(value)) return [];
  const members: OmadeusDirectMember[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const ref = (entry as Record<string, unknown>).referenceId;
    if (typeof ref === "number" && Number.isFinite(ref)) {
      members.push({ referenceId: ref });
    }
  }
  return members;
}

/**
 * Fetch the caller's DM with the OpenClaw bot.
 *
 * `openclaw_bot` is a server-side alias: Jaguar resolves the room from the
 * authenticated member, so we never have to know or guess a room id. This is
 * the only room this channel serves, and one call at startup pins it.
 */
export async function getOpenClawDirect(opts: OmadeusApiOptions): Promise<OmadeusDirect> {
  const res = await jaguarFetch(opts, "/directs/openclaw_bot", { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OmadeusHttpError(
      `Omadeus get OpenClaw direct failed (${res.status}): ${text.slice(0, 200)}`,
      res.status,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  const id = body.id;
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new Error("Omadeus OpenClaw direct response is missing a numeric room id");
  }
  return { id, members: readMembers(body.members) };
}
