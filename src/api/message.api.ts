import type { OmadeusMessage } from "../types.js";
import { jaguarFetch, generateTemporaryId, type OmadeusApiOptions } from "../utils/http.util.js";

async function readJsonOrEmpty(res: Response): Promise<unknown> {
  if (res.status === 204) {
    return undefined;
  }
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/**
 * Post a message to a room as the OpenClaw bot.
 *
 * `asOpenclaw` is not optional. It is what makes the reply appear as OpenClaw
 * rather than the operator whose account the gateway holds — and inbound echo
 * suppression depends on it, since it recognises our own messages by author.
 */
export async function sendRoomMessage(
  opts: OmadeusApiOptions,
  params: { roomId: number | string; body: string },
): Promise<{ ok: boolean; message?: OmadeusMessage; error?: string }> {
  try {
    const res = await jaguarFetch(opts, `/rooms/${params.roomId}/messages`, {
      method: "SEND",
      body: JSON.stringify({
        body: params.body,
        temporaryId: generateTemporaryId(),
        links: "[]",
        asOpenclaw: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as OmadeusMessage;
    return { ok: true, message: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 300) };
  }
}

export async function seeMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "SEE",
    // `asOpenclaw` makes Jaguar record the receipt against the OpenClaw bot. The gateway
    // authenticates as the operator, so a plain SEE would be the operator seeing their own
    // message, which Jaguar rejects with "1058 Cannot See Own Message".
    body: JSON.stringify({ asOpenclaw: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus see message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}
