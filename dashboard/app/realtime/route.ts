import { NextResponse, type NextRequest } from "next/server";
import { realtimeHub } from "@/lib/realtime-listener";
import { verifyAccessToken, type AccessClaims } from "@/lib/auth-jwt";
import { getRealtimeMode, SAFE_IDENT } from "@/lib/realtime";
import { canSelectEvent } from "@/lib/realtime-rls";
import { withCors, corsPreflight } from "@/lib/cors";

// Server-Sent Events stream of row changes for a specific table.
// Usage from a client app:
//   const es = new EventSource(
//     '/realtime?schema=public&table=todos&token=' + accessToken
//   );
//   es.addEventListener('message', e => console.log(JSON.parse(e.data)));
//
// EventSource doesn't allow custom headers, so the access token can be passed
// in the `token` query param. Apps that can set headers should prefer
// `Authorization: Bearer <token>`.
//
// Wrapped in withCors below so browser apps on an allowed origin (Authentication
// → CORS origins) can consume the stream — EventSource enforces CORS like any
// other fetch, and without Access-Control-Allow-Origin the browser blocks the
// 200 response. Mirrors the /auth/v1/* routes.
async function handler(req: NextRequest) {
  const schema = req.nextUrl.searchParams.get("schema") ?? "";
  const table = req.nextUrl.searchParams.get("table") ?? "";

  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(table)) {
    return new NextResponse("bad_identifier", { status: 400 });
  }

  // Auth: bearer token in Authorization header, OR `token=` query param for
  // EventSource clients (which can't set headers).
  let token = "";
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) token = m[1];
  else token = req.nextUrl.searchParams.get("token") ?? "";

  if (!token) return new NextResponse("missing_token", { status: 401 });
  let claims: AccessClaims;
  try {
    // jwtVerify rejects an already-expired token here, so connect-time is covered.
    claims = await verifyAccessToken(token);
  } catch {
    return new NextResponse("invalid_token", { status: 401 });
  }

  const mode = await getRealtimeMode(schema, table);
  if (!mode) {
    return new NextResponse("realtime_disabled_for_table", { status: 403 });
  }

  // Authorized mode: each event is checked against the table's RLS SELECT policy
  // in THIS subscriber's auth context before delivery. Basic mode is the legacy
  // table-level broadcast.
  const authorized = mode === "authorized";
  // Token expiry (seconds since epoch). Streams can outlive the 1h token TTL, so
  // we stop delivery the moment it lapses rather than leak under a stale token.
  const expSeconds = typeof claims.exp === "number" ? claims.exp : 0;

  const channel = `realtime:${schema}:${table}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      function send(line: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      }

      // Fail closed if the JWT lapses mid-stream: stop delivery, tell the client
      // (so it can mint a fresh token and reconnect), and close. Belt-and-braces
      // alongside the per-event exp guard in `authorize` below.
      let expired = false;
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;
      if (expSeconds > 0) {
        const msLeft = expSeconds * 1000 - Date.now();
        const fire = () => {
          expired = true;
          send(`event: token_expired\ndata: ${JSON.stringify({ schema, table })}\n\n`);
          cleanup();
        };
        if (msLeft <= 0) {
          // Shouldn't happen (verifyAccessToken would have 401'd), but be safe.
          queueMicrotask(fire);
        } else {
          // setTimeout caps at ~24.8 days; tokens live ~1h so this is fine.
          expiryTimer = setTimeout(fire, msLeft);
        }
      }

      // Authorizer for authorized-mode tables: re-check the row against the
      // table's RLS SELECT policy in this subscriber's context. Fails closed,
      // including once the token has expired.
      const authorize = authorized
        ? (event: import("@/lib/realtime-rls").RealtimeEvent) => {
            if (expired || (expSeconds > 0 && Date.now() >= expSeconds * 1000)) {
              return false;
            }
            return canSelectEvent(event, claims as Record<string, unknown>);
          }
        : undefined;

      // Register with the per-replica fan-out hub instead of holding our own
      // Postgres connection. The hub keeps a single shared LISTEN connection
      // and delivers this channel's notifications to every subscriber, so a
      // thousand open streams cost one DB connection, not a thousand. In
      // authorized mode the hub evaluates `authorize` once per distinct user
      // identity per event (authzKey) and reuses the decision.
      try {
        unsubscribe = await realtimeHub().subscribe(channel, {
          deliver: (payload) => {
            if (!expired) send(`data: ${payload}\n\n`);
          },
          authorize,
          authzKey: authorized ? `${claims.sub}` : undefined,
        });
      } catch (e) {
        send(
          `event: error\ndata: ${JSON.stringify({
            error: (e as Error).message,
          })}\n\n`,
        );
        try {
          controller.close();
        } catch {}
        return;
      }

      // Initial event so the client knows we're up.
      send(`event: open\ndata: ${JSON.stringify({ schema, table })}\n\n`);

      // Heartbeat so intermediate proxies don't time us out.
      const hb = setInterval(() => send(`:hb\n\n`), 25_000);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        if (expiryTimer) clearTimeout(expiryTimer);
        unsubscribe?.();
        try {
          controller.close();
        } catch {}
      }

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Next's response buffering for streaming.
      "X-Accel-Buffering": "no",
    },
  });
}

const METHODS = ["GET"] as const;

export const GET = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
