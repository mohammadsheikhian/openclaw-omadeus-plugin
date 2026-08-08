import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "../runtime-api.js";
import { resolveOmadeusUrls } from "./defaults.js";
import type { OmadeusChannelConfig, ResolvedOmadeusAccount } from "./types.js";

export function getOmadeusChannelConfig(cfg: OpenClawConfig): OmadeusChannelConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.["omadeus"] as
    | OmadeusChannelConfig
    | undefined;
}

/**
 * The OpenClaw member id, honouring the legacy `openClawReferenceId` key so
 * configs written before the rename keep working until setup is re-run.
 */
export function resolveOpenClawMemberId(
  section: OmadeusChannelConfig | undefined,
): number | undefined {
  return section?.openClawMemberId ?? section?.openClawReferenceId;
}

export function listOmadeusAccountIds(cfg: OpenClawConfig): string[] {
  const section = getOmadeusChannelConfig(cfg);
  if (!section && !resolveOmadeusEnvCredentials() && !process.env.OMADEUS_API_KEY?.trim()) {
    return [];
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultOmadeusAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveOmadeusAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOmadeusAccount {
  const { cfg } = params;
  const section = getOmadeusChannelConfig(cfg) ?? {};
  const { casUrl, omadeusUrl } = resolveOmadeusUrls(section);
  const envCredentials = resolveOmadeusEnvCredentials();
  const apiKey = section.apiKey?.trim() || process.env.OMADEUS_API_KEY?.trim() || "";
  const email = section.email?.trim() || envCredentials?.email || "";
  const password = section.password?.trim() || envCredentials?.password || "";
  const orgId = section.organizationId ?? envCredentials?.organizationId;
  const sessionToken = section.sessionToken?.trim() ?? "";
  const hasCredentials = Boolean(email && password && orgId);
  const hasSessionToken = Boolean(sessionToken);
  const hasConfigCredentials = Boolean(
    section.email?.trim() && section.password?.trim() && section.organizationId,
  );
  const credentialSource = apiKey
    ? "apikey"
    : hasConfigCredentials
      ? "config"
      : hasCredentials
        ? "env"
        : hasSessionToken
          ? "session"
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
    organizationId: orgId ?? 0,
    ...(hasSessionToken ? { sessionToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    credentialSource,
  };
}

function resolveOmadeusEnvCredentials():
  | {
      email: string;
      password: string;
      organizationId: number;
    }
  | undefined {
  const email = process.env.OMADEUS_EMAIL?.trim();
  const password = process.env.OMADEUS_PASSWORD?.trim();
  const organizationIdRaw = process.env.OMADEUS_ORGANIZATION_ID?.trim();
  if (!email || !password || !organizationIdRaw || !/^\d+$/.test(organizationIdRaw)) {
    return undefined;
  }
  return {
    email,
    password,
    organizationId: Number(organizationIdRaw),
  };
}

/** Whether messages from the authenticated user should be ignored. */
