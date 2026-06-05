import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { audit } from "@/lib/audit";
import { authRedirectBase } from "@/lib/auth-oauth-microsoft";
import { createUser, findUserByEmail } from "@/lib/auth-users";
import {
  getAuthSettings,
  getMagicLinkProviderConfig,
  isProviderEnabled,
} from "@/lib/auth-settings";
import { corsPreflight, validateRedirectTarget, withCors } from "@/lib/cors";
import { sendMagicLinkEmail } from "@/lib/email";

const METHODS = ["POST"] as const;

// Requests a single-use sign-in link. The response is 200 {} whether or not
// the email belongs to a user (and whether or not the send succeeded), so the
// endpoint can't be used to probe which accounts exist. The only non-200s are
// about the caller's own input/config: provider disabled, bad JSON, an
// unallowlisted redirect_to, or a per-IP flood (which is source-based and
// reveals nothing about any account).

// Per-IP sliding-window flood brake. In-memory is fine while the dashboard is
// a single container; the durable per-user cap below is the real limit.
// Stored on globalThis so dev-mode module reloads don't reset it.
const IP_LIMIT = 10;
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAP_MAX = 10_000;

const g = globalThis as unknown as { __magiclinkIpHits?: Map<string, number[]> };
function ipLimited(ip: string): { limited: boolean; retryAfter: number } {
  const map = (g.__magiclinkIpHits ??= new Map<string, number[]>());
  const now = Date.now();
  const hits = (map.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) {
    map.set(ip, hits);
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((hits[0] + IP_WINDOW_MS - now) / 1000)),
    };
  }
  hits.push(now);
  map.set(ip, hits);
  // Bound memory: evict the oldest entry once the map grows past the cap.
  if (map.size > IP_MAP_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return { limited: false, retryAfter: 0 };
}

async function handler(req: NextRequest) {
  if (!(await isProviderEnabled("magiclink"))) {
    return NextResponse.json(
      { error: "magiclink_provider_disabled" },
      { status: 403 },
    );
  }

  let body: { email?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const flood = ipLimited(ip ?? "unknown");
  if (flood.limited) {
    return NextResponse.json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": String(flood.retryAfter) } },
    );
  }

  const redirectTo = await validateRedirectTarget(body.redirect_to ?? "");
  if (!redirectTo) {
    return NextResponse.json({ error: "invalid_redirect" }, { status: 400 });
  }

  const cfg = await getMagicLinkProviderConfig();

  // From here on, every path ends in 200 {} — see the header comment.
  let user = await findUserByEmail(email);
  if (!user) {
    const settings = await getAuthSettings();
    if (settings.allow_signups) {
      user = await createUser({ email, encrypted_password: null });
    }
  }

  if (user && !user.disabled_at) {
    // Durable per-user cap (rolling hour). Exceeding it silently skips the
    // send: a capped account and a non-existent one answer identically.
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM auth.magic_link_tokens
        WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [user.id],
    );
    if (rows[0].n < cfg.max_per_hour) {
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + cfg.link_expiration_seconds * 1000);
      await pool().query(
        `INSERT INTO auth.magic_link_tokens
           (user_id, token_hash, redirect_to, expires_at, request_ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, tokenHash, redirectTo, expiresAt, ip],
      );

      // Opportunistic cleanup — no cron needed at this volume.
      await pool().query(
        `DELETE FROM auth.magic_link_tokens
          WHERE expires_at < now() - interval '1 day'`,
      );

      try {
        const base = authRedirectBase();
        if (!base) throw new Error("API_PUBLIC_URL / AUTH_REDIRECT_BASE_URL not set");
        await sendMagicLinkEmail({
          to: user.email,
          link: `${base}/auth/v1/magiclink/verify?token=${token}`,
          expiresMinutes: Math.max(1, Math.round(cfg.link_expiration_seconds / 60)),
        });
      } catch (e) {
        // Still 200 — a send failure must not become an account oracle. The
        // audit chain is the operator's durable signal; no token and no raw
        // email in the metadata.
        console.error("magiclink: send failed", e);
        await audit({
          actor: "system",
          action: "auth.magiclink.send_failed",
          success: false,
          ip,
          metadata: { email_domain: email.split("@")[1] ?? "" },
        }).catch(() => {});
      }
    }
  }

  return NextResponse.json({}, { status: 200 });
}

export const POST = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
