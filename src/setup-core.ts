import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";
import type { OpenClawConfig } from "../runtime-api.js";

function readSetupStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSetupNumberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export const omadeusSetupAdapter: ChannelSetupAdapter = {
  validateInput: ({ input }) => {
    const rawInput = input as Record<string, unknown>;
    const apiKey = readSetupStringField(rawInput, "apiKey");
    const email = readSetupStringField(rawInput, "email");
    if (!apiKey && !email && !input.useEnv) {
      return "Omadeus requires --apiKey or --email (or the OMADEUS_API_KEY/OMADEUS_EMAIL env vars).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, input }) => {
    const rawInput = input as Record<string, unknown>;
    const casUrl = readSetupStringField(rawInput, "casUrl");
    const omadeusUrl = readSetupStringField(rawInput, "omadeusUrl");
    const apiKey = readSetupStringField(rawInput, "apiKey");
    const email = readSetupStringField(rawInput, "email");
    const password = input.password?.trim() || undefined;
    const organizationId = readSetupNumberField(rawInput, "organizationId");

    const channelsRecord = cfg.channels as Record<string, unknown> | undefined;
    const omadeusExisting = channelsRecord?.["omadeus"];
    const omadeusPrevious =
      omadeusExisting !== null &&
      typeof omadeusExisting === "object" &&
      !Array.isArray(omadeusExisting)
        ? (omadeusExisting as Record<string, unknown>)
        : {};

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        omadeus: {
          ...omadeusPrevious,
          enabled: true,
          ...(casUrl ? { casUrl } : {}),
          ...(omadeusUrl ? { omadeusUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(email ? { email } : {}),
          ...(password ? { password } : {}),
          ...(organizationId ? { organizationId } : {}),
        },
      },
    } as OpenClawConfig;
  },
};
