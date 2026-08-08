import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "../runtime-api.js";
import { resolveOmadeusUrls } from "./defaults.js";
import type { OmadeusChannelConfig, ResolvedOmadeusAccount } from "./types.js";

export function getOmadeusChannelConfig(cfg: OpenClawConfig): OmadeusChannelConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.["omadeus"] as
    | OmadeusChannelConfig
    | undefined;
}

export function listOmadeusAccountIds(cfg: OpenClawConfig): string[] {
  return getOmadeusChannelConfig(cfg) ? [DEFAULT_ACCOUNT_ID] : [];
}

export function resolveDefaultOmadeusAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve the single Omadeus account from config.
 *
 * There are exactly two ways to authenticate and the config file is the only
 * source: an `apiKey` (hosted instances, provisioned for the member) or an
 * email/password/organizationId triple (a member running their own gateway).
 * An API key wins when both are present, because it is the narrower credential.
 */
export function resolveOmadeusAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOmadeusAccount {
  const section = getOmadeusChannelConfig(params.cfg) ?? {};
  const { casUrl, omadeusUrl } = resolveOmadeusUrls(section);

  const apiKey = section.apiKey?.trim() ?? "";
  const email = section.email?.trim() ?? "";
  const password = section.password?.trim() ?? "";
  const organizationId = section.organizationId ?? 0;

  const credentialSource = apiKey
    ? "apikey"
    : email && password && organizationId
      ? "password"
      : "none";

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: "Omadeus",
    enabled: section.enabled !== false,
    config: section,
    casUrl,
    omadeusUrl,
    email,
    password,
    organizationId,
    ...(apiKey ? { apiKey } : {}),
    ...(section.openClawMemberId ? { openClawMemberId: section.openClawMemberId } : {}),
    credentialSource,
  };
}
