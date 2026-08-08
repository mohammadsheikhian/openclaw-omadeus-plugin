import { authenticate } from "./auth.js";
import type { OmadeusJwtPayload } from "./types.js";
import { tokenExpiresInMs } from "./utils/jwt.util.js";

// Re-authenticate 5 minutes before expiry
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Node.js timers use a 32-bit signed integer for delays; clamp below this to avoid overflow warnings.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Whether the token should be refreshed now (within safety margin). */
export function shouldRefreshToken(token: string): boolean {
  return tokenExpiresInMs(token) < TOKEN_REFRESH_MARGIN_MS;
}

export type OmadeusTokenManager = {
  getToken(): string;
  getPayload(): OmadeusJwtPayload;
  refresh(): Promise<void>;
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
  needsRefresh(): boolean;
  /** Full `Authorization` header value: `Bearer <jwt>` or `ApiToken <key>`. */
  authorizationHeader(): string;
  /**
   * Value for the WebSocket `token` query parameter. Bearer connections send
   * the raw JWT (Jaguar loads it as-is); API-key connections send the full
   * `ApiToken <key>` form so Jaguar can recognise the scheme.
   */
  wsToken(): string;
};

function createStaticTokenManager(token: string, header: string): OmadeusTokenManager {
  return {
    getToken: () => token,
    getPayload: () => {
      throw new Error("Omadeus: this credential carries no JWT payload");
    },
    refresh: async () => {},
    startAutoRefresh: () => {},
    stopAutoRefresh: () => {},
    needsRefresh: () => false,
    authorizationHeader: () => header,
    wsToken: () => header,
  };
}

/**
 * Token manager backed by a static Omadeus API key: nothing to refresh,
 * nothing to decode. The websocket gets the full `ApiToken <key>` form because
 * Jaguar needs the scheme to recognise it.
 */
export function createApiKeyTokenManager(apiKey: string): OmadeusTokenManager {
  return createStaticTokenManager(apiKey, `ApiToken ${apiKey}`);
}

/**
 * Token manager backed by a session JWT that someone else obtained — the setup
 * wizard, which already has one and only needs a couple of one-off calls.
 */
export function createBearerTokenManager(token: string): OmadeusTokenManager {
  return createStaticTokenManager(token, `Bearer ${token}`);
}

export function createTokenManager(params: {
  casUrl: string;
  omadeusUrl: string;
  email: string;
  password: string;
  organizationId: number;
  onError?: (error: Error) => void;
}): OmadeusTokenManager {
  const { casUrl, omadeusUrl, email, password, organizationId, onError } = params;

  // Tokens live only for the life of the process. A cached one written back to
  // config saves a single login per restart and is usually expired anyway, so
  // the gateway always starts from a fresh CAS login.
  let currentToken = "";
  let currentPayload: OmadeusJwtPayload | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    if (currentToken && !shouldRefreshToken(currentToken)) {
      return;
    }
    const { dolphinToken, payload } = await authenticate({
      casUrl,
      omadeusUrl,
      email,
      password,
      organizationId,
    });
    currentToken = dolphinToken;
    currentPayload = payload;
  };

  const scheduleNextRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (!currentToken) return;

    const expiresInMs = tokenExpiresInMs(currentToken);
    const desiredDelayMs = expiresInMs - TOKEN_REFRESH_MARGIN_MS;
    const refreshInMs = Math.min(Math.max(desiredDelayMs, 10_000), MAX_TIMEOUT_MS);

    refreshTimer = setTimeout(async () => {
      try {
        await refresh();
        scheduleNextRefresh();
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        // Retry in 30s on failure
        refreshTimer = setTimeout(() => void scheduleNextRefresh(), 30_000);
      }
    }, refreshInMs);
  };

  return {
    getToken() {
      return currentToken;
    },
    authorizationHeader() {
      return `Bearer ${currentToken}`;
    },
    wsToken() {
      return currentToken;
    },
    getPayload() {
      if (!currentPayload) throw new Error("Omadeus: not authenticated");
      return currentPayload;
    },
    async refresh() {
      try {
        await refresh();
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    startAutoRefresh() {
      scheduleNextRefresh();
    },
    stopAutoRefresh() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },
    needsRefresh() {
      return !currentToken || shouldRefreshToken(currentToken);
    },
  };
}
