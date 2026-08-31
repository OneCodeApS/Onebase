import { NextResponse, type NextRequest } from "next/server";
import {
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from "@/lib/auth-jwt";
import { pool } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  createSession,
  hashPassword,
  upsertIdentity,
  verifyPassword,
} from "@/lib/auth-users";
import { getEmailProviderConfig, isProviderEnabled } from "@/lib/auth-settings";
import { checkPasswordPolicy } from "@/lib/auth-password-policy";
import { checkRateLimit } from "@/lib/rate-limit";
import { corsPreflight, withCors } from "@/lib/cors";

const METHODS = ["GET", "PUT"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve the bearer token to its claims, or hand back the 401 to return.
async function authenticate(
  req: NextRequest,
): Promise<{ claims: AccessClaims } | { res: NextResponse }> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return { res: NextResponse.json({ error: "missing_bearer" }, { status: 401 }) };
  }
  try {
    return { claims: await verifyAccessToken(m[1]) };
  } catch (e) {
    return {
      res: NextResponse.json(
        { error: "invalid_token", detail: (e as Error).message },
        { status: 401 },
      ),
    };
  }
}

function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

async function getHandler(req: NextRequest) {
  const authed = await authenticate(req);
  if ("res" in authed) return authed.res;

  const { rows } = await pool().query<{
    id: string;
    email: string;
    email_verified_at: Date | null;
    created_at: Date;
    last_sign_in_at: Date | null;
    disabled_at: Date | null;
    has_password: boolean;
    raw_user_metadata: Record<string, unknown>;
  }>(
    // has_password is derived, never the hash itself: it lets an app tell
    // "finish your invitation" from "change your password" in one round-trip.
    `SELECT id, email, email_verified_at, created_at,
            last_sign_in_at, disabled_at, raw_user_metadata,
            (encrypted_password IS NOT NULL) AS has_password
       FROM auth.users WHERE id = $1`,
    [authed.claims.sub],
  );
  const user = rows[0];
  if (!user || user.disabled_at) {
    return NextResponse.json({ error: "user_not_found" }, { status: 401 });
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    email_verified_at: user.email_verified_at,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    has_password: user.has_password,
    metadata: user.raw_user_metadata,
  });
}

// Set or change the signed-in user's password.
//
// This is the endpoint the "Secure password change" and "Require current
// password when updating" provider toggles were waiting for — until now they
// were persisted and shown in the admin UI, but nothing enforced them.
//
// Two distinct callers:
//   1. A user with NO password yet — invited by magic link, or arriving via
//      Microsoft OAuth — choosing their first one. There is no current password
//      to prove, so the re-auth toggles cannot apply; demanding one would make
//      the invitation flow impossible.
//   2. A user changing an existing password, who must re-authenticate when
//      either toggle asks for it.
//
// On success every existing session is revoked — a password change should sign
// the user's other devices out — and a fresh one is minted for the caller,
// whose tokens come back in the response. Revoking without re-issuing would
// sign the caller out of the page they are standing on.
async function putHandler(req: NextRequest) {
  if (!(await isProviderEnabled("email"))) {
    return NextResponse.json({ error: "email_provider_disabled" }, { status: 403 });
  }

  const authed = await authenticate(req);
  if ("res" in authed) return authed.res;
  const userId = authed.claims.sub;

  // Keyed on the user, not the IP: the caller is already authenticated, so the
  // account is the meaningful subject — and a whole subcontractor office can
  // sit behind one egress IP.
  const rl = await checkRateLimit("password_update", userId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: { password?: string; current_password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const password = body.password ?? "";

  const [cfg, { rows }] = await Promise.all([
    getEmailProviderConfig(),
    pool().query<{
      id: string;
      email: string;
      encrypted_password: string | null;
      disabled_at: Date | null;
      last_sign_in_at: Date | null;
    }>(
      `SELECT id, email, encrypted_password, disabled_at, last_sign_in_at
         FROM auth.users WHERE id = $1`,
      [userId],
    ),
  ]);
  const user = rows[0];
  if (!user || user.disabled_at) {
    return NextResponse.json({ error: "user_not_found" }, { status: 401 });
  }

  const hasPassword = user.encrypted_password !== null;
  const staleLogin =
    !user.last_sign_in_at ||
    Date.now() - new Date(user.last_sign_in_at).getTime() > DAY_MS;
  const needsCurrentPassword =
    hasPassword &&
    (cfg.require_current_password_on_update ||
      (cfg.secure_password_change && staleLogin));

  if (needsCurrentPassword) {
    const current = body.current_password ?? "";
    if (!current) {
      return NextResponse.json(
        {
          error: "current_password_required",
          detail: "Supply current_password to change an existing password",
        },
        { status: 400 },
      );
    }
    if (!(await verifyPassword(user.encrypted_password as string, current))) {
      await audit({
        actor: user.email,
        actorId: user.id,
        action: "auth.password.update",
        target: user.email,
        success: false,
        ip: clientIp(req),
        metadata: { reason: "invalid_current_password" },
      }).catch(() => {});
      return NextResponse.json(
        { error: "invalid_current_password" },
        { status: 401 },
      );
    }
  }

  const rejection = await checkPasswordPolicy(password, cfg);
  if (rejection) {
    return NextResponse.json(rejection, { status: 400 });
  }

  const encrypted = await hashPassword(password);
  await pool().query(
    `UPDATE auth.users
        SET encrypted_password = $2,
            updated_at         = now()
      WHERE id = $1`,
    [user.id, encrypted],
  );

  // First password on an account that had none: record the email identity too,
  // matching what /auth/v1/signup writes, so the row doesn't stay OAuth-only.
  if (!hasPassword) {
    await upsertIdentity({
      user_id: user.id,
      provider: "email",
      provider_user_id: user.email,
      identity_data: { email: user.email },
    });
  }

  await pool().query(
    `UPDATE auth.sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id],
  );

  const ip = clientIp(req);
  const session = await createSession({
    user_id: user.id,
    user_agent: req.headers.get("user-agent"),
    ip,
  });
  const access = await signAccessToken({ id: user.id, email: user.email });

  await audit({
    actor: user.email,
    actorId: user.id,
    action: "auth.password.update",
    target: user.email,
    success: true,
    ip,
    metadata: { first_time: !hasPassword },
  }).catch(() => {});

  return NextResponse.json({
    user: { id: user.id, email: user.email },
    access_token: access.token,
    token_type: "bearer",
    expires_in: access.expiresIn,
    refresh_token: session.refreshToken,
    refresh_expires_at: session.expiresAt.toISOString(),
  });
}

export const GET = withCors(getHandler, { methods: METHODS });
export const PUT = withCors(putHandler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
