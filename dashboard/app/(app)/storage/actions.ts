"use server";

import { Buffer } from "node:buffer";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { minio, publicObjectUrl, publicSignedObjectUrl } from "@/lib/minio";
import {
  FOLDER_PLACEHOLDER,
  getBucketPolicy,
  isValidSegment,
  mimeAllowed,
  normalizePrefix,
  publicReadPolicy,
  setBucketPolicy,
  type BucketPolicy,
  type Visibility,
} from "@/lib/storage";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";

// S3 bucket name rules: 3-63 chars, lowercase, digits, hyphens. Must begin
// and end with a letter or digit. We're stricter than S3 (no periods).
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

async function requireSession() {
  const s = await getSession();
  if (!s.userId) redirect("/login");
  return s;
}

async function requireWritable() {
  const s = await requireSession();
  if (s.role === "read_only") {
    throw new Error("Read-only users cannot modify storage");
  }
  return s;
}

async function requireAdmin() {
  const s = await requireSession();
  if (s.role !== "admin") {
    throw new Error("Admin only");
  }
  return s;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

// Builds the bucket-page URL, preserving the current folder via ?prefix= and
// tacking on any status params (error/ok). Used by every action that should
// land the user back in the folder they were working in.
function bucketHref(
  bucket: string,
  prefix: string,
  params: Record<string, string> = {},
): string {
  const sp = new URLSearchParams();
  if (prefix) sp.set("prefix", prefix);
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  const qs = sp.toString();
  return `/storage/${bucket}${qs ? `?${qs}` : ""}`;
}

// Recursively collects every object key under a prefix — used to delete a
// folder (S3 has no folder primitive, so we remove all keys beneath it).
function listAllKeys(bucket: string, prefix: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjectsV2(bucket, prefix, true);
    stream.on("data", (o) => {
      if (o.name) keys.push(o.name);
    });
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

export async function createBucket(formData: FormData) {
  const session = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const ip = await clientIp();

  if (!BUCKET_NAME.test(name)) {
    redirect("/storage?error=" + encodeURIComponent(
      "Bucket name must be 3-63 chars, lowercase letters/digits/hyphens, and start+end with a letter or digit",
    ));
  }

  let errMsg: string | null = null;
  try {
    await minio.makeBucket(name);
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.bucket.create",
    target: name,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: errMsg ? { error: errMsg } : {},
  });

  if (errMsg) {
    redirect("/storage?error=" + encodeURIComponent(errMsg));
  }
  revalidatePath("/storage", "layout");
  redirect(`/storage/${name}`);
}

export async function deleteBucket(formData: FormData) {
  const session = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const ip = await clientIp();

  let errMsg: string | null = null;
  try {
    await minio.removeBucket(name);
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.bucket.delete",
    target: name,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: errMsg ? { error: errMsg } : {},
  });

  if (errMsg) {
    redirect(`/storage/${name}?error=${encodeURIComponent(errMsg)}`);
  }
  revalidatePath("/storage", "layout");
  redirect("/storage");
}

export async function uploadObject(formData: FormData) {
  const session = await requireWritable();
  const bucket = String(formData.get("bucket") ?? "");
  const prefix = normalizePrefix(String(formData.get("prefix") ?? ""));
  const file = formData.get("file") as File | null;
  const ip = await clientIp();

  if (!file || file.size === 0) {
    redirect(bucketHref(bucket, prefix, { error: "No file selected" }));
  }

  // The browser may report a path-ish name (e.g. directory uploads); keep only
  // the basename and place it under the current folder prefix.
  const filename = file!.name.split(/[\\/]/).pop() || file!.name;
  const key = `${prefix}${filename}`;

  // Load policy and validate the file BEFORE streaming it to MinIO. Each
  // failed validation gets an audit row with the reason so attempts are
  // visible without scanning logs.
  const policy = await getBucketPolicy(bucket);
  const sizeMb = file!.size / (1024 * 1024);
  const contentType = file!.type || "application/octet-stream";

  let validationError: string | null = null;
  if (sizeMb > policy.max_upload_mb) {
    validationError = `File is ${sizeMb.toFixed(1)} MB; bucket allows up to ${policy.max_upload_mb} MB.`;
  } else if (!mimeAllowed(contentType, policy.allowed_mime)) {
    validationError = `Content type "${contentType}" is not allowed for this bucket.`;
  }

  if (validationError) {
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role: session.role!,
      action: "storage.object.upload",
      target: `${bucket}/${key}`,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: {
        bucket,
        name: key,
        size: file!.size,
        content_type: contentType,
        reason: "policy_violation",
        detail: validationError,
      },
    });
    redirect(bucketHref(bucket, prefix, { error: validationError }));
  }

  let errMsg: string | null = null;
  try {
    const buffer = Buffer.from(await file!.arrayBuffer());
    await minio.putObject(bucket, key, buffer, file!.size, {
      "Content-Type": contentType,
    });
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.object.upload",
    target: `${bucket}/${key}`,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      bucket,
      name: key,
      size: file?.size,
      content_type: contentType,
      ...(errMsg ? { error: errMsg } : {}),
    },
  });

  if (errMsg) {
    redirect(bucketHref(bucket, prefix, { error: errMsg }));
  }
  revalidatePath(`/storage/${bucket}`);
  redirect(bucketHref(bucket, prefix, { ok: `Uploaded ${filename}` }));
}

export async function createFolder(formData: FormData) {
  const session = await requireWritable();
  const bucket = String(formData.get("bucket") ?? "");
  const prefix = normalizePrefix(String(formData.get("prefix") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const ip = await clientIp();

  if (!isValidSegment(name)) {
    redirect(
      bucketHref(bucket, prefix, {
        error: "Folder name can't contain slashes or control characters",
      }),
    );
  }

  const folderPrefix = `${prefix}${name}/`;
  const key = `${folderPrefix}${FOLDER_PLACEHOLDER}`;

  let errMsg: string | null = null;
  try {
    // Zero-byte marker so the empty folder shows up in listings.
    await minio.putObject(bucket, key, Buffer.from(""), 0);
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.folder.create",
    target: `${bucket}/${folderPrefix}`,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: errMsg ? { error: errMsg } : { bucket, folder: folderPrefix },
  });

  if (errMsg) {
    redirect(bucketHref(bucket, prefix, { error: errMsg }));
  }
  revalidatePath(`/storage/${bucket}`);
  // Drop the user into the folder they just created.
  redirect(bucketHref(bucket, folderPrefix, { ok: `Created folder ${name}` }));
}

export async function deleteFolder(formData: FormData) {
  const session = await requireWritable();
  const bucket = String(formData.get("bucket") ?? "");
  // The folder to remove (full prefix from bucket root).
  const folder = normalizePrefix(String(formData.get("folder") ?? ""));
  // Where to land afterwards (the parent folder the user was viewing).
  const parent = normalizePrefix(String(formData.get("prefix") ?? ""));
  const ip = await clientIp();

  if (!folder) {
    redirect(bucketHref(bucket, parent, { error: "No folder specified" }));
  }

  let errMsg: string | null = null;
  let count = 0;
  try {
    const keys = await listAllKeys(bucket, folder);
    count = keys.length;
    if (keys.length > 0) await minio.removeObjects(bucket, keys);
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.folder.delete",
    target: `${bucket}/${folder}`,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { bucket, folder, objects: count, ...(errMsg ? { error: errMsg } : {}) },
  });

  if (errMsg) {
    redirect(bucketHref(bucket, parent, { error: errMsg }));
  }
  revalidatePath(`/storage/${bucket}`);
  redirect(
    bucketHref(bucket, parent, {
      ok: `Deleted folder (${count} object${count === 1 ? "" : "s"})`,
    }),
  );
}

export async function deleteObject(formData: FormData) {
  const session = await requireWritable();
  const bucket = String(formData.get("bucket") ?? "");
  const name = String(formData.get("name") ?? "");
  const prefix = normalizePrefix(String(formData.get("prefix") ?? ""));
  const ip = await clientIp();

  let errMsg: string | null = null;
  try {
    await minio.removeObject(bucket, name);
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.object.delete",
    target: `${bucket}/${name}`,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: errMsg ? { error: errMsg } : {},
  });

  if (errMsg) {
    redirect(bucketHref(bucket, prefix, { error: errMsg }));
  }
  revalidatePath(`/storage/${bucket}`);
  redirect(
    bucketHref(bucket, prefix, {
      ok: `Deleted ${name.split("/").pop() ?? name}`,
    }),
  );
}

// Admin-updates the dashboard-side policy AND mirrors it to MinIO. If the
// MinIO policy update fails, the DB write is kept (so the UI reflects the
// intent) and the user sees an error — usually it just needs MinIO to be
// reachable / the bucket to exist.
export async function updateBucketPolicy(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const bucket = String(formData.get("bucket") ?? "");
  const visibility = String(formData.get("visibility") ?? "private") as Visibility;
  const maxMb = Number(formData.get("max_upload_mb") ?? 25);
  const rawMime = String(formData.get("allowed_mime") ?? "").trim();
  const allowedMime = rawMime
    ? rawMime.split(/\s*,\s*/).filter((s) => s.length > 0)
    : null;

  if (!["public", "private"].includes(visibility)) {
    redirect(`/storage/${bucket}?error=${encodeURIComponent("Invalid visibility")}`);
  }
  if (!Number.isInteger(maxMb) || maxMb <= 0 || maxMb > 5000) {
    redirect(`/storage/${bucket}?error=${encodeURIComponent("Max MB must be a positive integer ≤ 5000")}`);
  }

  const policy: BucketPolicy = {
    bucket,
    visibility,
    max_upload_mb: maxMb,
    allowed_mime: allowedMime,
  };

  let errMsg: string | null = null;
  try {
    await setBucketPolicy(policy, session.userId ?? null);
    // Mirror visibility to MinIO. Caddy strips /storage/v1/object before
    // forwarding, so MinIO sees a plain path-style request and applies its
    // own bucket ACL. Public buckets get anonymous-read; private buckets
    // get the policy cleared (only valid SigV4 URLs work).
    if (visibility === "public") {
      await minio.setBucketPolicy(bucket, publicReadPolicy(bucket));
    } else {
      await minio.setBucketPolicy(bucket, "");
    }
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.bucket.policy",
    target: bucket,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      visibility,
      max_upload_mb: maxMb,
      allowed_mime: allowedMime,
      ...(errMsg ? { error: errMsg } : {}),
    },
  });

  if (errMsg) {
    redirect(`/storage/${bucket}?error=${encodeURIComponent(errMsg)}`);
  }
  revalidatePath(`/storage/${bucket}`);
  redirect(`/storage/${bucket}?ok=${encodeURIComponent("Policy updated")}`);
}

// Returns a sharable URL for the object. Both routes resolve under
// api.<host>/storage/v1/object/<bucket>/<key>:
//   - public  → no query string; MinIO's anonymous-read ACL serves it
//   - private → SigV4-signed; valid for `expirySeconds`
// Caddy strips /storage/v1/object before forwarding, so the path MinIO
// verifies the signature against matches what the SDK signed.
export async function getShareLink(
  bucket: string,
  name: string,
  expirySeconds = 3600,
): Promise<{ url: string; visibility: Visibility; expiresAt: string | null }> {
  const session = await requireSession();
  const ip = await clientIp();

  const policy = await getBucketPolicy(bucket);

  let url: string;
  let expiresAt: string | null = null;

  if (policy.visibility === "public") {
    url = publicObjectUrl(bucket, name);
  } else {
    url = await publicSignedObjectUrl("GET", bucket, name, expirySeconds);
    expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "storage.object.share",
    target: `${bucket}/${name}`,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      bucket,
      name,
      visibility: policy.visibility,
      expires_at: expiresAt,
    },
  });

  return { url, visibility: policy.visibility, expiresAt };
}
