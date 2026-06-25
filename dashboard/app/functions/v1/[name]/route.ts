import { NextResponse, type NextRequest } from "next/server";
import { verifyJwtSignature } from "@/lib/auth-jwt";
import { audit } from "@/lib/audit";
import { withCors, corsPreflight } from "@/lib/cors";
import {
  auditInvocation,
  executeFunction,
  FUNCTION_NAME,
  getFunction,
  type FunctionCaller,
} from "@/lib/functions";

// Extracts a JWT from, in priority order:
//   1. Authorization: Bearer <token>           — standard, what user JWTs use
//   2. apikey: <token>                          — what Supabase clients send
//                                                 for anon / service_role keys
//   3. ?token=<token>                           — for EventSource / browser
//                                                 fetches that can't set headers
function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const apikey = req.headers.get("apikey");
  if (apikey) return apikey;
  return req.nextUrl.searchParams.get("token") || null;
}

const ROLE_RANK: Record<string, number> = {
  anon: 0,
  authenticated: 1,
  service_role: 2,
};

async function handle(
  req: NextRequest,
  params: Promise<{ name: string }>,
): Promise<Response> {
  const { name } = await params;
  if (!FUNCTION_NAME.test(name)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }
  const fn = await getFunction(name);
  if (!fn || !fn.enabled) {
    return NextResponse.json({ error: "function_not_found" }, { status: 404 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // JWT gate. When verify_jwt is on (default), only valid tokens signed with
  // PGRST_JWT_SECRET get through. Same secret PostgREST uses, so any token
  // issued by /auth/v1/* works here automatically. Service-role tokens
  // (minted offline with the same secret) work too.
  let caller: FunctionCaller | null = null;
  if (fn.verify_jwt) {
    const token = extractToken(req);
    if (!token) {
      await audit({
        actor: "<edge-function-caller>",
        actorId: null,
        role: null,
        action: "function.invoke",
        target: fn.name,
        success: false,
        ip,
        metadata: {
          method: req.method,
          trigger: "http",
          error: "missing_token",
        },
      });
      return NextResponse.json(
        { error: "missing_token" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    try {
      // Signature-only verification. Accepts anon / authenticated /
      // service_role tokens — function code differentiates via ctx.user.role.
      const claims = await verifyJwtSignature(token);
      caller = {
        id: typeof claims.sub === "string" ? claims.sub : null,
        email: typeof claims.email === "string" ? claims.email : null,
        role: typeof claims.role === "string" ? claims.role : null,
      };
    } catch {
      await audit({
        actor: "<edge-function-caller>",
        actorId: null,
        role: null,
        action: "function.invoke",
        target: fn.name,
        success: false,
        ip,
        metadata: {
          method: req.method,
          trigger: "http",
          error: "invalid_token",
        },
      });
      return NextResponse.json(
        { error: "invalid_token" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }

    // A valid signature isn't enough: the caller's token role must meet the
    // function's min_role (default 'authenticated'), so the public anon key no
    // longer reaches a JWT-gated function. service_role > authenticated > anon.
    const callerRank = caller?.role ? (ROLE_RANK[caller.role] ?? -1) : -1;
    if (callerRank < (ROLE_RANK[fn.min_role] ?? 1)) {
      await audit({
        actor: "<edge-function-caller>",
        actorId: null,
        role: null,
        action: "function.invoke",
        target: fn.name,
        success: false,
        ip,
        metadata: {
          method: req.method,
          trigger: "http",
          error: "insufficient_role",
          min_role: fn.min_role,
          caller_role: caller?.role ?? null,
        },
      });
      return NextResponse.json(
        { error: "forbidden_role" },
        { status: 403, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
  }

  const result = await executeFunction(fn, req, caller);

  await auditInvocation(fn, req.method, result, { kind: "http" }, ip);

  if (!result.ok) {
    return NextResponse.json(
      { error: "function_error", detail: result.error },
      { status: 500 },
    );
  }
  return result.response;
}

// CORS: browser apps can't reach a function until the preflight passes and the
// response carries Access-Control-Allow-Origin. We wrap every verb in withCors
// (adds the headers for allowed origins) and answer OPTIONS preflights with
// corsPreflight — both keyed off the same auth_allowed_origins allowlist as
// /auth/v1/* and /realtime. A function that sets its own CORS headers still
// works: withCors overwrites Allow-Origin with the allowlist-resolved value.
// The route accepts all verbs, so the preflight advertises all of them.
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Ctx = { params: Promise<{ name: string }> };

const wrapped = withCors<[Ctx]>(
  (req, ctx) => handle(req, ctx.params),
  { methods: METHODS },
);

export const GET = wrapped;
export const POST = wrapped;
export const PUT = wrapped;
export const PATCH = wrapped;
export const DELETE = wrapped;
export const OPTIONS = corsPreflight({ methods: METHODS });
