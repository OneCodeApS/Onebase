import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { pool } from "@/lib/db";
import { signAccessToken } from "@/lib/auth-jwt";
import { createSession, touchLastSignIn } from "@/lib/auth-users";
import {
  getMagicLinkProviderConfig,
  isProviderEnabled,
} from "@/lib/auth-settings";
import { validateRedirectTarget } from "@/lib/cors";

// Verifies a magic-link token in two steps:
//
//   GET  — non-consuming validity check + a minimal HTML page whose form
//          auto-submits via JS (with a visible button as no-JS fallback).
//   POST — atomically consumes the token, creates the session, and 303s to
//          the app with tokens in the URL fragment (the exact contract of
//          the Microsoft OAuth callback, so getSessionFromUrl() handles both).
//
// Why two steps: mail security scanners (Microsoft SafeLinks, link previews)
// prefetch GET links — a GET that consumed the token would burn it before the
// human ever clicked. Scanners don't submit forms; the POST is the real gate.
// GET stays side-effect-free, as it should be.
//
// Failures render one neutral HTML page for every mode (missing, expired,
// consumed, disabled account) — no oracle, and never a redirect, since an
// invalid token carries no trusted redirect_to.

const PAGE_STYLE = `
    body { font-family: system-ui, sans-serif; background: #171717; color: #e5e5e5;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    main { max-width: 26rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.125rem; font-weight: 600; }
    p { color: #a3a3a3; font-size: 0.875rem; line-height: 1.5; }
    button { background: #2563eb; color: #fff; border: 0; border-radius: 0.375rem;
             padding: 0.625rem 1.25rem; font-size: 0.875rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    a.cta { display: inline-block; margin-top: 0.5rem; background: #2563eb; color: #fff;
            border-radius: 0.375rem; padding: 0.625rem 1.25rem; font-size: 0.875rem;
            text-decoration: none; }
    a.cta:hover { background: #1d4ed8; }`;

const DEFAULT_ERROR_TITLE = "This sign-in link is invalid or has expired";
const DEFAULT_ERROR_BODY =
  "Sign-in links can only be used once and expire after a short time. " +
  "Go back to the application and request a new one.";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Operator-supplied, but rendered into an href — so only http(s) survives.
// Anything else (javascript:, data:) is dropped and the page dead-ends as
// before rather than shipping a clickable script URL.
function safeHttpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function page(body: string, status: number): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// One neutral page for every failure mode — missing, expired, consumed,
// disabled account — so it stays free of any oracle. What the operator can
// change is the copy and whether it offers a way onward: for a single-use link
// the "already used" case is routine, and dead-ending a user who simply needs
// the sign-in screen turns a normal event into a support call.
async function errorPage(): Promise<NextResponse> {
  const cfg = await getMagicLinkProviderConfig().catch(() => null);
  const title = cfg?.error_title?.trim() || DEFAULT_ERROR_TITLE;
  const bodyText = cfg?.error_body?.trim() || DEFAULT_ERROR_BODY;
  const signInUrl = safeHttpUrl(cfg?.sign_in_url?.trim() ?? "");
  const label = cfg?.sign_in_label?.trim() || "Sign in";

  const cta = signInUrl
    ? `<p><a class="cta" href="${escapeHtml(signInUrl)}">${escapeHtml(label)}</a></p>`
    : "";

  return page(
    `<h1>${escapeHtml(title)}</h1>
     <p>${escapeHtml(bodyText)}</p>
     ${cta}`,
    400,
  );
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// GET — side-effect-free. Soft validity check (better UX than letting the
// user click through to a guaranteed failure), then the auto-submit page.
// The token travels onward in the form body, not the URL.
export async function GET(req: NextRequest) {
  if (!(await isProviderEnabled("magiclink"))) return await errorPage();

  const token = req.nextUrl.searchParams.get("token");
  if (!token) return await errorPage();

  const { rows } = await pool().query(
    `SELECT 1 FROM auth.magic_link_tokens
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) return await errorPage();

  // value is base64url (no quotes/angle brackets possible), but escape anyway.
  const safeToken = token.replace(/[^A-Za-z0-9_-]/g, "");
  return page(
    `<h1>Completing sign-in&hellip;</h1>
     <p>You'll be redirected automatically. If nothing happens, click the button.</p>
     <form method="post" id="f">
       <input type="hidden" name="token" value="${safeToken}">
       <button type="submit">Continue</button>
     </form>
     <script>document.getElementById("f").submit();</script>`,
    200,
  );
}

// POST — consumes the token and redirects with tokens in the fragment.
export async function POST(req: NextRequest) {
  if (!(await isProviderEnabled("magiclink"))) return await errorPage();

  let token: string | null = null;
  try {
    const form = await req.formData();
    const v = form.get("token");
    token = typeof v === "string" ? v : null;
  } catch {
    token = null;
  }
  if (!token) return await errorPage();

  // Atomic single-use consume: the consumed_at IS NULL guard means a
  // double-submit lets exactly one request win.
  const { rows } = await pool().query<{ user_id: string; redirect_to: string }>(
    `UPDATE auth.magic_link_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
    RETURNING user_id, redirect_to`,
    [hashToken(token)],
  );
  if (rows.length === 0) return await errorPage();
  const { user_id, redirect_to } = rows[0];

  const userRes = await pool().query<{
    id: string;
    email: string;
    disabled_at: Date | null;
  }>(`SELECT id, email, disabled_at FROM auth.users WHERE id = $1`, [user_id]);
  const user = userRes.rows[0];
  if (!user || user.disabled_at) return await errorPage();

  // redirect_to was validated and pinned at request time; re-check against
  // the current allowlist in case it shrank since the link was issued.
  const redirectTo = await validateRedirectTarget(redirect_to);
  if (!redirectTo) return await errorPage();

  const cfg = await getMagicLinkProviderConfig();
  const ua = req.headers.get("user-agent");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const session = await createSession({
    user_id: user.id,
    user_agent: ua,
    ip,
    ttlDays: cfg.session_ttl_days,
  });
  await touchLastSignIn(user.id);
  const access = await signAccessToken({ id: user.id, email: user.email });

  // Fragment, not query — tokens never reach the destination's server logs.
  // Same parameter set as the Microsoft callback. 303 turns the POST into a
  // GET navigation at the app.
  const params = new URLSearchParams({
    access_token: access.token,
    token_type: "bearer",
    expires_in: String(access.expiresIn),
    refresh_token: session.refreshToken,
    refresh_expires_at: session.expiresAt.toISOString(),
  });
  return NextResponse.redirect(`${redirectTo}#${params.toString()}`, 303);
}
