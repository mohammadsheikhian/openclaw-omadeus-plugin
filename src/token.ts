import { authenticate } from "./auth.js";
import type { ResolvedOmadeusAccount } from "./types.js";
import { tokenExpiresInMs } from "./utils/jwt.util.js";

// Re-authenticate 5 minutes before expiry
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Node.js timers use a 32-bit signed integer for delays; clamp below this to avoid overflow warnings.
const MAX_TIMEOUT_MS = 2_147_483_647;
// Never schedule a refresh sooner than this, even for an already-expired token.
const MIN_REFRESH_DELAY_MS = 10_000;
const REFRESH_RETRY_MS = 30_000;

/** Whether the token should be refreshed now (within safety margin). */
export function shouldRefreshToken(token: string): boolean {
  return tokenExpiresInMs(token) < TOKEN_REFRESH_MARGIN_MS;
}

/**
 * A credential, kept fresh.
 *
 * Both reads are async and refresh first when the credential is near expiry, so
 * no caller has to know whether this credential expires at all — that is the
 * whole difference between the two adapters. Nothing else about the credential
 * is observable: which adapter is in play, whether a login is in flight, and
 * when the next refresh lands are all implementation.
 */
export type OmadeusTokenManager = {
  /** Full `Authorization` header value: `Bearer <jwt>` or `ApiToken <key>`. */
  authorization(): Promise<string>;
  /**
   * Value for the WebSocket `token` query parameter. Bearer connections send
   * the raw JWT (Jaguar loads it as-is); API-key connections send the full
   * `ApiToken <key>` form so Jaguar can recognise the scheme.
   */
  wsToken(): Promise<string>;
  /** Release the credential. Idempotent, and safe to call before any read. */
  close(): void;
};

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** A credential that never expires: both reads are constant, close is a no-op. */
function createStaticTokenManager(header: string, wsValue: string): OmadeusTokenManager {
  return {
    authorization: async () => header,
    wsToken: async () => wsValue,
    close: () => {},
  };
}

/**
 * Token manager backed by a static Omadeus API key: nothing to refresh,
 * nothing to decode. The websocket gets the full `ApiToken <key>` form because
 * Jaguar needs the scheme to recognise it.
 */
export function createApiKeyTokenManager(apiKey: string): OmadeusTokenManager {
  return createStaticTokenManager(`ApiToken ${apiKey}`, `ApiToken ${apiKey}`);
}

/**
 * Token manager backed by a session JWT that someone else obtained — the setup
 * wizard, which already has one and only needs a couple of one-off calls.
 */
export function createBearerTokenManager(token: string): OmadeusTokenManager {
  return createStaticTokenManager(`Bearer ${token}`, token);
}

/**
 * Token manager backed by a CAS login. The JWT lives only in memory: a cached
 * one written back to config saves a single login per restart and is usually
 * expired anyway, so the gateway always starts from a fresh CAS login.
 */
function createPasswordTokenManager(params: {
  casUrl: string;
  omadeusUrl: string;
  email: string;
  password: string;
  organizationId: number;
  onError?: (error: Error) => void;
}): OmadeusTokenManager & { ensureFresh(): Promise<void>; startAutoRefresh(): void } {
  const { casUrl, omadeusUrl, email, password, organizationId, onError } = params;

  let currentToken = "";
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // One login at a time. Every read can now trigger a refresh, so without this
  // a burst of concurrent requests against a stale token would each open their
  // own CAS session.
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const login = async (): Promise<void> => {
    const { dolphinToken } = await authenticate({
      casUrl,
      omadeusUrl,
      email,
      password,
      organizationId,
    });
    currentToken = dolphinToken;
  };

  const ensureFresh = async (): Promise<void> => {
    if (currentToken && !shouldRefreshToken(currentToken)) return;
    if (!inFlight) {
      inFlight = login().finally(() => {
        inFlight = null;
      });
    }
    try {
      await inFlight;
    } catch (err) {
      const error = toError(err);
      onError?.(error);
      throw error;
    }
  };

  const scheduleNextRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (closed || !currentToken) return;

    const desiredDelayMs = tokenExpiresInMs(currentToken) - TOKEN_REFRESH_MARGIN_MS;
    const refreshInMs = Math.min(Math.max(desiredDelayMs, MIN_REFRESH_DELAY_MS), MAX_TIMEOUT_MS);

    refreshTimer = setTimeout(() => {
      void ensureFresh().then(
        () => scheduleNextRefresh(),
        () => {
          if (closed) return;
          refreshTimer = setTimeout(() => scheduleNextRefresh(), REFRESH_RETRY_MS);
        },
      );
    }, refreshInMs);
  };

  return {
    ensureFresh,
    startAutoRefresh: scheduleNextRefresh,
    async authorization() {
      await ensureFresh();
      return `Bearer ${currentToken}`;
    },
    async wsToken() {
      await ensureFresh();
      return currentToken;
    },
    close() {
      closed = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },
  };
}

/**
 * Open the credential an account implies, ready to use.
 *
 * This is the only entry point a caller needs: it picks the adapter the
 * credential source dictates, performs the initial login when there is one to
 * perform, and starts auto-refresh. It resolves only once the credential works,
 * so a caller that gets a token manager back has already proved the account can
 * authenticate — and `close()` is the whole of the cleanup obligation, on every
 * path, including the ones that fail later.
 */
export async function openOmadeusToken(
  account: Pick<
    ResolvedOmadeusAccount,
    "apiKey" | "casUrl" | "omadeusUrl" | "email" | "password" | "organizationId"
  >,
  opts: { onError?: (error: Error) => void } = {},
): Promise<OmadeusTokenManager> {
  if (account.apiKey) return createApiKeyTokenManager(account.apiKey);

  const manager = createPasswordTokenManager({
    casUrl: account.casUrl,
    omadeusUrl: account.omadeusUrl,
    email: account.email,
    password: account.password,
    organizationId: account.organizationId,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  // Log in before returning: an account that cannot authenticate must fail
  // where it is started, not on its first message.
  await manager.ensureFresh();
  manager.startAutoRefresh();
  return manager;
}
