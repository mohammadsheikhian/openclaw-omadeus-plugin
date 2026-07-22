import { getCasSession, setCasSession } from "../store.js";
import type {
  CasAuthorizationCodeResponse,
  OmadeusOrganizationMember,
  OmadeusOrganization,
  OmadeusSessionTokenResponse,
} from "../types.js";

const CAS_APPLICATION_ID = 1;
const CAS_SCOPES = "title,email,avatar,firstName,lastName,birth,phone,countryCode";

function formatFetchError(label: string, url: string, method: string, err: unknown): Error {
  const base = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  const detail = cause && cause !== base ? `${base} (${cause})` : base;
  return new Error(`${label} (${method} ${url}) failed: ${detail}`);
}

async function omadeusFetch(
  label: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const method = init.method ?? "GET";
  try {
    return await fetch(url, init);
  } catch (err) {
    throw formatFetchError(label, url, method, err);
  }
}

export async function createCasToken(params: {
  casUrl: string;
  email: string;
  password: string;
}): Promise<{ token: string; refreshCookie: string }> {
  const { casUrl, email, password } = params;
  const url = `${casUrl}/apiv1/tokens`;
  const jsonBody = JSON.stringify({ email, password });
  const res = await omadeusFetch("CAS token request", url, {
    method: "CREATE",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: jsonBody,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS token request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { token: string };
  const refreshCookie = res.headers.get("set-cookie") ?? "";

  setCasSession({ token: body.token, refreshCookie });

  return { token: body.token, refreshCookie };
}

export async function createAuthorizationCode(params: {
  casUrl: string;
  token: string;
  email: string;
  redirectUri?: string;
}): Promise<string> {
  const { casUrl, token, email, redirectUri } = params;
  const casSession = getCasSession();
  const qs = new URLSearchParams({
    applicationId: String(CAS_APPLICATION_ID),
    scopes: CAS_SCOPES,
    state: email,
    redirectUri: redirectUri ?? "",
  });
  if (redirectUri) qs.set("redirectUri", redirectUri);
  const url = `${casUrl}/apiv1/authorizationcodes?${qs}`;
  const body = "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(casSession?.refreshCookie ? { Cookie: casSession.refreshCookie } : {}),
  };
  const res = await omadeusFetch("CAS authorization code request", url, {
    method: "CREATE",
    body,
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS authorization code request failed (${res.status}): ${text}`);
  }
  const jsonResponse = (await res.json()) as CasAuthorizationCodeResponse;
  const code = jsonResponse.authorizationCode ?? jsonResponse.code;
  if (!code) {
    throw new Error("CAS authorization code response missing code");
  }
  return code;
}

export async function obtainSessionToken(params: {
  maestroUrl: string;
  authorizationCode: string;
  organizationId: number;
}): Promise<string> {
  const { maestroUrl, authorizationCode, organizationId } = params;
  const url = `${maestroUrl}/dolphin/apiv1/oauth2/tokens`;
  const res = await omadeusFetch("Omadeus session token request", url, {
    method: "OBTAIN",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ authorizationCode, organizationId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus session token request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as OmadeusSessionTokenResponse;
  if (!body.token) {
    throw new Error("Omadeus session token response missing token");
  }
  return body.token;
}

export async function listOrganizations(params: {
  maestroUrl: string;
  email: string;
}): Promise<OmadeusOrganization[]> {
  const { maestroUrl, email } = params;
  const url = `${maestroUrl}/dolphin/apiv1/organizations`;
  const res = await omadeusFetch("Omadeus list organizations", url, {
    method: "LIST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list organizations failed (${res.status}): ${text}`);
  }
  return (await res.json()) as OmadeusOrganization[];
}

export async function listOrganizationMembers(params: {
  maestroUrl: string;
  sessionToken: string;
  organizationId: number;
  email?: string;
}): Promise<OmadeusOrganizationMember[]> {
  const { maestroUrl, sessionToken, organizationId, email } = params;
  const search = new URLSearchParams();
  if (email) search.set("email", email);
  const qs = search.toString();
  const url = `${maestroUrl}/dolphin/apiv1/organizations/${organizationId}/members${qs ? `?${qs}` : ""}`;
  const res = await omadeusFetch("Omadeus list organization members", url, {
    method: "LIST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Accept": "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list organization members failed (${res.status}): ${text}`);
  }
  return (await res.json()) as OmadeusOrganizationMember[];
}

export async function configureOpenClawBot(params: {
  maestroUrl: string;
  sessionToken: string;
}): Promise<void> {
  const { maestroUrl, sessionToken } = params;
  const url = `${maestroUrl}/dolphin/apiv1/settings/bots/openclaw`;
  const res = await omadeusFetch("Omadeus configure OpenClaw bot", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify({ isOpenclawConfigured: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus configure OpenClaw bot failed (${res.status}): ${text}`);
  }
}
