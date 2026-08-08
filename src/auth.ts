import { createAuthorizationCode, createCasToken, obtainSessionToken } from "./api/auth.api.js";
import { clearCasSession } from "./store.js";
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
  const { token } = await createCasToken({ casUrl, email, password });

  const authorizationCode = await createAuthorizationCode({
    casUrl,
    token,
    email,
    redirectUri: omadeusUrl,
  });
  // CAS session no longer needed after obtaining the authorization code
  clearCasSession();

  const dolphinToken = await obtainSessionToken({
    omadeusUrl,
    authorizationCode,
    organizationId,
  });
  const payload = decodeJwtPayload(dolphinToken);

  return { dolphinToken, payload };
}
