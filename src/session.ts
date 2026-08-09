import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { configureOpenClawBot } from "./api/auth.api.js";
import { createOmadeusMessageHandler } from "./handler.js";
import { parseJaguarMessage } from "./inbound.js";
import { sendOmadeusMessage } from "./outbound.js";
import { pinOpenClawRoom } from "./room.js";
import { createJaguarSocket } from "./socket/socket.js";
import { openOmadeusToken } from "./token.js";
import type { OmadeusLog, ResolvedOmadeusAccount } from "./types.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

/**
 * A live connection to the one room this channel serves.
 *
 * Three members, because there are only three things a caller does with a
 * running gateway: find out where it sends, send there, and shut it down. The
 * credential, the pinned room, the websocket, the reconnect behaviour and the
 * status report to Omadeus are all implementation — they used to be a mutable
 * module-level record that three unrelated call sites read directly, which is
 * why none of them could be exercised without booting a real gateway.
 */
export type OmadeusSession = {
  /** The pinned room. Sends take no target because there is nowhere else to go. */
  readonly roomId: number;
  send(text: string): Promise<{ messageId: string }>;
  /** Stop the socket and release the credential. Idempotent. */
  close(): void;
};

/** Status transitions the gateway wants to mirror onto the account. */
export type OmadeusSessionEvents = {
  onInbound?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
};

/**
 * The adapters the session is built from.
 *
 * Every one of these reaches the network. They default to the real ones, so
 * production callers pass nothing; a test passes fakes and gets the whole
 * lifecycle — startup ordering, the fatal-room path, teardown — without a
 * server. This is the seam that did not exist when `startAccount` constructed
 * all of them inline.
 */
export type OmadeusSessionDeps = {
  openToken: typeof openOmadeusToken;
  pinRoom: typeof pinOpenClawRoom;
  createSocket: typeof createJaguarSocket;
  createHandler: typeof createOmadeusMessageHandler;
  reportStatus: typeof configureOpenClawBot;
  sendMessage: (
    opts: OmadeusApiOptions,
    params: { roomId: number; text: string },
  ) => Promise<{ messageId: string }>;
};

const defaultDeps: OmadeusSessionDeps = {
  openToken: openOmadeusToken,
  pinRoom: pinOpenClawRoom,
  createSocket: createJaguarSocket,
  createHandler: createOmadeusMessageHandler,
  reportStatus: configureOpenClawBot,
  sendMessage: sendOmadeusMessage,
};

export type OpenSessionParams = {
  /** `openClawMemberId` is required: without it the channel cannot tell its own voice from the operator's. */
  account: ResolvedOmadeusAccount & { openClawMemberId: number };
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  log: OmadeusLog;
  events?: OmadeusSessionEvents;
  deps?: Partial<OmadeusSessionDeps>;
};

/**
 * Open a session, or throw explaining why not.
 *
 * Ordering is the point: authenticate, then pin the room, then start reading.
 * Each step proves the one before it — resolving the room proves the credential
 * works — and anything already opened is released before the error leaves this
 * function, so a caller's only obligation is `close()` on the sessions it got
 * back.
 */
export async function openOmadeusSession(params: OpenSessionParams): Promise<OmadeusSession> {
  const { account, cfg, runtime, log, events } = params;
  const deps = { ...defaultDeps, ...params.deps };
  const { openClawMemberId, omadeusUrl } = account;

  const tokenManager = await deps.openToken(account, {
    onError: (err) => {
      log.error(`[omadeus] token refresh failed: ${err.message}`);
      events?.onError?.(err);
    },
  });

  const apiOpts: OmadeusApiOptions = { omadeusUrl, tokenManager };

  let roomId: number;
  try {
    roomId = await deps.pinRoom({ apiOpts, openClawMemberId, log });
  } catch (err) {
    tokenManager.close();
    throw err;
  }

  const handleMessage = deps.createHandler({
    cfg,
    runtime,
    log,
    apiOpts,
    roomId,
    openClawMemberId,
  });

  const socket = deps.createSocket({
    omadeusUrl,
    tokenManager,
    log,
    onMessage: (msg) => {
      const inbound = parseJaguarMessage(msg, log);
      if (!inbound) return;
      // Logged before admission so every arrival is accounted for. Without this
      // a dropped message is the only trace, and a message that never arrives
      // looks identical to one that was silently discarded.
      log.info(
        `[jaguar] message ${inbound.messageId} room=${inbound.roomId} ` +
          `from=${inbound.fromReferenceId}: ${inbound.content.slice(0, 80)}`,
      );
      events?.onInbound?.();
      handleMessage(inbound).catch((err) => {
        log.error(`[jaguar] dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    onConnect: () => {
      events?.onConnect?.();
      // Tell Omadeus the gateway is live. Until this lands, Jaguar keeps routing
      // the member's OpenClaw DM to the setup assistant and refuses `asOpenclaw`
      // on send/see, so the bot cannot answer.
      //
      // Fire-and-forget: a failure here must not tear down a healthy socket, and
      // the socket fires `onConnect` again on the next connection transition.
      void (async () => {
        try {
          await deps.reportStatus({
            omadeusUrl,
            authorization: await tokenManager.authorization(),
            openclawStatus: "connected",
          });
          log.info("[omadeus] reported OpenClaw status: connected");
        } catch (err) {
          log.warn(
            "[omadeus] failed to report connected status; the OpenClaw DM will keep " +
              `going to the setup assistant: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    onDisconnect: () => events?.onDisconnect?.(),
    onError: (err) => events?.onError?.(err),
  });

  socket.connect();

  let closed = false;
  return {
    roomId,
    send: async (text) => await deps.sendMessage(apiOpts, { roomId, text }),
    close: () => {
      if (closed) return;
      closed = true;
      socket.disconnect();
      tokenManager.close();
    },
  };
}
