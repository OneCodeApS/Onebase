import { pool } from "./db";
import { minio } from "./minio";

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

// S3 has no real directories — a "folder" is just a shared key prefix. To make
// an otherwise-empty folder visible we write a zero-byte object at
// "<folder>/.emptyFolderPlaceholder" (same convention Supabase uses); the
// listing hides it again.
export const FOLDER_PLACEHOLDER = ".emptyFolderPlaceholder";

// Sanitises the object-browser's name filter. It gets appended to the S3
// prefix, so it has to obey the same rules as a prefix: no slashes (that would
// silently cross a folder boundary), no dot-segments, no control characters.
// Anything else is dropped rather than rejected — a bad filter just means "no
// filter", never a broken listing.
export function normalizeSearch(raw: string | undefined | null): string {
  if (!raw) return "";
  const s = raw.trim();
  if (s.length === 0 || s.length > 255) return "";
  if (s === "." || s === "..") return "";
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f]/.test(s)) return "";
  return s;
}

// How many entries one page of the object browser holds. S3 counts
// CommonPrefixes and Contents together against MaxKeys, so this bounds both the
// listing round trip and the number of table rows the browser has to lay out.
// S3 caps MaxKeys at 1000 regardless of what we ask for.
export const LIST_PAGE_SIZE = 200;

// A file row in a folder listing. `lastModified` is an ISO string rather than a
// Date because the listing crosses the server/client boundary twice (initial
// render, then the load-more server action).
export type StorageFile = {
  name: string;
  size: number;
  lastModified: string;
  etag: string;
};

export type LevelPage = {
  folders: string[];
  files: StorageFile[];
  // Opaque S3 continuation token to hand back for the next page; null when this
  // page is the last one.
  nextToken: string | null;
};

// Lists ONE page of a single folder level (non-recursive). MinIO returns the
// subfolders at this level as "common prefix" entries and the files as regular
// objects; the zero-byte placeholder for the current folder is filtered out so
// it never shows as a file.
//
// The bucket page used to consume minio's listObjectsV2 *stream* to exhaustion,
// which for a folder holding 10k+ entries meant 10+ sequential round trips, the
// whole listing buffered server-side, and 10k rows serialised into the RSC
// payload — the browser then froze laying them out. This issues exactly one
// ListObjectsV2 request and hands back a cursor instead.
//
// `search` narrows the listing to entries whose name starts with it, by
// appending it to the S3 prefix. The delimiter still applies, so subfolders
// still come back collapsed. It is a prefix match, not a substring one: that is
// the only filter S3 can apply without walking every key in the bucket.
export async function listLevel(
  bucket: string,
  prefix: string,
  opts: { search?: string; token?: string | null; limit?: number } = {},
): Promise<LevelPage> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_PAGE_SIZE, 1), 1000);
  const res = await minio.listObjectsV2Query(
    bucket,
    `${prefix}${opts.search ?? ""}`,
    opts.token ?? "",
    "/",
    limit,
    "",
  );

  const folders: string[] = [];
  const files: StorageFile[] = [];
  const placeholder = `${prefix}${FOLDER_PLACEHOLDER}`;

  for (const o of res.objects) {
    if (o.prefix) {
      folders.push(o.prefix);
    } else if (o.name && o.name !== placeholder) {
      files.push({
        name: o.name,
        size: o.size,
        lastModified: new Date(o.lastModified).toISOString(),
        etag: o.etag,
      });
    }
  }

  return {
    folders,
    files,
    // Coerced: the XML parser turns an all-digit token into a number, and it
    // has to survive a round trip through the client as a string.
    nextToken:
      res.isTruncated && res.nextContinuationToken
        ? String(res.nextContinuationToken)
        : null,
  };
}

// Walks every key under `prefix` one S3 page at a time, handing each page to
// `onBatch`. Used by folder deletion, which used to collect the entire key set
// into a single array before deleting — fine for a handful of files, a memory
// blow-up for a folder holding hundreds of thousands.
export async function forEachKeyBatch(
  bucket: string,
  prefix: string,
  onBatch: (keys: string[]) => Promise<void>,
): Promise<void> {
  let token = "";

  for (;;) {
    // No delimiter: every key beneath the prefix comes back flat. 1000 is both
    // the S3 listing page cap and the DeleteObjects batch cap.
    const res = await minio.listObjectsV2Query(bucket, prefix, token, "", 1000, "");
    const keys = res.objects
      .map((o) => o.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    if (keys.length > 0) await onBatch(keys);

    if (!res.isTruncated || !res.nextContinuationToken) return;
    token = String(res.nextContinuationToken);
  }
}

// Normalises a folder prefix coming from the ?prefix= query param (or a form
// field) into a value safe to hand MinIO as a listing prefix / key base. The
// result is either "" (bucket root) or a path that always ends in "/". Leading
// slashes are stripped, repeated slashes collapsed, and any "." / ".." segment
// rejects the whole thing — the prefix must never escape the bucket.
export function normalizePrefix(raw: string | undefined | null): string {
  if (!raw) return "";
  const segments = raw
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  if (segments.some((s) => s === "." || s === "..")) return "";
  return segments.join("/") + "/";
}

// Validates a single folder-name segment typed by a user (the "New folder"
// field). One level only: no slashes, no dot-segments, no control characters,
// no leading/trailing whitespace.
export function isValidSegment(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (name !== name.trim()) return false;
  // eslint-disable-next-line no-control-regex
  return !/[/\\\x00-\x1f]/.test(name);
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
