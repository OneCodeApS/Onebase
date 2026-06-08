import { NextResponse, type NextRequest } from "next/server";
import { verifyJwtSignature } from "@/lib/auth-jwt";
import { publicSignedObjectUrl } from "@/lib/minio";
import { corsPreflight, withCors } from "@/lib/cors";
import { canSignForBucket, getBucketPolicy, mimeAllowed } from "@/lib/storage";

const METHODS = ["POST"] as const;

// 5 minutes — enough slack to start the upload. Once the PUT begins, MinIO
// doesn't recheck SigV4 expiry, so the transfer itself can take as long as it
// takes (large videos on slow connections are fine).
const UPLOAD_URL_EXPIRY_SECONDS = 5 * 60;

// POST /storage/v1/object/upload/<bucket>/<key...>
//
// Body: { size?: number, content_type?: string }
// Returns: { upload_url, expires_at, max_upload_mb }
//
// Validates the bucket policy BEFORE issuing the URL. The returned URL is a
// SigV4-signed PUT against api.<host>/storage/v1/object/<bucket>/<key>; the
// client PUTs the file body there. Caddy strips /storage/v1/object before
// forwarding to MinIO.
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const claims = await readJwt(req);
  if (!claims) {
    return NextResponse.json(
      { error: "missing_or_invalid_token" },
      { status: 401 },
    );
  }
  if (claims.role !== "authenticated" && claims.role !== "service_role") {
    return NextResponse.json({ error: "forbidden_role" }, { status: 403 });
  }

  const { bucket, path } = await ctx.params;
  const key = path.map(decodeURIComponent).join("/");

  // Object-level authorization: authenticated end-users may only upload to
  // public buckets; private buckets require service_role (backend-mediated).
  if (!(await canSignForBucket(claims.role, bucket))) {
    return NextResponse.json({ error: "forbidden_bucket" }, { status: 403 });
  }

  let body: { size?: number; content_type?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const policy = await getBucketPolicy(bucket);

  if (typeof body.size === "number" && body.size > 0) {
    const mb = body.size / (1024 * 1024);
    if (mb > policy.max_upload_mb) {
      return NextResponse.json(
        {
          error: "file_too_large",
          detail: `Bucket allows up to ${policy.max_upload_mb} MB; declared ${mb.toFixed(1)} MB`,
        },
        { status: 413 },
      );
    }
  }
  if (
    typeof body.content_type === "string" &&
    body.content_type.length > 0 &&
    !mimeAllowed(body.content_type, policy.allowed_mime)
  ) {
    return NextResponse.json(
      {
        error: "mime_not_allowed",
        detail: `Content type "${body.content_type}" is not allowed for this bucket`,
      },
      { status: 415 },
    );
  }

  try {
    const uploadUrl = await publicSignedObjectUrl(
      "PUT",
      bucket,
      key,
      UPLOAD_URL_EXPIRY_SECONDS,
    );
    const expiresAt = new Date(
      Date.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000,
    ).toISOString();
    return NextResponse.json({
      upload_url: uploadUrl,
      expires_at: expiresAt,
      max_upload_mb: policy.max_upload_mb,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "presign_failed", detail: (e as Error).message },
      { status: 502 },
    );
  }
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
