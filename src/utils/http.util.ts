import { randomUUID } from "node:crypto";
import type { OmadeusTokenManager } from "../token.js";

export type OmadeusApiOptions = {
  omadeusUrl: string;
  tokenManager: OmadeusTokenManager;
};

/** The request never reached the server: DNS, connection refused, reset, timeout. */
export const NETWORK_ERROR_STATUS = 0;
/** The server answered, but not with something we can read. */
export const MALFORMED_RESPONSE_STATUS = 502;

/**
 * The only error every Omadeus request raises.
 *
 * One type for every failure — HTTP status, network fault, unreadable body — is
 * what makes `isTransient` answerable at all. When some calls threw this and
 * others threw a plain `Error`, retry policy had to guess from `err.name`, and
 * guessed wrong for anything raised alongside a request rather than by one.
 */
export class OmadeusHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OmadeusHttpError";
  }

  /**
   * Transient means "the server or the network was briefly unavailable". A pod
   * can start before its gateway is reachable, so those are worth retrying.
   * Anything else — 401 (bad credentials), 404 (no such DM) — is a deployment
   * fault that retrying will never fix.
   */
  get isTransient(): boolean {
    return this.status === NETWORK_ERROR_STATUS || this.status >= 500;
  }
}

/** True only for a failure a retry could plausibly resolve. */
export function isTransientFailure(err: unknown): boolean {
  return err instanceof OmadeusHttpError && err.isTransient;
}

export type OmadeusRequest = {
  /** Human-readable name of the call, used to build the error message. */
  label: string;
  method: string;
  /** Serialized as JSON unless it is already a string. Omitted when undefined. */
  body?: unknown;
  headers?: Record<string, string>;
};

function describeCause(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const code =
    err instanceof Error && typeof (err as Error & { code?: unknown }).code === "string"
      ? String((err as Error & { code?: unknown }).code)
      : undefined;
  const extra = [cause && cause !== base ? cause : undefined, code].filter(Boolean).join(" ");
  return extra ? `${base} (${extra})` : base;
}

/** `undefined` for an empty body, parsed JSON when it parses, raw text otherwise. */
async function decodeBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = (await res.text()).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Perform one request against Omadeus.
 *
 * Callers get the decoded body or an `OmadeusHttpError` — never a `Response`,
 * so no call site can forget to check `res.ok`, and none of them re-implement
 * the read-the-text-and-slice-it error message.
 */
export async function omadeusRequest<T = unknown>(
  url: string,
  init: OmadeusRequest & { authorization?: string },
): Promise<T> {
  const { label, method, body, headers, authorization } = init;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        ...(authorization ? { Authorization: authorization } : {}),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  } catch (err) {
    throw new OmadeusHttpError(
      `${label} (${method} ${url}) failed: ${describeCause(err)}`,
      NETWORK_ERROR_STATUS,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OmadeusHttpError(`${label} failed (${res.status}): ${text.slice(0, 200)}`, res.status);
  }

  return (await decodeBody(res)) as T;
}

const JAGUAR_PREFIX = "/jaguar/apiv1";
const DOLPHIN_PREFIX = "/dolphin/apiv1";

async function apiRequest<T>(
  opts: OmadeusApiOptions,
  prefix: string,
  path: string,
  init: OmadeusRequest,
): Promise<T> {
  // Reading the credential refreshes it when it is near expiry, so a long-lived
  // gateway never sends a token that expired between requests.
  const authorization = await opts.tokenManager.authorization();
  const suffix = !path || path.startsWith("/") ? path : `/${path}`;
  return await omadeusRequest<T>(`${opts.omadeusUrl}${prefix}${suffix}`, { ...init, authorization });
}

/** Authenticated request against Jaguar, the chat backend. */
export async function jaguarRequest<T = unknown>(
  opts: OmadeusApiOptions,
  path: string,
  init: OmadeusRequest,
): Promise<T> {
  return await apiRequest<T>(opts, JAGUAR_PREFIX, path, init);
}

/** Authenticated request against Dolphin, the Omadeus core API. */
export async function dolphinRequest<T = unknown>(
  opts: OmadeusApiOptions,
  path: string,
  init: OmadeusRequest,
): Promise<T> {
  return await apiRequest<T>(opts, DOLPHIN_PREFIX, path, init);
}

export function generateTemporaryId(): string {
  return `_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}
