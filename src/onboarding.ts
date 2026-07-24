import type { ChannelSetupWizard, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import {
  configureOpenClawBot,
  listOrganizationMembers,
  listOrganizations,
  verifyApiKey,
} from "./api/auth.api.js";
import { authenticate } from "./auth.js";
import { getOmadeusChannelConfig, resolveOmadeusAccount } from "./config.js";
import {
  getOmadeusEnvironmentUrls,
  OMADEUS_DEFAULT_ENVIRONMENT,
  OMADEUS_ENVIRONMENTS,
  resolveOmadeusEnvironment,
  type OmadeusEnvironment,
} from "./defaults.js";
import type { OmadeusChannelConfig, OmadeusOrganizationMember } from "./types.js";

const channel = "omadeus" as const;

/** The OpenClaw bot member. Always used as the messaging allowlist — never user-selectable. */
const OPENCLAW_MEMBER_EMAIL = "openclaw@xeba.tech";


function formatAuthError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  const { cause } = err;
  if (cause instanceof Error) {
    parts.push(cause.message);
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && code) {
      parts.push(`(${code})`);
    }
  } else if (typeof cause === "string" && cause.trim()) {
    parts.push(cause);
  }
  return parts.join(" — ");
}

async function noteOmadeusAuthHelp(
  prompter: WizardPrompter,
  environment: OmadeusEnvironment,
): Promise<void> {
  const envLabel = OMADEUS_ENVIRONMENTS[environment].label;
  await prompter.note(
    [
      `Connect OpenClaw to Omadeus (${envLabel}).`,
      "",
      "We'll ask for your email and password, then show the organizations on your account so you can pick one.",
    ].join("\n"),
    "Omadeus setup",
  );
}

async function promptEnvironment(
  prompter: WizardPrompter,
  existing?: OmadeusEnvironment,
): Promise<OmadeusEnvironment> {
  const initial = existing ?? OMADEUS_DEFAULT_ENVIRONMENT;
  const choice = await prompter.select({
    message: "Select Omadeus environment",
    options: (Object.keys(OMADEUS_ENVIRONMENTS) as OmadeusEnvironment[]).map((env) => ({
      value: env,
      label: OMADEUS_ENVIRONMENTS[env].label,
      hint: getOmadeusEnvironmentUrls(env).maestroUrl,
    })),
    initialValue: initial,
  });
  return resolveOmadeusEnvironment(choice);
}

async function promptOrganizationId(params: {
  prompter: WizardPrompter;
  maestroUrl: string;
  email: string;
  existing?: number;
}): Promise<number> {
  const { prompter, maestroUrl, email, existing } = params;

  try {
    const orgs = await listOrganizations({ maestroUrl, email });
    if (orgs.length > 0) {
      if (orgs.length === 1) {
        await prompter.note(
          `Found organization: ${orgs[0]!.title} (${orgs[0]!.id})`,
          "Omadeus organization",
        );
        return orgs[0]!.id;
      }
      const choice = await prompter.select({
        message: "Select organization",
        options: orgs.map((org) => ({
          value: String(org.id),
          label: `${org.title} (${org.membersCount} members)`,
          hint: `ID: ${org.id}`,
        })),
        initialValue: existing ? String(existing) : String(orgs[0]!.id),
      });
      return Number(choice);
    }
  } catch {
    await prompter.note(
      "Could not fetch organizations from the API. Enter the ID manually.",
      "Omadeus organization",
    );
  }

  const raw = await prompter.text({
    message: "Organization ID (number)",
    initialValue: existing ? String(existing) : undefined,
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "Required";
      if (!/^\d+$/.test(trimmed)) return "Must be a number";
      return undefined;
    },
  });
  return Number(String(raw).trim());
}

/**
 * Always resolves the OpenClaw bot member (`openclaw@xeba.tech`). The member is
 * looked up via the organization members API with an email filter, so the API
 * returns only that one member when it exists. The user never selects this — it
 * is hardcoded.
 */
async function loadOpenClawMember(params: {
  maestroUrl: string;
  authorization: string;
  organizationId: number;
}): Promise<OmadeusOrganizationMember> {
  const members = await listOrganizationMembers({
    maestroUrl: params.maestroUrl,
    authorization: params.authorization,
    organizationId: params.organizationId,
    email: OPENCLAW_MEMBER_EMAIL,
  });
  const member =
    members.find((m) => m.email?.toLowerCase() === OPENCLAW_MEMBER_EMAIL) ?? members[0];
  if (!member) {
    throw new Error(
      `OpenClaw member (${OPENCLAW_MEMBER_EMAIL}) was not found in organization ${params.organizationId}.`,
    );
  }
  return member;
}

async function promptCredentials(
  prompter: WizardPrompter,
  existing: { email?: string; password?: string },
): Promise<{ email: string; password: string }> {
  const email = String(
    await prompter.text({
      message: "Omadeus username (email)",
      initialValue: existing.email,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
  const password = String(
    await prompter.text({
      message: "Omadeus password",
      sensitive: true,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
  return { email, password };
}

export const omadeusSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs credentials",
    configuredHint: "configured",
    unconfiguredHint: "needs credentials",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => {
      const account = resolveOmadeusAccount({ cfg });
      return account.credentialSource !== "none";
    },
    resolveStatusLines: ({ cfg }) => {
      const account = resolveOmadeusAccount({ cfg });
      const configured = account.credentialSource !== "none";
      return [
        `Omadeus: ${configured ? "configured" : "needs email, password, and organization ID"}`,
      ];
    },
    resolveSelectionHint: ({ cfg }) => {
      const account = resolveOmadeusAccount({ cfg });
      return account.credentialSource !== "none" ? "configured" : "needs credentials";
    },
    resolveQuickstartScore: ({ cfg }) => {
      const account = resolveOmadeusAccount({ cfg });
      return account.credentialSource !== "none" ? 2 : 0;
    },
  },
  credentials: [],
  finalize: async ({ cfg, prompter }) => {
    const account = resolveOmadeusAccount({ cfg });
    const section = getOmadeusChannelConfig(cfg) ?? {};
    let next = cfg;

    const environment = await promptEnvironment(
      prompter,
      section.environment ? resolveOmadeusEnvironment(section.environment) : undefined,
    );
    const { casUrl, maestroUrl } = getOmadeusEnvironmentUrls(environment);

    const authMethod = await prompter.select({
      message: "How do you want to authenticate to Omadeus?",
      options: [
        {
          value: "apikey",
          label: "API key (recommended)",
          hint: "Create one in Omadeus, no password stored",
        },
        {
          value: "password",
          label: "Email and password",
          hint: "Legacy CAS login with session refresh",
        },
      ],
      initialValue: section.apiKey ? "apikey" : "password",
    });

    if (authMethod === "apikey") {
      const apiKey = String(
        await prompter.text({
          message: "Omadeus API key",
          sensitive: true,
          initialValue: section.apiKey,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const identity = await verifyApiKey({ maestroUrl, apiKey });
      await prompter.note(
        `API key verified (member ${identity.memberId}, organization ${identity.organizationId}).`,
        "Omadeus authentication",
      );

      const authorization = `ApiToken ${apiKey}`;
      const openClawMember = await loadOpenClawMember({
        maestroUrl,
        authorization,
        organizationId: identity.organizationId,
      });

      await configureOpenClawBot({ maestroUrl, authorization });

      await prompter.note(
        `Inbound policy (Jaguar chat): the DM with the OpenClaw member (${OPENCLAW_MEMBER_EMAIL}, ref ${openClawMember.referenceId}) is the only room served.`,
        "Omadeus inbound policy",
      );

      next = {
        ...next,
        channels: {
          ...next.channels,
          omadeus: {
            enabled: true,
            environment,
            apiKey,
            organizationId: identity.organizationId,
            openClawMemberId: openClawMember.referenceId,
            inbound: {
              version: 1,
              direct: {
                enabled: true,
                requireMention: "never",
              },
            },
          },
        },
      };

      return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
    }

    if (account.credentialSource === "none") {
      await noteOmadeusAuthHelp(prompter, environment);
    }

    const envEmail = process.env.OMADEUS_EMAIL?.trim();
    const envPassword = process.env.OMADEUS_PASSWORD?.trim();

    let { email, password } = await promptCredentials(prompter, {
      email: section.email ?? envEmail,
      password: section.password ?? envPassword,
    });

    const organizationId = await promptOrganizationId({
      prompter,
      maestroUrl,
      email,
      existing: section.organizationId,
    });

    let sessionToken: string | undefined;
    let selfReferenceId: number | undefined;
    while (true) {
      try {
        const { dolphinToken, payload } = await authenticate({
          casUrl,
          maestroUrl,
          email,
          password,
          organizationId,
        });
        sessionToken = dolphinToken;
        selfReferenceId = payload.referenceId;
        await prompter.note(`Authenticated as ${payload.email}`, "Omadeus authentication");
        break;
      } catch (err) {
        await prompter.note(
          `Authentication failed: ${formatAuthError(err)}`,
          "Omadeus authentication",
        );
        const retry = await prompter.confirm({
          message: "Re-enter email/password and try again?",
          initialValue: true,
        });
        if (!retry) {
          await prompter.note(
            "Saving config without verifying credentials. The gateway may fail to connect.",
            "Omadeus authentication",
          );
          break;
        }
        ({ email, password } = await promptCredentials(prompter, { email, password }));
      }
    }

    if (!sessionToken) {
      throw new Error("Authentication is required to list channels.");
    }

    if (typeof selfReferenceId !== "number") {
      throw new Error("Authentication did not return an Omadeus member reference ID.");
    }

    const sessionAuthorization = `Bearer ${sessionToken}`;
    const openClawMember = await loadOpenClawMember({
      maestroUrl,
      authorization: sessionAuthorization,
      organizationId,
    });

    await configureOpenClawBot({ maestroUrl, authorization: sessionAuthorization });

    // The DM with the OpenClaw member is the only room served; the inbound policy
    // recognises it by `openClawMemberId`. There is no separate sender allowlist —
    // the room itself is the allowlist.
    await prompter.note(
      `Inbound policy (Jaguar chat): the DM with the OpenClaw member (${OPENCLAW_MEMBER_EMAIL}, ref ${openClawMember.referenceId}) is the only room served.`,
      "Omadeus inbound policy",
    );

    next = {
      ...next,
      channels: {
        ...next.channels,
        omadeus: {
          enabled: true,
          environment,
          email,
          password,
          organizationId,
          sessionToken,
          sessionTokenEnvironment: environment,
          openClawMemberId: openClawMember.referenceId,
          inbound: {
            version: 1,
            direct: {
              enabled: true,
              requireMention: "never",
            },
          },
        },
      },
    };

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      omadeus: { ...getOmadeusChannelConfig(cfg), enabled: false },
    },
  }),
};

export const omadeusOnboardingAdapter = omadeusSetupWizard;
