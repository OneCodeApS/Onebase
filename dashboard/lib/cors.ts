import { NextResponse, type NextRequest } from "next/server";
import { getSetting } from "./settings";

// Origin allowlist for browser-facing public APIs. Managed from the dashboard
// (Authentication → CORS origins), persisted as the `auth_allowed_origins`
// setting. Until that's ever saved it falls back to the AUTH_ALLOWED_ORIGINS
// env var (comma-separated) so existing deployments keep working. Either source
// resolves to a list where:
//   []                              → no cross-origin browser access
//   ["*"]                           → reflect any origin (bearer-only; cookies unsafe)
//   ["https://app.example.com", …]  → exact-match allowlist
//
// Non-browser clients (curl, server-to-server) don't enforce CORS, so they
// keep working regardless of this setting — only browser apps from origins
// outside the list will be blocked from reading responses.
export const ORIGINS_SETTING_KEY = "auth_allowed_origins";

// Fallback list from the env var. Also the seed the admin UI starts from the
// first time the list is edited, so env-configured origins aren't lost.
export function envAllowedOrigins(): string[] {
  return (process.env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// resolveAllowOrigin runs on every CORS-eligible request, so the DB-backed list
// is cached in-process for a few seconds instead of querying per request. The
// admin actions call bustOriginsCache() right after a save, so edits take
// effect immediately on this instance; other instances catch up within the TTL.
const ORIGINS_TTL_MS = 30_000;
let originsCache: { list: string[]; at: number } | null = null;

export function bustOriginsCache(): void {
  originsCache = null;
}

// Effective allowlist. The DB setting wins once it's ever been written — even
// an empty array, which is an explicit "allow nothing". Only a never-set (null)
// value falls through to the env var; a DB error also falls back to env rather
// than blocking requests.
export async function getAllowedOrigins(): Promise<string[]> {
  const now = Date.now();
  if (originsCache && now - originsCache.at < ORIGINS_TTL_MS) {
    return originsCache.list;
  }
  let list: string[];
  try {
    const stored = await getSetting<string[]>(ORIGINS_SETTING_KEY);
    list = Array.isArray(stored) ? stored : envAllowedOrigins();
  } catch {
    list = envAllowedOrigins();
  }
  originsCache = { list, at: now };
  return list;
}

// Validates a redirect target that will carry auth tokens in its fragment
// (magic-link verify, and any future token-bearing redirect). Stricter than
// CORS: the wildcard is NOT accepted — it would make the caller an open
// redirect that hands tokens to any origin. https only, except
// localhost/*.localhost for dev. Returns the normalised URL or null.
export async function validateRedirectTarget(
  raw: string,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const devHost =
    url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && devHost)) {
    return null;
  }
  const list = await getAllowedOrigins();
  if (list.length === 0 || list.includes("*")) return null;
  if (!list.includes(url.origin)) return null;
  return url.toString();
}

async function resolveAllowOrigin(
  reqOrigin: string | null,
): Promise<string | null> {
  const list = await getAllowedOrigins();
  if (list.length === 0) return null;
  if (list.includes("*")) return reqOrigin ?? "*";
  if (reqOrigin && list.includes(reqOrigin)) return reqOrigin;
  return null;
}

// Headers added to every CORS-eligible response. We deliberately don't set
// `Access-Control-Allow-Credentials: true` — refresh tokens travel in the
// JSON body, not cookies, so credentials would only widen attack surface
// (and conflict with the wildcard origin case).
function corsHeaders(allowOrigin: string, methods: readonly string[]): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", allowOrigin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", methods.join(", "));
  h.set(
    "Access-Control-Allow-Headers",
    "content-type, authorization, apikey, x-client-info",
  );
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

// Args captures any extra positional arguments Next.js passes after the
// request — e.g. the `{ params }` context object for dynamic routes — so the
// wrapper stays transparent to handlers that need them.
type Handler<Args extends unknown[] = []> = (
  req: NextRequest,
  ...args: Args
) => Promise<Response> | Response;

type CorsOptions = {
  // HTTP verbs this route exposes. OPTIONS is added automatically.
  methods: readonly string[];
};

// Wraps a route handler so it:
//   1. Adds Access-Control-* headers to the real response when the request
//      origin is in the allowlist.
//   2. Lets non-browser callers (no Origin header) through untouched.
// Pair with corsPreflight() to handle the OPTIONS preflight on the same route.
export function withCors<Args extends unknown[]>(
  handler: Handler<Args>,
  opts: CorsOptions,
): Handler<Args> {
  return async (req, ...args) => {
    const allow = await resolveAllowOrigin(req.headers.get("origin"));
    const res = await handler(req, ...args);
    if (allow) {
      const cors = corsHeaders(allow, [...opts.methods, "OPTIONS"]);
      cors.forEach((v, k) => res.headers.set(k, v));
    }
    return res;
  };
}

// Standalone OPTIONS handler. Returns 204 with the CORS headers for allowed
// origins; 403 for everything else. Export as `OPTIONS` from a route file:
//   export const OPTIONS = corsPreflight({ methods: ["POST"] });
export function corsPreflight(opts: CorsOptions): Handler {
  return async (req) => {
    const allow = await resolveAllowOrigin(req.headers.get("origin"));
    if (!allow) {
      return new NextResponse(null, { status: 403 });
    }
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(allow, [...opts.methods, "OPTIONS"]),
    });
  };
}
