import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { signAccessToken } from "@/lib/auth-jwt";
import {
  createSession,
  createUser,
  findUserByEmail,
  hashPassword,
  upsertIdentity,
} from "@/lib/auth-users";
import {
  getAuthSettings,
  getEmailProviderConfig,
  isProviderEnabled,
  type PasswordRequirements,
} from "@/lib/auth-settings";
import { corsPreflight, withCors } from "@/lib/cors";
import { checkRateLimit } from "@/lib/rate-limit";

const METHODS = ["POST"] as const;

function meetsRequirements(password: string, req: PasswordRequirements): boolean {
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  switch (req) {
    case "none":
      return true;
    case "lowercase_uppercase":
      return hasLower && hasUpper;
    case "lowercase_uppercase_digits":
      return hasLower && hasUpper && hasDigit;
    case "lowercase_uppercase_digits_symbols":
      return hasLower && hasUpper && hasDigit && hasSymbol;
  }
}

// HaveIBeenPwned k-anonymity: hash with SHA-1, send the first 5 chars to the
// public API, receive ~500 suffixes; check ours against the list. The full
// password never leaves this server.
async function isPwned(password: string): Promise<boolean> {
  try {
    const hash = crypto
      .createHash("sha1")
      .update(password)
      .digest("hex")
      .toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "User-Agent": "onecodebase-auth" },
    });
    if (!res.ok) return false; // fail open on API issues
    const text = await res.text();
    for (const line of text.split("\n")) {
      const [s] = line.split(":");
      if (s.trim().toUpperCase() === suffix) return true;
    }
    return false;
  } catch {
    return false; // fail open on network issues
  }
}

async function handler(req: NextRequest) {
  const [settings, emailEnabled, emailCfg] = await Promise.all([
    getAuthSettings(),
    isProviderEnabled("email"),
    getEmailProviderConfig(),
  ]);
  if (!settings.allow_signups) {
    return NextResponse.json({ error: "signups_disabled" }, { status: 403 });
  }
  if (!emailEnabled) {
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
  const rl = await checkRateLimit("signup", ip ?? "unknown");
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  if (!email.includes("@")) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (password.length < emailCfg.min_password_length) {
    return NextResponse.json(
      {
        error: "password_too_short",
        detail: `Password must be at least ${emailCfg.min_password_length} characters`,
      },
      { status: 400 },
    );
  }
  if (!meetsRequirements(password, emailCfg.password_requirements)) {
    return NextResponse.json(
      {
        error: "password_too_weak",
        detail:
          "Password does not meet the required mix of character classes",
        required: emailCfg.password_requirements,
      },
      { status: 400 },
    );
  }
  if (emailCfg.prevent_leaked_passwords && (await isPwned(password))) {
    return NextResponse.json(
      {
        error: "password_pwned",
        detail:
          "This password has appeared in a known data breach. Pick a different one.",
      },
      { status: 400 },
    );
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const encrypted = await hashPassword(password);
  const user = await createUser({ email, encrypted_password: encrypted });

  await upsertIdentity({
    user_id: user.id,
    provider: "email",
    provider_user_id: user.email,
    identity_data: { email: user.email },
  });

  const ua = req.headers.get("user-agent");
  const session = await createSession({ user_id: user.id, user_agent: ua, ip });
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
