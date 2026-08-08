import { randomUUID } from "node:crypto";
import type { OmadeusTokenManager } from "../token.js";

export type OmadeusApiOptions = {
  omadeusUrl: string;
  tokenManager: OmadeusTokenManager;
};

/**
 * An HTTP error that carries its status, so callers can tell a transient
 * failure (5xx, which is worth retrying) from a permanent one (401/404, which
 * means the deployment is wrong and should fail loudly).
 */
export class OmadeusHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OmadeusHttpError";
  }
}

export function authHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    "Content-Type": "application/json",
  };
}

export async function apiFetch(
  opts: OmadeusApiOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!opts.tokenManager.getToken()) throw new Error("Omadeus: not authenticated");
  const authorization = opts.tokenManager.authorizationHeader();
  const url = `${opts.omadeusUrl}${path}`;
  try {
    return await fetch(url, {
      ...init,
      headers: { ...authHeaders(authorization), ...(init?.headers as Record<string, string>) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Omadeus API request to ${url} failed: ${message}`);
  }
}

function withApiPrefix(prefix: string, path: string): string {
  if (!path) return prefix;
  if (path.startsWith("/")) return `${prefix}${path}`;
  return `${prefix}/${path}`;
}

const JAGUAR_PREFIX = "/jaguar/apiv1";
const DOLPHIN_PREFIX = "/dolphin/apiv1";

export async function jaguarFetch(
  opts: OmadeusApiOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return apiFetch(opts, withApiPrefix(JAGUAR_PREFIX, path), init);
}

export async function dolphinFetch(
  opts: OmadeusApiOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return apiFetch(opts, withApiPrefix(DOLPHIN_PREFIX, path), init);
}

export function generateTemporaryId(): string {
  return `_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}
