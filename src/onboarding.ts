import type { ChannelSetupWizard, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { configureOpenClawBot, listOrganizations } from "./api/auth.api.js";
import { getOpenClawDirect } from "./api/direct.api.js";
import { authenticate } from "./auth.js";
import { getOmadeusChannelConfig, resolveOmadeusAccount } from "./config.js";
import { resolveOmadeusUrls } from "./defaults.js";
import { createBearerTokenManager } from "./token.js";

const channel = "omadeus" as const;

/**
 * The wizard is the self-hosted path only: a person running their own gateway,
 * answering with the email and password they already use for Omadeus.
 *
 * Hosted instances never reach here. Their config — including `apiKey` — is
 * rendered by the provisioner before the gateway starts, and they boot with
 * `OPENCLAW_SKIP_ONBOARDING=1`.
 */
function formatAuthError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  const { cause } = err;
  if (cause instanceof Error) {
    parts.push(cause.message);
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && code) parts.push(`(${code})`);
  } else if (typeof cause === "string" && cause.trim()) {
    parts.push(cause);
  }
  return parts.join(" — ");
}

async function promptCredentials(
  prompter: WizardPrompter,
  existing: { email?: string },
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

/**
 * Pick the organization. Listed by email before login, because the account may
 * belong to several and the token is scoped to one of them.
 */
async function promptOrganizationId(params: {
  prompter: WizardPrompter;
  omadeusUrl: string;
  email: string;
  existing?: number;
}): Promise<number> {
  const { prompter, omadeusUrl, email, existing } = params;

  try {
    const orgs = await listOrganizations({ omadeusUrl, email });
    const first = orgs[0];
    if (first) {
      if (orgs.length === 1) {
        await prompter.note(
          `Found organization: ${first.title} (${first.id})`,
          "Omadeus organization",
        );
        return first.id;
      }
      const choice = await prompter.select({
        message: "Select organization",
        options: orgs.map((org) => ({
          value: String(org.id),
          label: `${org.title} (${org.membersCount} members)`,
          hint: `ID: ${org.id}`,
        })),
        initialValue: String(existing ?? first.id),
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
    resolveConfigured: ({ cfg }) => resolveOmadeusAccount({ cfg }).credentialSource !== "none",
    resolveStatusLines: ({ cfg }) => {
      const configured = resolveOmadeusAccount({ cfg }).credentialSource !== "none";
      return [`Omadeus: ${configured ? "configured" : "needs email, password, and organization"}`];
    },
    resolveSelectionHint: ({ cfg }) =>
      resolveOmadeusAccount({ cfg }).credentialSource !== "none"
        ? "configured"
        : "needs credentials",
    resolveQuickstartScore: ({ cfg }) =>
      resolveOmadeusAccount({ cfg }).credentialSource !== "none" ? 2 : 0,
  },
  credentials: [],
  finalize: async ({ cfg, prompter }) => {
    const section = getOmadeusChannelConfig(cfg) ?? {};
    const { casUrl, omadeusUrl } = resolveOmadeusUrls(section);

    await prompter.note(
      [
        "Connect OpenClaw to Omadeus.",
        "",
        "We'll ask for your email and password, then show the organizations on your",
        "account so you can pick one.",
      ].join("\n"),
      "Omadeus setup",
    );

    let { email, password } = await promptCredentials(prompter, { email: section.email });
    const organizationId = await promptOrganizationId({
      prompter,
      omadeusUrl,
      email,
      existing: section.organizationId,
    });

    // Loop until the credentials actually work. Saving unverified credentials
    // produces a gateway that starts and then fails silently, which is the
    // worst outcome for someone who is not going to read a log.
    let sessionToken = "";
    let selfReferenceId = 0;
    for (;;) {
      try {
        const { dolphinToken, payload } = await authenticate({
          casUrl,
          omadeusUrl,
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
          throw new Error("Omadeus setup cancelled: credentials could not be verified.");
        }
        ({ email, password } = await promptCredentials(prompter, { email }));
      }
    }

    // Resolve the OpenClaw bot from the DM itself: of the two members of the
    // OpenClaw direct, the one that is not us. Asking Jaguar beats hardcoding
    // an address, and it is the same room the gateway will serve.
    const direct = await getOpenClawDirect({
      omadeusUrl,
      tokenManager: createBearerTokenManager(sessionToken),
    });
    const openClawMemberId = direct.members.find(
      (member) => member.referenceId !== selfReferenceId,
    )?.referenceId;
    if (openClawMemberId === undefined) {
      throw new Error(
        `Could not find the OpenClaw member in direct room ${direct.id}. ` +
          "Ask an Omadeus admin to check the OpenClaw bot exists in this organization.",
      );
    }

    // The gateway announces `connected` itself once its websocket opens; this
    // only moves the member out of "never set up".
    await configureOpenClawBot({
      omadeusUrl,
      authorization: `Bearer ${sessionToken}`,
      openclawStatus: "connecting",
    });

    await prompter.note(
      `OpenClaw will answer in your direct message with member ${openClawMemberId} (room ${direct.id}). ` +
        "That conversation is the only one it reads.",
      "Omadeus",
    );

    return {
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          omadeus: {
            enabled: true,
            casUrl,
            omadeusUrl,
            email,
            password,
            organizationId,
            openClawMemberId,
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
    };
  },
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      omadeus: { ...getOmadeusChannelConfig(cfg), enabled: false },
    },
  }),
};
