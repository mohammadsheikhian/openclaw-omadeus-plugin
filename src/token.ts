import { authenticate } from "./auth.js";
import type { OmadeusJwtPayload } from "./types.js";
import { decodeJwtPayload, tokenExpiresInMs } from "./utils/jwt.util.js";

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

/**
 * Token manager backed by a static Omadeus API key: nothing to refresh,
 * nothing to decode. `getPayload` is unavailable — identity is resolved via
 * the API-key verification endpoint instead of a JWT payload.
 */
export function createApiKeyTokenManager(apiKey: string): OmadeusTokenManager {
  const header = `ApiToken ${apiKey}`;
  return {
    getToken: () => apiKey,
    getPayload: () => {
      throw new Error("Omadeus: API-key auth carries no JWT payload");
    },
    refresh: async () => {},
    startAutoRefresh: () => {},
    stopAutoRefresh: () => {},
    needsRefresh: () => false,
    authorizationHeader: () => header,
    wsToken: () => header,
  };
}

export function createTokenManager(params: {
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
  initialToken?: string;
  onRefresh?: (token: string) => void;
  onError?: (error: Error) => void;
}): OmadeusTokenManager {
  const { casUrl, maestroUrl, email, password, organizationId, initialToken, onRefresh, onError } =
    params;

  let currentToken = "";
  let currentPayload: OmadeusJwtPayload | null = null;
  if (initialToken) {
    try {
      const payload = decodeJwtPayload(initialToken);
      currentToken = initialToken;
      currentPayload = payload;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      // Ignore malformed seed token and fall back to authenticate().
    }
  }
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    if (currentToken && !shouldRefreshToken(currentToken)) {
      return;
    }
    const { dolphinToken, payload } = await authenticate({
      casUrl,
      maestroUrl,
      email,
      password,
      organizationId,
    });
    currentToken = dolphinToken;
    currentPayload = payload;
    onRefresh?.(dolphinToken);
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
