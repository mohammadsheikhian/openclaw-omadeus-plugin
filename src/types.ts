import type { OmadeusEnvironment } from "./defaults.js";

// ---------------------------------------------------------------------------
// Omadeus config shape (stored under channels.omadeus in OpenClaw config)
// ---------------------------------------------------------------------------

export type OmadeusInboundMentionPolicy = "never" | "always" | "outsideAllowlist";

export type OmadeusInboundDirectPolicy = {
  enabled: boolean;
  allowedSenderReferenceIds?: number[];
  requireMention?: "never" | "always";
};

export type OmadeusInboundChannelsPolicy = {
  enabled: boolean;
  allowedRoomIds?: number[];
  allowedChannelViewIds?: number[];
  allowedSenderReferenceIds?: number[];
  requireMention?: OmadeusInboundMentionPolicy;
};

/** Jaguar `subscribableKind` values treated as entity chat (not DM, not channel). */
export type OmadeusInboundEntityKind =
  | "task"
  | "nugget"
  | "project"
  | "release"
  | "sprint"
  | "summary"
  | "client"
  | "folder";

/** Jaguar entity chats (`subscribableKind`) — DMs and channel rooms use other values. */
export const OMADEUS_INBOUND_ENTITY_KINDS: readonly OmadeusInboundEntityKind[] = [
  "task",
  "nugget",
  "project",
  "release",
  "sprint",
  "summary",
  "client",
  "folder",
];

export const OMADEUS_INBOUND_ENTITY_KIND_SET: ReadonlySet<string> = new Set(OMADEUS_INBOUND_ENTITY_KINDS);

export type OmadeusInboundEntitiesPolicy = {
  enabled: boolean;
  allowedKinds?: OmadeusInboundEntityKind[];
  allowedRoomIds?: number[];
  allowedSenderReferenceIds?: number[];
  requireMention?: OmadeusInboundMentionPolicy;
};

/** Jaguar chat ingress policy (DMs, channel rooms, entity rooms). */
export type OmadeusInboundPolicy = {
  version?: number;
  direct?: OmadeusInboundDirectPolicy;
  channels?: OmadeusInboundChannelsPolicy;
  entities?: OmadeusInboundEntitiesPolicy;
};

export type OmadeusChannelConfig = {
  enabled?: boolean;
  environment?: OmadeusEnvironment;
  email?: string;
  password?: string;
  organizationId?: number;
  /** Cached Omadeus session JWT obtained during onboarding/startup. */
  sessionToken?: string;
  /** Environment the cached sessionToken was minted under (must match `environment`). */
  sessionTokenEnvironment?: OmadeusEnvironment;
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
  /** "none" if neither config/env credentials nor cached session token exist */
  credentialSource: "config" | "env" | "session" | "none";
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

export type OmadeusOrganizationMember = {
  referenceId: number;
  id: number;
  firstName?: string;
  lastName?: string;
  title?: string;
  email?: string;
  isSystem?: boolean;
};

export type OmadeusChannelView = {
  id: number;
  title: string;
  type?: string;
  privateRoomId?: number | null;
  publicRoomId?: number | null;
  privateRoomTitle?: string | null;
  publicRoomTitle?: string | null;
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
// Dolphin socket events (task/data — assignments, updates, etc.)
// ---------------------------------------------------------------------------

export type DolphinSocketEvent = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Inbound message (normalized for OpenClaw)
// ---------------------------------------------------------------------------

export type OmadeusInboundMessage = {
  /** Jaguar message id (used for reactions, replies, etc.). */
  messageId: number;
  from: string;
  fromReferenceId: number;
  content: string;
  roomId: number;
  roomName: string | null;
  subscribableType: OmadeusSubscribableType;
  subscribableKind: OmadeusSubscribableKind;
  /** When present, used with `inbound.channels.allowedChannelViewIds`. */
  channelViewId?: number;
  isMention: boolean;
  timestamp: number;
};
