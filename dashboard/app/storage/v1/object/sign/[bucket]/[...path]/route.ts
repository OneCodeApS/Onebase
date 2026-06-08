import { NextResponse, type NextRequest } from "next/server";
import { verifyJwtSignature } from "@/lib/auth-jwt";
import { publicSignedObjectUrl } from "@/lib/minio";
import { canSignForBucket } from "@/lib/storage";
import { corsPreflight, withCors } from "@/lib/cors";

const METHODS = ["POST"] as const;
const DEFAULT_SIGN_TTL = 60 * 60;
const MAX_SIGN_TTL = 60 * 60 * 24 * 7;

// POST /storage/v1/object/sign/<bucket>/<key...>
//
// Body: { expires_in?: number }
// Returns: { url, expires_at }
//
// Requires a valid JWT (authenticated or service_role). The returned URL is
// a SigV4-signed GET against api.<host>/storage/v1/object/<bucket>/<key>;
// Caddy strips /storage/v1/object before forwarding to MinIO.
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const claims = await readJwt(req);
  if (!claims) {
    return NextResponse.json({ error: "missing_or_invalid_token" }, { status: 401 });
  }
  if (claims.role !== "authenticated" && claims.role !== "service_role") {
    return NextResponse.json({ error: "forbidden_role" }, { status: 403 });
  }

  const { bucket, path } = await ctx.params;
  const key = path.map(decodeURIComponent).join("/");

  // Object-level authorization: an authenticated end-user may only sign for
  // public buckets; private buckets require service_role (backend-mediated).
  if (!(await canSignForBucket(claims.role, bucket))) {
    return NextResponse.json({ error: "forbidden_bucket" }, { status: 403 });
  }

  let body: { expires_in?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const ttl = clampTtl(body.expires_in ?? DEFAULT_SIGN_TTL);

  try {
    const url = await publicSignedObjectUrl("GET", bucket, key, ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    return NextResponse.json({ url, expires_at: expiresAt });
  } catch (e) {
    return NextResponse.json(
      { error: "presign_failed", detail: (e as Error).message },
      { status: 502 },
    );
  }
}

function clampTtl(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIGN_TTL;
  return Math.min(Math.floor(n), MAX_SIGN_TTL);
}

async function readJwt(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const raw = m?.[1] ?? apikey;
  if (!raw) return null;
  try {
    return await verifyJwtSignature(raw);
  } catch {
    return null;
  }
}

export const POST = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
