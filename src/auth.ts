import { createAuthorizationCode, createCasToken, obtainSessionToken } from "./api/auth.api.js";
import type { OmadeusJwtPayload } from "./types.js";
import { decodeJwtPayload } from "./utils/jwt.util.js";

export async function authenticate(params: {
  casUrl: string;
  omadeusUrl: string;
  email: string;
  password: string;
  organizationId: number;
}): Promise<{ dolphinToken: string; payload: OmadeusJwtPayload }> {
  const { casUrl, omadeusUrl, email, password, organizationId } = params;
  const { token, refreshCookie } = await createCasToken({ casUrl, email, password });

  // The CAS refresh cookie is handed straight from the token response to the
  // authorization-code call. Nothing else needs it, so it never outlives this
  // function.
  const authorizationCode = await createAuthorizationCode({
    casUrl,
    token,
    email,
    refreshCookie,
    redirectUri: omadeusUrl,
  });

  const dolphinToken = await obtainSessionToken({
    omadeusUrl,
    authorizationCode,
    organizationId,
  });
  const payload = decodeJwtPayload(dolphinToken);

  return { dolphinToken, payload };
}
