import type { ChannelSetupWizard, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import {
  configureOpenClawBot,
  listOrganizationMembers,
  listOrganizations,
} from "./api/auth.api.js";
import { listMemberChannelViews } from "./api/channel.api.js";
import { authenticate } from "./auth.js";
import { getOmadeusChannelConfig, resolveOmadeusAccount } from "./config.js";
import {
  getOmadeusEnvironmentUrls,
  OMADEUS_DEFAULT_ENVIRONMENT,
  OMADEUS_ENVIRONMENTS,
  resolveOmadeusEnvironment,
  type OmadeusEnvironment,
} from "./defaults.js";
import { formatMemberLabel } from "./member-resolve.js";
import type {
  OmadeusChannelConfig,
  OmadeusChannelView,
  OmadeusInboundEntityKind,
  OmadeusInboundMentionPolicy,
  OmadeusOrganizationMember,
} from "./types.js";
import { OMADEUS_INBOUND_ENTITY_KINDS } from "./types.js";

const channel = "omadeus" as const;

type SelectOption = {
  value: string;
  label: string;
  hint?: string;
};

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

async function promptChannelSelection(params: {
  prompter: WizardPrompter;
  maestroUrl: string;
  sessionToken: string;
  memberReferenceId: number;
  existingChannelViewIds?: number[];
}): Promise<OmadeusChannelView[]> {
  const { prompter, maestroUrl, sessionToken, memberReferenceId, existingChannelViewIds } = params;
  const channels = await listMemberChannelViews({
    maestroUrl,
    sessionToken,
    memberReferenceId,
    skip: 0,
    take: 100,
  });
  if (channels.length === 0) {
    await prompter.note(
      "No channels found for this account. Channel listening will stay disabled.",
      "Omadeus channels",
    );
    return [];
  }

  const listenToChannels = await prompter.confirm({
    message: "Listen for messages in Omadeus channels?",
    initialValue: (existingChannelViewIds?.length ?? 0) > 0,
  });
  if (!listenToChannels) {
    return [];
  }

  const selected = await promptMultiSelect({
    prompter,
    message: "Which channels should OpenClaw listen to?",
    options: channels.map((item) => ({
      value: String(item.id),
      label: item.title || `Channel ${item.id}`,
      hint: [item.privateRoomId ? `private:${item.privateRoomId}` : undefined, item.publicRoomId ? `public:${item.publicRoomId}` : undefined]
        .filter(Boolean)
        .join(" | "),
    })),
    initialValues:
      existingChannelViewIds && existingChannelViewIds.length > 0
        ? existingChannelViewIds.map(String)
        : undefined,
  });
  return channels.filter((item) => selected.includes(String(item.id)));
}

function memberHint(member: OmadeusOrganizationMember): string | undefined {
  const fullName = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();
  const parts = [fullName, member.email?.trim(), `ref:${member.referenceId}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

async function promptMultiSelect(params: {
  prompter: WizardPrompter;
  message: string;
  options: SelectOption[];
  initialValues?: string[];
}): Promise<string[]> {
  return params.prompter.multiselect({
    message: params.message,
    options: params.options,
    initialValues: params.initialValues,
  });
}

async function loadSelectableMembers(params: {
  maestroUrl: string;
  sessionToken: string;
  organizationId: number;
  excludeReferenceIds?: number[];
}): Promise<OmadeusOrganizationMember[]> {
  const excluded = new Set(params.excludeReferenceIds ?? []);
  return (
    await listOrganizationMembers({
      maestroUrl: params.maestroUrl,
      sessionToken: params.sessionToken,
      organizationId: params.organizationId,
    })
  )
    .filter((member) => member.isSystem !== true && !excluded.has(member.referenceId))
    .sort((a, b) => formatMemberLabel(a).localeCompare(formatMemberLabel(b)));
}

function memberOptions(members: OmadeusOrganizationMember[]): SelectOption[] {
  return members.map((member) => ({
    value: String(member.referenceId),
    label: formatMemberLabel(member),
    hint: memberHint(member),
  }));
}

function readReferenceIds(values: string[]): number[] {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
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

/**
 * Prompt for the set of users allowed to message this OpenClaw instance.
 *
 * This single allowlist governs direct messages, channels, and entity rooms.
 * There is no "all users" option: only whitelisted members may message
 * OpenClaw. The logged-in user is always added
 * to the allowlist (and is excluded from the selectable list by the caller) so
 * they can interact with their own OpenClaw. Self-authored echoes (the reply
 * loop) are filtered earlier, at socket ingestion, by the SentMessageTracker —
 * not by the inbound policy — so allowing yourself here cannot cause a loop.
 */
async function promptMessagingAllowlist(params: {
  prompter: WizardPrompter;
  members: OmadeusOrganizationMember[];
  selfReferenceId: number;
  existingReferenceIds?: number[];
}): Promise<number[]> {
  const { prompter, members, selfReferenceId, existingReferenceIds } = params;

  let selected: number[] = [];
  if (members.length === 0) {
    await prompter.note(
      "No other organization members found. Only you will be able to message OpenClaw.",
      "Omadeus messaging allowlist",
    );
  } else {
    const memberReferenceIds = new Set(members.map((member) => member.referenceId));
    const initialValues = (existingReferenceIds ?? [])
      .filter((id) => id !== selfReferenceId && memberReferenceIds.has(id))
      .map(String);
    const chosen = await promptMultiSelect({
      prompter,
      message: "Which users do you want to be able to message this OpenClaw instance? (You are always allowed.)",
      options: memberOptions(members),
      initialValues,
    });
    selected = readReferenceIds(chosen);
  }

  // Always allow the logged-in user so they can message their own OpenClaw.
  return Array.from(new Set([selfReferenceId, ...selected]));
}

/**
 * Ask whether an @mention is required to trigger OpenClaw in a given surface
 * (channels or entity rooms). DMs never use this — you can't @mention in a DM.
 */
async function promptRequireMention(params: {
  prompter: WizardPrompter;
  surfaceLabel: string;
  existing?: OmadeusInboundMentionPolicy;
}): Promise<OmadeusInboundMentionPolicy> {
  // Preserve an existing "outsideAllowlist" policy so rerunning onboarding does
  // not force previously allowlisted users to start @mentioning OpenClaw.
  if (params.existing === "outsideAllowlist") {
    return "outsideAllowlist";
  }
  const required = await params.prompter.confirm({
    message: `Require an @mention to trigger OpenClaw in ${params.surfaceLabel}?`,
    initialValue: params.existing ? params.existing !== "never" : true,
  });
  return required ? "always" : "never";
}

async function promptEntityKindSelection(params: {
  prompter: WizardPrompter;
  existingKinds?: OmadeusInboundEntityKind[];
}): Promise<OmadeusInboundEntityKind[]> {
  const selected = await promptMultiSelect({
    prompter: params.prompter,
    message: "Which entity room types should OpenClaw listen to?",
    options: OMADEUS_INBOUND_ENTITY_KINDS.map((kind) => ({
      value: kind,
      label: kind,
    })),
    initialValues:
      params.existingKinds && params.existingKinds.length > 0
        ? params.existingKinds
        : [...OMADEUS_INBOUND_ENTITY_KINDS],
  });
  const selectedSet = new Set(selected);
  return OMADEUS_INBOUND_ENTITY_KINDS.filter((kind) => selectedSet.has(kind));
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

    const members = await loadSelectableMembers({
      maestroUrl,
      sessionToken,
      organizationId,
      excludeReferenceIds: [selfReferenceId],
    });

    await configureOpenClawBot({ maestroUrl, sessionToken });

    const existingInbound = section.inbound;

    const allowedUserReferenceIds = await promptMessagingAllowlist({
      prompter,
      members,
      selfReferenceId,
      existingReferenceIds: Array.from(
        new Set([
          ...(existingInbound?.direct?.allowedSenderReferenceIds ?? []),
          ...(existingInbound?.channels?.allowedSenderReferenceIds ?? []),
          ...(existingInbound?.entities?.allowedSenderReferenceIds ?? []),
        ]),
      ),
    });

    const selectedChannels = await promptChannelSelection({
      prompter,
      maestroUrl,
      sessionToken,
      memberReferenceId: selfReferenceId,
      existingChannelViewIds: existingInbound?.channels?.allowedChannelViewIds,
    });

    // Channels reuse the same messaging allowlist as direct messages.
    const channelSenderIds = selectedChannels.length > 0 ? allowedUserReferenceIds : undefined;
    const channelRequireMention =
      selectedChannels.length > 0
        ? await promptRequireMention({
            prompter,
            surfaceLabel: "allowed channels",
            existing: existingInbound?.channels?.requireMention,
          })
        : "never";

    const entityKinds = await promptEntityKindSelection({
      prompter,
      existingKinds: existingInbound?.entities?.allowedKinds,
    });

    // Entity rooms reuse the same messaging allowlist as direct messages.
    const entitySenderIds = entityKinds.length > 0 ? allowedUserReferenceIds : undefined;
    const entityRequireMention =
      entityKinds.length > 0
        ? await promptRequireMention({
            prompter,
            surfaceLabel: "entity rooms",
            existing: existingInbound?.entities?.requireMention,
          })
        : "never";

    const channelRoomIds = selectedChannels
      .flatMap((selectedChannel) => [
        selectedChannel.publicRoomId,
        selectedChannel.privateRoomId,
      ])
      .filter((id): id is number => typeof id === "number");
    const channelViewIds = selectedChannels.map((selectedChannel) => selectedChannel.id);
    const channelTitles = selectedChannels
      .map((selectedChannel) => selectedChannel.title || `Channel ${selectedChannel.id}`)
      .join(", ");

    const senderSummary = (ids: number[] | undefined) =>
      ids && ids.length > 0 ? ids.join(", ") : "all users";
    const mentionSummary = (require: OmadeusInboundMentionPolicy) =>
      require === "never"
        ? "no @mention required"
        : require === "outsideAllowlist"
          ? "@mention required outside the allowlist"
          : "@mention required";

    const channelSummary =
      selectedChannels.length > 0
        ? `- Channels "${channelTitles}": rooms ${channelRoomIds.join(", ") || "(no room ids)"} from ${senderSummary(channelSenderIds)}; ${mentionSummary(channelRequireMention)}.`
        : "- Channels: disabled (none selected).";

    const entitySummary =
      entityKinds.length > 0
        ? `- Entity rooms (${entityKinds.join(", ")}): ${senderSummary(entitySenderIds)}; ${mentionSummary(entityRequireMention)}.`
        : "- Entity rooms: disabled (no room types selected).";

    await prompter.note(
      [
        `Inbound policy (Jaguar chat):`,
        `- Direct messages: enabled for ${senderSummary(allowedUserReferenceIds)}.`,
        channelSummary,
        entitySummary,
      ].join("\n"),
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
          inbound: {
            version: 1,
            direct: {
              enabled: true,
              allowedSenderReferenceIds: allowedUserReferenceIds,
              requireMention: "never",
            },
            channels: {
              enabled: selectedChannels.length > 0,
              allowedRoomIds: channelRoomIds,
              allowedChannelViewIds: channelViewIds,
              ...(channelSenderIds ? { allowedSenderReferenceIds: channelSenderIds } : {}),
              requireMention: channelRequireMention,
            },
            entities: {
              enabled: entityKinds.length > 0,
              allowedKinds: entityKinds,
              ...(entitySenderIds ? { allowedSenderReferenceIds: entitySenderIds } : {}),
              requireMention: entityRequireMention,
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
