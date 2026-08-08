import { sendRoomMessage } from "./api/message.api.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

/**
 * Sends go over REST, not the Jaguar socket.
 *
 * Everything sent here echoes back over the socket as inbound. Nothing tracks
 * those echoes: they are authored by the OpenClaw bot (every send carries
 * `asOpenclaw`), and `admitOmadeusMessage` drops anything the bot authored.
 */
export async function sendOmadeusMessage(
  apiOpts: OmadeusApiOptions,
  params: { roomId: number; text: string },
): Promise<{ channel: string; messageId: string; chatId: string }> {
  const result = await sendRoomMessage(apiOpts, {
    roomId: params.roomId,
    body: params.text,
  });
  if (!result.ok) {
    throw new Error(`Omadeus send failed: ${result.error}`);
  }

  return {
    channel: "omadeus",
    messageId: String(result.message?.id ?? ""),
    chatId: String(params.roomId),
  };
}
