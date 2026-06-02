import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveOmadeusEnvironment } from "./defaults.js";

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
    const email = readSetupStringField(rawInput, "email");
    if (!email && !input.useEnv) {
      return "Omadeus requires --email (or use OMADEUS_EMAIL env var).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, input }) => {
    const rawInput = input as Record<string, unknown>;
    const environmentRaw = readSetupStringField(rawInput, "environment");
    const environment = environmentRaw ? resolveOmadeusEnvironment(environmentRaw) : undefined;
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
          ...(environment ? { environment } : {}),
          ...(email ? { email } : {}),
          ...(password ? { password } : {}),
          ...(organizationId ? { organizationId } : {}),
        },
      },
    } as OpenClawConfig;
  },
};
