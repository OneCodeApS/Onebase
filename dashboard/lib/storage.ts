import { pool } from "./db";
import { minio } from "./minio";

export type Visibility = "public" | "private";

export type BucketPolicy = {
  bucket: string;
  visibility: Visibility;
  max_upload_mb: number;
  // null = all MIME types allowed.
  allowed_mime: string[] | null;
  // Private buckets only: name of a public.<fn>(p_bucket text, p_keys text[])
  // returns setof text, called as the end-user to authorize reads / uploads.
  // null = service_role only (the behaviour before migration 0033).
  read_check: string | null;
  write_check: string | null;
};

// Defaults applied to buckets that don't yet have a policy row.
export const DEFAULT_POLICY = {
  visibility: "private" as Visibility,
  max_upload_mb: 25,
  allowed_mime: null as string[] | null,
  read_check: null as string | null,
  write_check: null as string | null,
};

export async function getBucketPolicy(bucket: string): Promise<BucketPolicy> {
  // The check columns are read through to_jsonb so an install that has not yet
  // applied migration 0033 keeps working: the keys are simply absent, which is
  // the same as "no check" — private stays service_role only.
  const { rows } = await pool().query<BucketPolicy>(
    `SELECT bucket, visibility, max_upload_mb, allowed_mime,
            to_jsonb(p) ->> 'read_check'  AS read_check,
            to_jsonb(p) ->> 'write_check' AS write_check
       FROM _dashboard.bucket_policies p
      WHERE bucket = $1`,
    [bucket],
  );
  if (rows.length > 0) return rows[0];
  return { bucket, ...DEFAULT_POLICY };
}

// Bucket-level answer only: `service_role` may sign for any bucket; an
// `authenticated` end-user only for buckets marked `public`. The public sign /
// sign-batch / upload routes no longer call this — they use authorizeKeys
// below, which adds per-object checks for private buckets (migration 0033).
// Kept for callers that only need the bucket-level rule. Note: any
// authenticated user can still read/overwrite objects in a *public* bucket
// (that's what "public" means).
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
  const hasChecks = policy.read_check !== null || policy.write_check !== null;
  // Without checks the statement is the pre-0033 one, so saving visibility or
  // size limits still works on an install that has not applied the migration.
  // With checks it needs the columns — and the error then says so plainly.
  if (!hasChecks && !(await hasCheckColumns())) {
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
      [policy.bucket, policy.visibility, policy.max_upload_mb, policy.allowed_mime, updatedBy],
    );
    return;
  }
  if (!(await hasCheckColumns())) {
    throw new Error("Apply migration 0033_bucket_policy_checks.sql before setting read/write checks");
  }
  await pool().query(
    `INSERT INTO _dashboard.bucket_policies
       (bucket, visibility, max_upload_mb, allowed_mime, read_check, write_check, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (bucket) DO UPDATE
       SET visibility    = EXCLUDED.visibility,
           max_upload_mb = EXCLUDED.max_upload_mb,
           allowed_mime  = EXCLUDED.allowed_mime,
           read_check    = EXCLUDED.read_check,
           write_check   = EXCLUDED.write_check,
           updated_by    = EXCLUDED.updated_by,
           updated_at    = now()`,
    [
      policy.bucket,
      policy.visibility,
      policy.max_upload_mb,
      policy.allowed_mime,
      policy.read_check,
      policy.write_check,
      updatedBy,
    ],
  );
}

async function hasCheckColumns(): Promise<boolean> {
  const { rows } = await pool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM information_schema.columns
      WHERE table_schema = '_dashboard' AND table_name = 'bucket_policies'
        AND column_name IN ('read_check', 'write_check')`,
  );
  return (rows[0]?.n ?? 0) === 2;
}

// ─── Per-object authorization for private buckets (migration 0033) ──────────
//
// A private bucket may name a read_check / write_check: a SQL function in the
// public schema with the signature (p_bucket text, p_keys text[]) returns
// setof text. Before signing a URL for an authenticated end-user, the dashboard
// calls it through PostgREST WITH THAT USER'S JWT, so it runs as the user and
// every RLS policy on the tables it reads applies. It returns the subset of the
// requested keys the user may access. The app's own RLS is therefore the single
// source of truth for who may see a file — there is no second rule set to keep
// in step with it.
//
// Everything fails closed: an unknown or invalid function, a SECURITY DEFINER
// function (it would bypass the very RLS this relies on), a timeout, a non-2xx
// answer, or an answer containing keys that were never asked for — all mean
// "nobody gets anything".

export type CheckMode = "read" | "write";

export const CHECK_FUNCTION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const CHECK_TIMEOUT_MS = 5000;
const CHECK_VALIDATION_TTL_MS = 30_000;
const MAX_KEY_LENGTH = 1024;

// Object keys handed to a check function must already be in canonical form,
// otherwise "registrering/<id>/../<other-id>/x.jpg" would be authorized on the
// first id and served for the second. Returns null for anything that is not a
// plain, relative, slash-separated key — callers treat that as denied.
export function normalizeObjectKey(key: string): string | null {
  if (typeof key !== "string") return null;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  if (key.startsWith("/") || key.endsWith("/")) return null;
  if (key.includes("//") || key.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) return null;
  const segments = key.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return key;
}

// Why a function cannot be used as a check, or null when it can. Used both
// when an operator saves a policy and (cached briefly) before every decision,
// so a function altered to SECURITY DEFINER after it was configured stops
// being trusted on its own.
export async function checkFunctionProblem(name: string): Promise<string | null> {
  if (!CHECK_FUNCTION_NAME.test(name)) {
    return `"${name}" is not a valid function name (lowercase letters, digits, underscore)`;
  }
  const { rows } = await pool().query<{
    prosecdef: boolean;
    proretset: boolean;
    rettype: string;
    args: string;
  }>(
    `SELECT p.prosecdef, p.proretset,
            format_type(p.prorettype, NULL) AS rettype,
            pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  if (rows.length === 0) return `public.${name} does not exist`;
  if (rows.length > 1) return `public.${name} is overloaded; a check function must have exactly one signature`;
  const fn = rows[0];
  if (fn.args.replace(/\s+/g, " ").trim() !== "p_bucket text, p_keys text[]") {
    return `public.${name} must take (p_bucket text, p_keys text[]); it takes (${fn.args})`;
  }
  if (!fn.proretset || fn.rettype !== "text") {
    return `public.${name} must return setof text`;
  }
  if (fn.prosecdef) {
    return `public.${name} is SECURITY DEFINER, which would bypass RLS; it must be SECURITY INVOKER`;
  }
  return null;
}

const validationCache = new Map<string, { problem: string | null; at: number }>();

async function cachedCheckProblem(name: string): Promise<string | null> {
  const hit = validationCache.get(name);
  if (hit && Date.now() - hit.at < CHECK_VALIDATION_TTL_MS) return hit.problem;
  const problem = await checkFunctionProblem(name);
  validationCache.set(name, { problem, at: Date.now() });
  return problem;
}

// Calls the check through PostgREST as the end-user. Returns the keys it
// allowed; any failure is an empty set.
async function runCheck(
  fn: string,
  token: string,
  bucket: string,
  keys: string[],
): Promise<Set<string>> {
  const base = (process.env.POSTGREST_INTERNAL_URL ?? "http://postgrest:3000").replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rpc/${fn}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_bucket: bucket, p_keys: keys }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`storage check ${fn} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return new Set();
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return new Set();
    const asked = new Set(keys);
    const allowed = new Set<string>();
    for (const item of body) {
      // PostgREST returns setof text as a plain array of strings; tolerate the
      // object form ({ <fn>: "key" }) some versions produce.
      const value =
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? (Object.values(item as Record<string, unknown>)[0] as unknown)
            : null;
      if (typeof value !== "string") continue;
      // A key that was never asked about means the function is not doing what
      // it is supposed to. Do not trust any of its answer.
      if (!asked.has(value)) {
        console.error(`storage check ${fn} returned a key it was not asked about; denying all`);
        return new Set();
      }
      allowed.add(value);
    }
    return allowed;
  } catch (e) {
    console.error(`storage check ${fn} failed: ${(e as Error).message}`);
    return new Set();
  } finally {
    clearTimeout(timer);
  }
}

// The decision used by the public sign / sign-batch / upload routes. Returns
// the subset of `keys` the caller may access in `bucket`.
//   service_role  → all of them (trusted backend)
//   anon / other  → none
//   authenticated → public bucket: all (unchanged); private bucket: whatever
//                   the bucket's read_check / write_check allows, else none.
export async function authorizeKeys(args: {
  role: string | undefined;
  token: string;
  bucket: string;
  keys: string[];
  mode: CheckMode;
}): Promise<Set<string>> {
  const { role, token, bucket, keys, mode } = args;
  if (role === "service_role") return new Set(keys);
  if (role !== "authenticated") return new Set();

  const policy = await getBucketPolicy(bucket);
  if (policy.visibility === "public") return new Set(keys);

  const fn = mode === "read" ? policy.read_check : policy.write_check;
  if (!fn) return new Set();
  if (await cachedCheckProblem(fn)) return new Set();

  const valid = [...new Set(keys.map(normalizeObjectKey).filter((k): k is string => k !== null))];
  if (valid.length === 0) return new Set();
  return runCheck(fn, token, bucket, valid);
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
