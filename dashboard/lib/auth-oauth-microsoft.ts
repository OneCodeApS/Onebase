import { getProvider } from "./auth-settings";

// Microsoft Entra ID OAuth 2.0 / OIDC helpers.
//
// Config sources, in priority order:
//   1. auth.providers.microsoft.config (set via the Auth Providers admin page)
//   2. Env vars: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT
//
// The redirect base is env-only (it's deployment-shape, not provider config).
// It defaults to API_PUBLIC_URL — the host Caddy serves /auth/v1 on — and can
// be overridden with AUTH_REDIRECT_BASE_URL for unusual topologies. The
// callback URL registered with Microsoft must be
//   `${authRedirectBase()}/auth/v1/microsoft/callback`.

const SCOPES = ["openid", "profile", "email", "offline_access"];

// Public base URL that OAuth providers redirect back to, without trailing
// slash. Empty string when neither env var is set.
export function authRedirectBase(): string {
  const base =
    process.env.AUTH_REDIRECT_BASE_URL || process.env.API_PUBLIC_URL || "";
  return base.replace(/\/+$/, "");
}

type MicrosoftConfig = {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
};

async function cfg(): Promise<MicrosoftConfig> {
  const provider = await getProvider("microsoft");
  const dbCfg = (provider?.config ?? {}) as Record<string, unknown>;

  const clientId =
    (dbCfg.client_id as string) || process.env.MICROSOFT_CLIENT_ID || "";
  const clientSecret =
    (dbCfg.client_secret as string) ||
    process.env.MICROSOFT_CLIENT_SECRET ||
    "";
  const tenant =
    (dbCfg.tenant as string) || process.env.MICROSOFT_TENANT || "common";
  const base = authRedirectBase();

  if (!clientId || !clientSecret || !base) {
    throw new Error(
      "Microsoft provider not configured (client_id, client_secret, and API_PUBLIC_URL or AUTH_REDIRECT_BASE_URL required)",
    );
  }
  return {
    clientId,
    clientSecret,
    tenant,
    redirectUri: `${base}/auth/v1/microsoft/callback`,
  };
}

export async function microsoftAuthorizeUrl(state: string): Promise<string> {
  const c = await cfg();
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: c.redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
  });
  return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize?${params}`;
}

export type MicrosoftTokenResponse = {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
};

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokenResponse> {
  const c = await cfg();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: c.redirectUri,
    grant_type: "authorization_code",
    scope: SCOPES.join(" "),
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

export type MicrosoftProfile = {
  oid: string;
  email: string;
  name?: string;
};

function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export function profileFromIdToken(idToken: string): MicrosoftProfile {
  const claims = decodeIdTokenClaims(idToken);
  const oid = (claims.oid ?? claims.sub) as string | undefined;
  const email = (claims.email ?? claims.preferred_username ?? claims.upn) as string | undefined;
  const name = claims.name as string | undefined;
  if (!oid || !email) {
    throw new Error("Microsoft id_token missing required claims (oid/email)");
  }
  return { oid, email, name };
}
