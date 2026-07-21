import {
  createReplyPrefixContext,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import { sendOmadeusMessage, type OutboundDeps } from "./outbound.js";
import { getOmadeusRuntime } from "./runtime.js";

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string) => void;
};

export type CreateOmadeusTurnDeliveryParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
  roomId: string;
};

/**
 * Builds the delivery adapter plus dispatcher/reply options for one Omadeus turn.
 *
 * The channel turn kernel owns the dispatcher lifecycle (typing, buffering, settle), so this
 * only has to describe how an Omadeus room is written to.
 */
export function createOmadeusTurnDelivery(params: CreateOmadeusTurnDeliveryParams) {
  const core = getOmadeusRuntime();
  const { cfg, agentId, roomId, accountId } = params;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "omadeus", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "omadeus");

  // Some harnesses (Codex, notably) default direct chats to `message_tool` visible replies, so
  // final assistant text is dropped unless the model calls `message(action=send)`. Weaker models
  // often answer without that call, which silently loses the reply. Omadeus rooms are always a
  // conversation with a human, so default to automatic delivery — but never override an operator
  // who set `messages.visibleReplies` explicitly.
  const sourceReplyDeliveryMode =
    cfg.messages?.visibleReplies === undefined ? ("automatic" as const) : undefined;

  return {
    delivery: {
      durable: () => ({ to: String(roomId) }),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text.trim()) {
          return { visibleReplySent: false };
        }

        const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await sendOmadeusMessage(params.outboundDeps, { to: String(roomId), text: chunk });
        }
        return { visibleReplySent: true };
      },
    },
    dispatcherOptions: {
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    },
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
    },
  };
}
