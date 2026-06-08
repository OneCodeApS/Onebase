import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type Session } from "./lib/session";

const PUBLIC_PATHS = new Set<string>(["/login"]);

// Paths that require role=admin. Guests on these get 404 (not 403) so
// the existence of admin pages isn't advertised.
function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

// Subset of /admin/* paths that signed-in non-admin users may view (read-only).
// Server actions on these pages still require admin via requireAdmin() inside
// the action — this only opens up the rendered pages, not the mutations.
function isNonAdminReadable(pathname: string): boolean {
  if (pathname === "/admin/policies") return true;
  if (pathname === "/admin/grants") return true;
  if (pathname === "/admin/enums") return true;
  if (pathname === "/admin/cron") return true;

  if (pathname === "/admin/db-functions") return true;
  if (pathname.startsWith("/admin/db-functions/")) {
    const tail = pathname.slice("/admin/db-functions/".length);
    // The "create" form is admin-only; the per-oid detail page is readable.
    if (tail === "new" || tail.startsWith("new/")) return false;
    return true;
  }

  if (pathname === "/admin/functions") return true;
  if (pathname.startsWith("/admin/functions/")) {
    const tail = pathname.slice("/admin/functions/".length);
    // /admin/functions/env (global env vars) is admin-only.
    if (tail === "env" || tail.startsWith("env/")) return false;
    // /admin/functions/<name>/code (source editor) is admin-only.
    const slash = tail.indexOf("/");
    if (slash !== -1) {
      const sub = tail.slice(slash + 1);
      if (sub === "code" || sub.startsWith("code/")) return false;
    }
    return true;
  }

  return false;
}

// End-user auth API — public, called by external apps with their own bearer
// token (or no token, for sign-up / sign-in). Dashboard session is irrelevant
// here.
function isPublicAuthApi(pathname: string): boolean {
  return pathname.startsWith("/auth/v1/");
}

// Realtime SSE stream — authenticates via Bearer token / ?token= itself, no
// dashboard session needed.
function isRealtimeApi(pathname: string): boolean {
  return pathname === "/realtime" || pathname.startsWith("/realtime/");
}

// Edge functions — function authors choose their own auth model; the
// dashboard doesn't gate access.
function isFunctionsApi(pathname: string): boolean {
  return pathname.startsWith("/functions/v1/");
}

// Storage proxy — public API on api.*/storage/v1/*. Each route enforces its
// own auth (HMAC token, JWT, or bucket-visibility check), so the dashboard
// session is irrelevant here.
function isStorageApi(pathname: string): boolean {
  return pathname.startsWith("/storage/v1/");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.has(pathname) ||
    isPublicAuthApi(pathname) ||
    isRealtimeApi(pathname) ||
    isFunctionsApi(pathname) ||
    isStorageApi(pathname)
  ) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session = await getIronSession<Session>(req, res, sessionOptions());

  if (!session.userId) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (
    isAdminPath(pathname) &&
    session.role !== "admin" &&
    !isNonAdminReadable(pathname)
  ) {
    return new NextResponse("Not Found", { status: 404 });
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
