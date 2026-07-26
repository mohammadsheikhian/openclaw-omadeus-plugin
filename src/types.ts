import type { OmadeusEnvironment } from "./defaults.js";

// ---------------------------------------------------------------------------
// Omadeus config shape (stored under channels.omadeus in OpenClaw config)
// ---------------------------------------------------------------------------

export type OmadeusInboundMentionPolicy = "never" | "always" | "outsideAllowlist";

export type OmadeusInboundDirectPolicy = {
  enabled: boolean;
  requireMention?: "never" | "always";
};


/** Jaguar chat ingress policy. Only the OpenClaw direct room is served. */
export type OmadeusInboundPolicy = {
  version?: number;
  direct?: OmadeusInboundDirectPolicy;
};

export type OmadeusChannelConfig = {
  enabled?: boolean;
  environment?: OmadeusEnvironment;
  /**
   * Omadeus API key (sent as `Authorization: ApiToken <key>`). When set, the
   * plugin authenticates with it directly — no CAS login, no session token
   * refresh — and `email`/`password` are not needed.
   */
  apiKey?: string;
  email?: string;
  password?: string;
  organizationId?: number;
  /** Cached Omadeus session JWT obtained during onboarding/startup. */
  sessionToken?: string;
  /** Environment the cached sessionToken was minted under (must match `environment`). */
  sessionTokenEnvironment?: OmadeusEnvironment;
  /**
   * ID of the OpenClaw Omadeus member, resolved during setup.
   *
   * OpenClaw is a distinct Omadeus user, but the gateway authenticates as the operator
   * and posts as OpenClaw via `asOpenclaw`. The two identities are therefore only
   * distinguishable by this id, which is what lets the inbound policy tell the operator's
   * own OpenClaw DM apart from a DM with a real person.
   */
  openClawMemberId?: number;
  /** @deprecated Legacy name for `openClawMemberId`; read-only fallback for old configs. */
  openClawReferenceId?: number;
  /** Jaguar chat ingress allowlists and mention rules. */
  inbound?: OmadeusInboundPolicy;
};

export type ResolvedOmadeusAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: OmadeusChannelConfig;
  environment: OmadeusEnvironment;
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
  sessionToken?: string;
  /** Omadeus API key; when set it replaces the CAS email/password flow. */
  apiKey?: string;
  /** "none" if no api key, config/env credentials or cached session token exist */
  credentialSource: "apikey" | "config" | "env" | "session" | "none";
};

// ---------------------------------------------------------------------------
// CAS auth types
// ---------------------------------------------------------------------------

export type CasTokenResponse = {
  token?: string;
};

export type CasAuthorizationCodeResponse = {
  authorizationCode?: string;
  code?: string;
};

export type OmadeusSessionTokenResponse = {
  token: string;
};

export type OmadeusOrganization = {
  id: number;
  title: string;
  plan: string;
  membersCount: number;
  createdAt: string;
};

/**
 * Member-level OpenClaw connection state, mirrored in Dolphin and owned by
 * Jaguar. Jaguar only honours `asOpenclaw` send/see while this is `connected`.
 *
 * The plugin reports `connecting` when setup completes and `connected` when its
 * websocket opens. `disconnected` is not written by the plugin: the failure
 * modes that matter (crash, OOM-kill, deleted deployment, uninstalled plugin)
 * cannot report anything, so it is left to a server-side liveness check.
 */
export type OmadeusOpenClawStatus = "disconnected" | "connecting" | "connected";

export type OmadeusOrganizationMember = {
  referenceId: number;
  id: number;
  firstName?: string;
  lastName?: string;
  title?: string;
  email?: string;
  isSystem?: boolean;
};


// ---------------------------------------------------------------------------
// JWT decoded payload (only fields we need)
// ---------------------------------------------------------------------------

export type OmadeusJwtPayload = {
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  referenceId: number;
  sessionId: string;
  organizationId: number;
  roles: string[];
  exp: number;
};

// ---------------------------------------------------------------------------
// Jaguar socket message (chat — DMs, nugget rooms, task rooms, etc.)
// ---------------------------------------------------------------------------

/**
 * Omadeus subscribable **type** on Jaguar chat payloads (room context).
 *
 * - **direct** — DM from a user.
 * - **channel** — message in a channel room.
 * - **nugget** … **folder** — entity-associated chat (tasks, work items, hierarchy).
 */
export type OmadeusSubscribableType =
  | "direct"
  | "channel"
  | "nugget"
  | "project"
  | "sprint"
  | "release"
  | "summary"
  | "client"
  | "folder"
  | (string & {});

/**
 * Omadeus subscribable **kind** on Jaguar chat payloads (same coarse buckets as `OmadeusSubscribableType`;
 * routing uses `subscribableKind` in the plugin).
 *
 * - **direct** — DM from a user.
 * - **channel** — message in a channel room.
 * - **task**, **nugget**, **project**, **release**, **sprint**, **summary**, **client**, **folder** — entity chat.
 */
export type OmadeusSubscribableKind =
  | "task"
  | "direct"
  | "channel"
  | "nugget"
  | "project"
  | "sprint"
  | "release"
  | "summary"
  | "client"
  | "folder"
  | (string & {});

export type OmadeusMessage = {
  id: number;
  temporaryId?: string;
  type: "message";
  roomId: number;
  senderId: number;
  senderReferenceId: number;
  organizationId: number;
  body: string;
  roomName: string | null;
  subscribableType: OmadeusSubscribableType;
  subscribableKind: OmadeusSubscribableKind;
  createdAtTimestamp: number;
  mimetype: string;
  filename: string | null;
  fileLength: number | null;
  duration: number | null;
  details: string | null;
  replyRootId: number | null;
  attachmentUrl: string | null;
  speechFileUrl: string | null;
  reactions: Record<string, unknown>;
  threadRoomId: number | null;
  replyTo: unknown | null;
  createdAt: string;
  removedAt: string | null;
  metadata: unknown | null;
  isMute: boolean;
  isSeen: boolean;
};

/** Parsed details.rawMessage field for @mention detection. */
export type OmadeusMessageDetails = {
  rawMessage?: string;
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Inbound message (normalized for OpenClaw)
// ---------------------------------------------------------------------------

export type OmadeusInboundMessage = {
  /** Jaguar message id. */
  messageId: number;
  from: string;
  fromReferenceId: number;
  content: string;
  roomId: number;
  roomName: string | null;
  subscribableType: OmadeusSubscribableType;
  subscribableKind: OmadeusSubscribableKind;
  isMention: boolean;
  timestamp: number;
};
