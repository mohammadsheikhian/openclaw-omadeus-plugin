import { omadeusRequest } from "../utils/http.util.js";
import type {
  CasAuthorizationCodeResponse,
  OmadeusOpenClawStatus,
  OmadeusOrganization,
  OmadeusSessionTokenResponse,
} from "../types.js";

const CAS_APPLICATION_ID = 1;
const CAS_SCOPES = "title,email,avatar,firstName,lastName,birth,phone,countryCode";

/**
 * These calls run before there is a credential to authenticate with, so they go
 * through `omadeusRequest` directly rather than through the Jaguar or Dolphin
 * helpers — but they raise the same `OmadeusHttpError` as everything else.
 */
export async function createCasToken(params: {
  casUrl: string;
  email: string;
  password: string;
}): Promise<{ token: string; refreshCookie: string }> {
  const { casUrl, email, password } = params;

  // The refresh cookie is a response header, which the decoded body cannot
  // carry, so this one call reads the raw response itself.
  const url = `${casUrl}/apiv1/tokens`;
  const res = await fetch(url, {
    method: "CREATE",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ email, password }),
  }).catch((err: unknown) => {
    throw new Error(
      `CAS token request (CREATE ${url}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS token request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { token: string };

  return { token: body.token, refreshCookie: res.headers.get("set-cookie") ?? "" };
}

/**
 * `refreshCookie` comes from the `createCasToken` response. It is passed as an
 * argument rather than held in process state: CAS issues it and this call
 * consumes it, and the two run back to back inside `authenticate`.
 */
export async function createAuthorizationCode(params: {
  casUrl: string;
  token: string;
  email: string;
  refreshCookie?: string;
  redirectUri?: string;
}): Promise<string> {
  const { casUrl, token, email, refreshCookie, redirectUri } = params;
  const qs = new URLSearchParams({
    applicationId: String(CAS_APPLICATION_ID),
    scopes: CAS_SCOPES,
    state: email,
    redirectUri: redirectUri ?? "",
  });
  if (redirectUri) qs.set("redirectUri", redirectUri);

  const body = await omadeusRequest<CasAuthorizationCodeResponse>(
    `${casUrl}/apiv1/authorizationcodes?${qs}`,
    {
      label: "CAS authorization code request",
      method: "CREATE",
      body: "",
      authorization: `Bearer ${token}`,
      ...(refreshCookie ? { headers: { Cookie: refreshCookie } } : {}),
    },
  );

  const code = body?.authorizationCode ?? body?.code;
  if (!code) {
    throw new Error("CAS authorization code response missing code");
  }
  return code;
}

export async function obtainSessionToken(params: {
  omadeusUrl: string;
  authorizationCode: string;
  organizationId: number;
}): Promise<string> {
  const { omadeusUrl, authorizationCode, organizationId } = params;
  const body = await omadeusRequest<OmadeusSessionTokenResponse>(
    `${omadeusUrl}/dolphin/apiv1/oauth2/tokens`,
    {
      label: "Omadeus session token request",
      method: "OBTAIN",
      body: { authorizationCode, organizationId },
    },
  );
  if (!body?.token) {
    throw new Error("Omadeus session token response missing token");
  }
  return body.token;
}

export async function listOrganizations(params: {
  omadeusUrl: string;
  email: string;
}): Promise<OmadeusOrganization[]> {
  const { omadeusUrl, email } = params;
  return await omadeusRequest<OmadeusOrganization[]>(
    `${omadeusUrl}/dolphin/apiv1/organizations`,
    {
      label: "Omadeus list organizations",
      method: "LIST",
      body: { email },
    },
  );
}

/**
 * Report the member's OpenClaw status to Omadeus.
 *
 * Jaguar routes the member's OpenClaw DM on this value: while it is anything
 * other than `connected` it will not honour `asOpenclaw` on send/see, so the
 * gateway cannot answer until this has been set. `connected` is reported from
 * the websocket `open` handler rather than from setup completion — a finished
 * wizard only means credentials exist, not that the gateway reached Jaguar.
 */
export async function configureOpenClawBot(params: {
  omadeusUrl: string;
  /** Full Authorization header value (`Bearer <jwt>` or `ApiToken <key>`). */
  authorization: string;
  openclawStatus: OmadeusOpenClawStatus;
}): Promise<void> {
  const { omadeusUrl, authorization, openclawStatus } = params;
  await omadeusRequest(`${omadeusUrl}/dolphin/apiv1/settings/bots/openclaw`, {
    label: "Omadeus configure OpenClaw bot",
    method: "POST",
    authorization,
    body: { openclawStatus },
  });
}
