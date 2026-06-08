import { pool } from "./db";

export type Visibility = "public" | "private";

export type BucketPolicy = {
  bucket: string;
  visibility: Visibility;
  max_upload_mb: number;
  // null = all MIME types allowed.
  allowed_mime: string[] | null;
};

// Defaults applied to buckets that don't yet have a policy row.
export const DEFAULT_POLICY = {
  visibility: "private" as Visibility,
  max_upload_mb: 25,
  allowed_mime: null as string[] | null,
};

export async function getBucketPolicy(bucket: string): Promise<BucketPolicy> {
  const { rows } = await pool().query<BucketPolicy>(
    `SELECT bucket, visibility, max_upload_mb, allowed_mime
       FROM _dashboard.bucket_policies
      WHERE bucket = $1`,
    [bucket],
  );
  if (rows.length > 0) return rows[0];
  return { bucket, ...DEFAULT_POLICY };
}

// Authorization for the PUBLIC storage signing/upload routes (the external API
// surface, not the dashboard's own UI). `service_role` (server-side, trusted)
// may sign for any bucket; an `authenticated` end-user may only sign for
// buckets explicitly marked `public`. Private buckets are reached only via your
// own backend, which holds `service_role` and does its own per-user check —
// this stops any logged-in user from signing URLs for arbitrary objects in
// private buckets (object-level authorization bypass). Note: any authenticated
// user can still read/overwrite objects in a *public* bucket (that's what
// "public" means); use private buckets + backend-mediated signing for
// per-user-controlled access. Per-object ownership (e.g. key-prefix = user id)
// can layer on top later — see TODOS.md "per-bucket ACL beyond visibility".
export async function canSignForBucket(
  role: string | undefined,
  bucket: string,
): Promise<boolean> {
  if (role === "service_role") return true;
  if (role !== "authenticated") return false;
  const policy = await getBucketPolicy(bucket);
  return policy.visibility === "public";
}

export async function setBucketPolicy(
  policy: BucketPolicy,
  updatedBy: string | null,
): Promise<void> {
  await pool().query(
    `INSERT INTO _dashboard.bucket_policies
       (bucket, visibility, max_upload_mb, allowed_mime, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (bucket) DO UPDATE
       SET visibility    = EXCLUDED.visibility,
           max_upload_mb = EXCLUDED.max_upload_mb,
           allowed_mime  = EXCLUDED.allowed_mime,
           updated_by    = EXCLUDED.updated_by,
           updated_at    = now()`,
    [
      policy.bucket,
      policy.visibility,
      policy.max_upload_mb,
      policy.allowed_mime,
      updatedBy,
    ],
  );
}

// Checks if a given MIME matches the whitelist. Supports wildcards like
// "image/*" or "application/*". null/empty whitelist = allow everything.
export function mimeAllowed(mime: string, allowed: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  const lower = mime.toLowerCase();
  return allowed.some((a) => {
    const al = a.toLowerCase();
    if (al === lower) return true;
    if (al.endsWith("/*")) return lower.startsWith(al.slice(0, -1));
    return false;
  });
}

// AWS-style bucket policy MinIO accepts to allow anonymous GET on every
// object. Mirrored to MinIO whenever a bucket is set to "public" — Caddy
// strips /storage/v1/object before forwarding, so MinIO sees a regular
// path-style request and the anonymous-read ACL applies.
export function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}
