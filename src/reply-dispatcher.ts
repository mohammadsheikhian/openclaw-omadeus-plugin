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

export type CreateOmadeusReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
  roomId: string;
};

export function createOmadeusReplyDispatcher(params: CreateOmadeusReplyDispatcherParams) {
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

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;

        const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await sendOmadeusMessage(params.outboundDeps, { to: String(roomId), text: chunk });
        }
      },
      onError: (error, info) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        params.runtime.error?.(`omadeus ${info.kind} reply failed: ${errMsg}`);
        params.log.error("reply failed", { kind: info.kind, error: errMsg });
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
    },
    markDispatchIdle,
  };
}
