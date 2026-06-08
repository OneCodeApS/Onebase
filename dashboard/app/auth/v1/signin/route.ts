import { NextResponse, type NextRequest } from "next/server";
import { signAccessToken } from "@/lib/auth-jwt";
import {
  createSession,
  findUserByEmail,
  touchLastSignIn,
  verifyPasswordConstantTime,
} from "@/lib/auth-users";
import { isProviderEnabled } from "@/lib/auth-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { corsPreflight, withCors } from "@/lib/cors";

const METHODS = ["POST"] as const;

async function handler(req: NextRequest) {
  if (!(await isProviderEnabled("email"))) {
    return NextResponse.json({ error: "email_provider_disabled" }, { status: 403 });
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const rl = await checkRateLimit("signin", ip ?? "unknown");
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const user = await findUserByEmail(email);
  // Always run an argon2 verify (against a decoy when the account is missing or
  // passwordless) so response timing doesn't reveal whether the email exists.
  const stored = user && !user.disabled_at ? user.encrypted_password : null;
  const passwordOk = await verifyPasswordConstantTime(stored, password);

  if (!user || user.disabled_at || !user.encrypted_password || !passwordOk) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ua = req.headers.get("user-agent");
  const session = await createSession({ user_id: user.id, user_agent: ua, ip });
  await touchLastSignIn(user.id);
  const access = await signAccessToken({ id: user.id, email: user.email });

  return NextResponse.json({
    user: { id: user.id, email: user.email },
    access_token: access.token,
    token_type: "bearer",
    expires_in: access.expiresIn,
    refresh_token: session.refreshToken,
    refresh_expires_at: session.expiresAt.toISOString(),
  });
}

export const POST = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
