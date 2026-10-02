import { NextResponse, type NextRequest } from "next/server";
import { verifyJwtSignature } from "@/lib/auth-jwt";
import { publicSignedObjectUrl } from "@/lib/minio";
import { authorizeKeys } from "@/lib/storage";
import { corsPreflight, withCors } from "@/lib/cors";

const METHODS = ["POST"] as const;
const DEFAULT_SIGN_TTL = 60 * 60;
const MAX_SIGN_TTL = 60 * 60 * 24 * 7;
const MAX_BATCH = 100;

type Item = { bucket: string; key: string };
type Body = { items: Item[]; expires_in?: number };

// POST /storage/v1/object/sign-batch
//
// Mints up to MAX_BATCH SigV4-signed GET URLs in one round-trip. Use for
// galleries / grids that would otherwise issue N sequential POSTs.
async function handler(req: NextRequest) {
  const jwt = await readJwt(req);
  if (!jwt) {
    return NextResponse.json(
      { error: "missing_or_invalid_token" },
      { status: 401 },
    );
  }
  const { claims, raw } = jwt;
  if (claims.role !== "authenticated" && claims.role !== "service_role") {
    return NextResponse.json({ error: "forbidden_role" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "items_required" }, { status: 400 });
  }
  if (body.items.length > MAX_BATCH) {
    return NextResponse.json(
      { error: "too_many_items", detail: `max ${MAX_BATCH} per call` },
      { status: 400 },
    );
  }

  const ttl = clampTtl(body.expires_in ?? DEFAULT_SIGN_TTL);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  // Object-level authorization, resolved once per distinct bucket with every key
  // asked for in it — one check call per bucket, not one per item. Disallowed
  // items come back as per-item errors (same shape as a presign failure), so
  // one forbidden object doesn't fail the whole batch.
  const byBucket = new Map<string, string[]>();
  for (const it of body.items) {
    const list = byBucket.get(it.bucket) ?? [];
    list.push(String(it.key));
    byBucket.set(it.bucket, list);
  }
  const allowed = new Map<string, Set<string>>();
  await Promise.all(
    [...byBucket].map(async ([bucket, keys]) =>
      allowed.set(
        bucket,
        await authorizeKeys({ role: claims.role as string, token: raw, bucket, keys, mode: "read" }),
      ),
    ),
  );

  // SDK calls are synchronous CPU work (HMAC + URL building); no need to
  // serialize them sequentially.
  const items = await Promise.all(
    body.items.map(async (it) => {
      if (!allowed.get(it.bucket)?.has(String(it.key))) {
        return { bucket: it.bucket, key: it.key, error: "forbidden_object" };
      }
      try {
        const url = await publicSignedObjectUrl("GET", it.bucket, it.key, ttl);
        return { bucket: it.bucket, key: it.key, url, expires_at: expiresAt };
      } catch (e) {
        return {
          bucket: it.bucket,
          key: it.key,
          error: (e as Error).message,
        };
      }
    }),
  );

  return NextResponse.json({ items });
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
    return { claims: await verifyJwtSignature(raw), raw };
  } catch {
    return null;
  }
}

export const POST = withCors(handler, { methods: METHODS });
export const OPTIONS = corsPreflight({ methods: METHODS });
