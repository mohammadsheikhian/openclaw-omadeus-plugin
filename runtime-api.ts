export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
export type {
  ChannelPlugin,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
export {
  type ChannelStatusIssue,
  createReplyPrefixContext,
} from "openclaw/plugin-sdk/channel-runtime";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
export { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
export { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
export type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";

export function missingTargetError(provider: string, hint?: string): Error {
  const normalizedHint = hint?.trim();
  return new Error(
    `Delivering to ${provider} requires target${normalizedHint ? ` ${normalizedHint}` : ""}`,
  );
}
