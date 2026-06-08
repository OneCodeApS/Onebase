import { NextResponse, type NextRequest } from "next/server";
import { realtimeHub } from "@/lib/realtime-listener";
import { verifyAccessToken } from "@/lib/auth-jwt";
import { isRealtimeEnabled, SAFE_IDENT } from "@/lib/realtime";
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
  try {
    await verifyAccessToken(token);
  } catch {
    return new NextResponse("invalid_token", { status: 401 });
  }

  if (!(await isRealtimeEnabled(schema, table))) {
    return new NextResponse("realtime_disabled_for_table", { status: 403 });
  }

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

      // Register with the per-replica fan-out hub instead of holding our own
      // Postgres connection. The hub keeps a single shared LISTEN connection
      // and delivers this channel's notifications to every subscriber, so a
      // thousand open streams cost one DB connection, not a thousand.
      try {
        unsubscribe = await realtimeHub().subscribe(channel, (payload) => {
          send(`data: ${payload}\n\n`);
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
