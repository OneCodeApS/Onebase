import { touchLastUsed, verifyToken } from "@/lib/access-tokens";
import { checkRateLimit } from "@/lib/rate-limit";
import { handleMcpMessage, type JsonRpcResponse } from "@/lib/mcp/server";

// MCP endpoint — Streamable HTTP transport in stateless mode. Lives on the
// api.* host (Caddy: handle /mcp/v1*); middleware.ts lets it through without
// a dashboard session because auth here is a personal access token
// (Admin → Access tokens), checked on every request.
//
// Stateless means: no Mcp-Session-Id, no server-initiated SSE stream, every
// POST self-contained. That keeps the endpoint replica-safe behind Caddy's
// load balancing with zero session affinity.

function rpcError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

// MCP clients are non-browser processes and send no Origin header. If one IS
// present, require it to match our own hosts — stops DNS-rebinding and
// browser-based callers (which would be cross-origin anyway; there is no CORS
// on this route by design).
function originAllowed(origin: string): boolean {
  const own = [process.env.API_PUBLIC_URL, process.env.DASHBOARD_PUBLIC_URL]
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u as string).origin;
      } catch {
        return null;
      }
    });
  return own.includes(origin);
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !originAllowed(origin)) {
    return Response.json(rpcError(-32000, "Origin not allowed"), { status: 403 });
  }

  const match = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  const auth = match ? await verifyToken(match[1].trim()) : null;
  if (!auth) {
    return Response.json(
      rpcError(
        -32001,
        "Unauthorized. Send a personal access token as 'Authorization: Bearer ob_pat_…'. Tokens are created in the Onebase dashboard under Admin → Access tokens.",
      ),
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="onebase-mcp"' } },
    );
  }

  // Per-token throttle, shared across replicas (Admin → Rate limits, area "mcp").
  const rl = await checkRateLimit("mcp", auth.tokenId);
  if (!rl.ok) {
    return Response.json(rpcError(-32000, "Rate limit exceeded — slow down."), {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  touchLastUsed(auth.tokenId);

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json(rpcError(-32700, "Parse error: body must be JSON"), { status: 400 });
  }

  const ctx = { auth, ip: clientIp(req) };
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || messages.length > 20) {
    return Response.json(rpcError(-32600, "Batch must contain 1-20 messages"), { status: 400 });
  }

  const responses: JsonRpcResponse[] = [];
  for (const msg of messages) {
    const r = await handleMcpMessage(msg, ctx);
    if (r !== null) responses.push(r);
  }

  // All notifications → nothing to say (spec: 202 Accepted, empty body).
  if (responses.length === 0) return new Response(null, { status: 202 });

  return Response.json(Array.isArray(parsed) ? responses : responses[0]);
}

// Stateless mode has no server-initiated stream to offer.
export async function GET() {
  return Response.json(rpcError(-32000, "This MCP server is stateless: POST JSON-RPC messages to this endpoint."), {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function DELETE() {
  return Response.json(rpcError(-32000, "No session to delete (stateless server)."), {
    status: 405,
    headers: { Allow: "POST" },
  });
}
