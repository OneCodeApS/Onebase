import Link from "next/link";
import { notFound } from "next/navigation";
import { minio } from "@/lib/minio";
import { getSession } from "@/lib/session";
import { FOLDER_PLACEHOLDER, getBucketPolicy, normalizePrefix } from "@/lib/storage";
import { Card } from "../../_components/Card";
import { ConfirmDeleteForm } from "../../_components/ConfirmDeleteForm";
import { deleteBucket, uploadObject } from "../actions";
import { NewFolderForm } from "./_components/NewFolderForm";
import { ObjectList } from "./_components/ObjectList";
import { SettingsModal } from "./_components/SettingsModal";

const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

type ObjectEntry = {
  name: string;
  size: number;
  lastModified: Date;
  etag: string;
};

type Listing = { folders: string[]; files: ObjectEntry[] };

// Lists a single level (non-recursive) under `prefix`. MinIO returns the
// subfolders at this level as "common prefix" entries (obj.prefix) and the
// files as regular objects (obj.name). The zero-byte folder placeholder for
// the current folder is filtered out so it never shows as a file.
async function listLevel(bucket: string, prefix: string): Promise<Listing> {
  return new Promise((resolve, reject) => {
    const folders: string[] = [];
    const files: ObjectEntry[] = [];
    const stream = minio.listObjectsV2(bucket, prefix, false);
    stream.on("data", (obj) => {
      if (obj.prefix) {
        folders.push(obj.prefix);
      } else if (obj.name && obj.name !== `${prefix}${FOLDER_PLACEHOLDER}`) {
        files.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
        });
      }
    });
    stream.on("end", () => resolve({ folders, files }));
    stream.on("error", reject);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default async function BucketPage({
  params,
  searchParams,
}: {
  params: Promise<{ bucket: string }>;
  searchParams: Promise<{ error?: string; ok?: string; prefix?: string }>;
}) {
  const { bucket: rawBucket } = await params;
  const sp = await searchParams;
  const bucket = decodeURIComponent(rawBucket);

  if (!SAFE_BUCKET.test(bucket)) notFound();

  const prefix = normalizePrefix(sp.prefix);

  const session = await getSession();
  const canWrite = session.role !== "read_only";
  const isAdmin = session.role === "admin";

  let exists = true;
  try {
    exists = await minio.bucketExists(bucket);
  } catch {
    // Surface as not found rather than crashing the page.
    exists = false;
  }
  if (!exists) notFound();

  const [{ folders, files }, policy] = await Promise.all([
    listLevel(bucket, prefix),
    getBucketPolicy(bucket),
  ]);
  const totalSize = files.reduce((sum, o) => sum + o.size, 0);
  const atRoot = prefix === "";
  const isEmpty = folders.length === 0 && files.length === 0;

  // Breadcrumb: bucket root + one crumb per path segment, each linking to its
  // own cumulative prefix.
  const segments = atRoot ? [] : prefix.replace(/\/$/, "").split("/");
  const crumbs = segments.map((seg, i) => ({
    label: seg,
    href: `/storage/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(
      segments.slice(0, i + 1).join("/") + "/",
    )}`,
  }));

  return (
    <main className="px-6 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">
              <span className="font-mono">{bucket}</span>
            </h1>
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium ${
                policy.visibility === "public"
                  ? "border-amber-900/50 bg-amber-950/30 text-amber-300"
                  : "border-neutral-700 bg-neutral-800/40 text-neutral-300"
              }`}
              title={
                policy.visibility === "public"
                  ? "Anyone with a link can read every object"
                  : "Requires a signed share link or dashboard auth"
              }
            >
              {policy.visibility}
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            {folders.length > 0 && (
              <>
                {folders.length} {folders.length === 1 ? "folder" : "folders"} ·{" "}
              </>
            )}
            {files.length} {files.length === 1 ? "object" : "objects"} ·{" "}
            {formatSize(totalSize)} · max upload {policy.max_upload_mb} MB
            {policy.allowed_mime && policy.allowed_mime.length > 0 && (
              <> · allowed: {policy.allowed_mime.join(", ")}</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && <SettingsModal policy={policy} />}
          {isAdmin && atRoot && isEmpty && (
            <ConfirmDeleteForm
              action={deleteBucket}
              triggerLabel="Delete bucket"
              triggerClassName="rounded border border-red-900/50 px-3 py-1 text-sm text-red-300 hover:bg-red-950/40"
              title="Delete bucket?"
              confirmLabel="Delete bucket"
              message={
                <>
                  Delete the empty bucket{" "}
                  <span className="font-mono text-neutral-100">{bucket}</span>?
                  Its policy is removed too. This cannot be undone.
                </>
              }
            >
              <input type="hidden" name="name" value={bucket} />
            </ConfirmDeleteForm>
          )}
        </div>
      </div>

      {/* Folder breadcrumb */}
      <nav className="mt-4 flex flex-wrap items-center gap-1 text-sm">
        <Link
          href={`/storage/${encodeURIComponent(bucket)}`}
          className={`font-mono ${
            atRoot
              ? "text-neutral-300"
              : "text-neutral-400 hover:text-neutral-100 hover:underline"
          }`}
        >
          {bucket}
        </Link>
        {crumbs.map((c, i) => (
          <span key={c.href} className="flex items-center gap-1">
            <span className="text-neutral-600">/</span>
            {i === crumbs.length - 1 ? (
              <span className="font-mono text-neutral-300">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="font-mono text-neutral-400 hover:text-neutral-100 hover:underline"
              >
                {c.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {sp.error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {sp.error}
        </p>
      )}
      {sp.ok && (
        <p className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {sp.ok}
        </p>
      )}

      {canWrite && (
        <Card padded className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium">
              Upload
              {!atRoot && (
                <span className="ml-2 font-mono text-sm text-neutral-500">
                  → {prefix}
                </span>
              )}
            </h2>
            <NewFolderForm bucket={bucket} prefix={prefix} />
          </div>
          <form
            action={uploadObject}
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <input type="hidden" name="bucket" value={bucket} />
            <input type="hidden" name="prefix" value={prefix} />
            <input
              type="file"
              name="file"
              required
              className="block w-full text-sm text-neutral-300 file:mr-3 file:rounded file:border file:border-neutral-700 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
            />
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
            >
              Upload
            </button>
          </form>
        </Card>
      )}

      <Card className="mt-6 overflow-x-auto">
        <ObjectList
          bucket={bucket}
          prefix={prefix}
          folders={folders}
          files={files}
          canWrite={canWrite}
        />
      </Card>
    </main>
  );
}
