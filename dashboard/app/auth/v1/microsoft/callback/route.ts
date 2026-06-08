import { NextResponse, type NextRequest } from "next/server";
import { signAccessToken } from "@/lib/auth-jwt";
import {
  exchangeMicrosoftCode,
  profileFromIdToken,
} from "@/lib/auth-oauth-microsoft";
import {
  createSession,
  createUser,
  findUserByEmail,
  findUserByIdentity,
  touchLastSignIn,
  upsertIdentity,
  type AuthUser,
} from "@/lib/auth-users";
import { isProviderEnabled } from "@/lib/auth-settings";
import { corsPreflight, validateRedirectTarget, withCors } from "@/lib/cors";

const METHODS = ["GET"] as const;

// Handles the redirect back from Microsoft. Validates state against the cookie
// we set in `/start`, exchanges the code for tokens, then either:
//   - finds an existing local user by Microsoft `oid`, OR
//   - finds an existing local user by email and links the Microsoft identity, OR
//   - creates a new local user with the Microsoft email.
// On success, redirects to the original return_to URL with tokens in the
// query string — apps should immediately read those, store them, and replace
// the URL (e.g. via history.replaceState) so tokens don't linger in the bar.
async function handler(req: NextRequest) {
  if (!(await isProviderEnabled("microsoft"))) {
    return NextResponse.json(
      { error: "microsoft_provider_disabled" },
      { status: 403 },
    );
  }
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const errParam = req.nextUrl.searchParams.get("error");

  if (errParam) {
    return NextResponse.json(
      { error: "provider_error", detail: errParam },
      { status: 400 },
    );
  }
  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  const [stateNonce, encodedReturnTo] = state.split(".");
  const cookieNonce = req.cookies.get("auth_ms_nonce")?.value;
  if (!stateNonce || !cookieNonce || stateNonce !== cookieNonce) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  // Decode + validate return_to up front — before minting any tokens — so a
  // tampered or unallowlisted return_to can't lure a victim through /start and
  // collect their freshly-issued tokens from the redirect fragment. Mirrors the
  // magic-link verify path. An empty return_to falls back to a JSON token
  // response below.
  const returnTo = encodedReturnTo
    ? Buffer.from(encodedReturnTo, "base64url").toString("utf8")
    : "";
  const validatedReturnTo = returnTo ? await validateRedirectTarget(returnTo) : "";
  if (returnTo && !validatedReturnTo) {
    return NextResponse.json({ error: "invalid_redirect" }, { status: 400 });
  }

  let tokens;
  try {
    tokens = await exchangeMicrosoftCode(code);
  } catch (e) {
    return NextResponse.json(
      { error: "token_exchange_failed", detail: (e as Error).message },
      { status: 502 },
    );
  }

  let profile;
  try {
    profile = profileFromIdToken(tokens.id_token);
  } catch (e) {
    return NextResponse.json(
      { error: "bad_id_token", detail: (e as Error).message },
      { status: 502 },
    );
  }

  // Resolve user: by existing identity → by email → create new.
  let user: AuthUser | null = await findUserByIdentity("microsoft", profile.oid);
  if (!user) {
    user = await findUserByEmail(profile.email);
    if (!user) {
      user = await createUser({
        email: profile.email,
        encrypted_password: null,
        metadata: { full_name: profile.name ?? null },
      });
    }
  }

  if (user.disabled_at) {
    return NextResponse.json({ error: "account_disabled" }, { status: 403 });
  }

  await upsertIdentity({
    user_id: user.id,
    provider: "microsoft",
    provider_user_id: profile.oid,
    identity_data: {
      email: profile.email,
      name: profile.name,
    },
  });

  const ua = req.headers.get("user-agent");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const session = await createSession({ user_id: user.id, user_agent: ua, ip });
  await touchLastSignIn(user.id);
  const access = await signAccessToken({ id: user.id, email: user.email });

  // If no return_to was provided, just hand back the tokens as JSON. Useful
  // for debugging / API testing.
  if (!returnTo) {
    const res = NextResponse.json({
      user: { id: user.id, email: user.email },
      access_token: access.token,
      token_type: "bearer",
      expires_in: access.expiresIn,
      refresh_token: session.refreshToken,
      refresh_expires_at: session.expiresAt.toISOString(),
    });
    res.cookies.delete("auth_ms_nonce");
    return res;
  }

  // Otherwise redirect back to the requesting app with tokens in the fragment.
  // Using fragment (#) rather than query (?) so tokens never reach the server-
  // side logs of the destination — only the JS in the browser sees them.
  const params = new URLSearchParams({
    access_token: access.token,
    token_type: "bearer",
    expires_in: String(access.expiresIn),
    refresh_token: session.refreshToken,
    refresh_expires_at: session.expiresAt.toISOString(),
  });
  const url = `${validatedReturnTo}#${params.toString()}`;
  const res = NextResponse.redirect(url);
  res.cookies.delete("auth_ms_nonce");
  return res;
}

export const GET = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
