import { isOmadeusMessage } from "../inbound.js";
import type { OmadeusTokenManager } from "../token.js";
import type { OmadeusMessage } from "../types.js";
import { createOmadeusSocketClient, type OmadeusSocketClient } from "./socket.js";

export type JaguarSocketOptions = {
  omadeusUrl: string;
  tokenManager: OmadeusTokenManager;
  onMessage?: (msg: OmadeusMessage) => void;
  /** Called for any non-message events (typing, presence, etc.). */
  onOtherEvent?: (data: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export type JaguarSocketClient = OmadeusSocketClient;

export function createJaguarSocketClient(opts: JaguarSocketOptions): JaguarSocketClient {
  const {
    omadeusUrl,
    tokenManager,
    onMessage,
    onOtherEvent,
    onConnect,
    onDisconnect,
    onError,
    log,
  } = opts;

  return createOmadeusSocketClient({
    omadeusUrl,
    tokenManager,
    pathSuffix: "ws",
    logPrefix: "[jaguar]",
    onEvent: (data) => {
      if (isOmadeusMessage(data)) {
        onMessage?.(data as OmadeusMessage);
      } else {
        onOtherEvent?.(data);
      }
    },
    onConnect,
    onDisconnect,
    onError,
    log,
  });
}
