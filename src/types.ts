// ---------------------------------------------------------------------------
// Omadeus config shape (stored under channels.omadeus in OpenClaw config)
// ---------------------------------------------------------------------------

export type OmadeusChannelConfig = {
  enabled?: boolean;
  /** Omadeus CAS authentication base URL. Defaults to production. */
  casUrl?: string;
  /** Main Omadeus gateway base URL for Dolphin and Jaguar traffic. Defaults to production. */
  omadeusUrl?: string;
  /**
   * Omadeus API key, sent as `Authorization: ApiToken <key>`. Set by the hosted
   * provisioner. When present it is the whole credential — no CAS login, no
   * refresh — and `email`/`password`/`organizationId` are ignored.
   */
  apiKey?: string;
  email?: string;
  password?: string;
  organizationId?: number;
  /**
   * Reference id of the OpenClaw Omadeus member.
   *
   * Load-bearing twice over: it identifies which member of the served DM is the
   * bot, and every message authored by that member is one of our own replies
   * echoing back. Without it the channel cannot tell its own voice from the
   * operator's.
   */
  openClawMemberId?: number;
};

/** The two ways to authenticate, plus "not configured at all". */
export type OmadeusCredentialSource = "apikey" | "password" | "none";

export type ResolvedOmadeusAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: OmadeusChannelConfig;
  casUrl: string;
  omadeusUrl: string;
  email: string;
  password: string;
  organizationId: number;
  apiKey?: string;
  openClawMemberId?: number;
  credentialSource: OmadeusCredentialSource;
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
 * modes that matter (crash, OOM-kill, deleted deployment) cannot report
 * anything, so it is left to a server-side liveness check.
 */
export type OmadeusOpenClawStatus = "disconnected" | "connecting" | "connected";

// ---------------------------------------------------------------------------
// JWT decoded payload (only fields we need)
// ---------------------------------------------------------------------------

export type OmadeusJwtPayload = {
  id: number;
  email: string;
  referenceId: number;
  sessionId: string;
  organizationId: number;
  exp: number;
};

// ---------------------------------------------------------------------------
// Jaguar socket message
// ---------------------------------------------------------------------------

/**
 * A Jaguar chat message frame. Jaguar sends more fields than these (reactions,
 * attachments, threads); only the ones this channel reads are declared, so the
 * type states what we actually depend on.
 */
export type OmadeusMessage = {
  id: number;
  type: "message";
  roomId: number;
  senderReferenceId: number;
  body: string;
  createdAtTimestamp: number;
  removedAt: string | null;
};

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
  timestamp: number;
};
