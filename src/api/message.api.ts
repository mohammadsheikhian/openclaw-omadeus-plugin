import type { OmadeusMessage } from "../types.js";
import { generateTemporaryId, jaguarRequest, type OmadeusApiOptions } from "../utils/http.util.js";

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
): Promise<OmadeusMessage> {
  return await jaguarRequest<OmadeusMessage>(opts, `/rooms/${params.roomId}/messages`, {
    label: "Omadeus send message",
    method: "SEND",
    body: {
      body: params.body,
      temporaryId: generateTemporaryId(),
      links: "[]",
      asOpenclaw: true,
    },
  });
}

/**
 * Record a read receipt against the OpenClaw bot.
 *
 * `asOpenclaw` makes Jaguar record the receipt against the bot. The gateway
 * authenticates as the operator, so a plain SEE would be the operator seeing
 * their own message, which Jaguar rejects with "1058 Cannot See Own Message".
 */
export async function seeMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<void> {
  await jaguarRequest(opts, `/messages/${params.messageId}`, {
    label: "Omadeus see message",
    method: "SEE",
    body: { asOpenclaw: true },
  });
}
