import { sendRoomMessage } from "./api/message.api.js";
import type { SentMessageTracker } from "./sent-message-tracker.js";
import type { JaguarSocketClient } from "./socket/jaguar.socket.js";
import { generateTemporaryId, type OmadeusApiOptions } from "./utils/http.util.js";

export type OutboundDeps = {
  apiOpts: OmadeusApiOptions;
  jaguarSocket: JaguarSocketClient;
  /** Records messages we send so their socket echoes can be suppressed. */
  sentTracker?: SentMessageTracker;
};

export async function sendOmadeusMessage(
  deps: OutboundDeps,
  params: { to: string; text: string },
): Promise<{ channel: string; messageId: string; chatId: string }> {
  const { to, text } = params;

  const temporaryId = generateTemporaryId();
  // Register before sending: the socket echo can arrive before this HTTP call
  // returns, so the temporaryId (and body fallback) must already be tracked.
  deps.sentTracker?.trackOutbound({ temporaryId, body: text, roomId: to });

  const result = await sendRoomMessage(deps.apiOpts, { roomId: to, body: text, temporaryId });
  if (!result.ok) {
    throw new Error(`Omadeus send failed: ${result.error}`);
  }

  if (typeof result.message?.id === "number") {
    deps.sentTracker?.trackId(result.message.id);
  }

  return {
    channel: "omadeus",
    messageId: String(result.message?.id ?? ""),
    chatId: to,
  };
}
