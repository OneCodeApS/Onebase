import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getBucketPolicy } from "@/lib/storage";
import { Card } from "../../../_components/Card";
import { updateBucketPolicy } from "../../actions";

const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export default async function BucketSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ bucket: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { bucket: rawBucket } = await params;
  const sp = await searchParams;
  const bucket = decodeURIComponent(rawBucket);

  if (!SAFE_BUCKET.test(bucket)) notFound();

  const session = await getSession();
  if (session.role !== "admin") {
    notFound();
  }

  const policy = await getBucketPolicy(bucket);
  const allowedMimeText = policy.allowed_mime?.join(", ") ?? "";

  return (
    <main className="px-6 py-10">
      <Link
        href={`/storage/${encodeURIComponent(bucket)}`}
        className="text-sm text-neutral-400 hover:text-neutral-100"
      >
        ← <span className="font-mono">{bucket}</span>
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Bucket settings</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Policies for <span className="font-mono">{bucket}</span>. Visibility is
        also mirrored to MinIO (public = anonymous GET enabled).
      </p>

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

      <Card padded className="mt-6 max-w-2xl">
        <form action={updateBucketPolicy} className="space-y-5">
          <input type="hidden" name="bucket" value={bucket} />

          <div>
            <label className="block text-sm font-medium text-neutral-200">
              Visibility
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Public buckets serve every object via direct URL. Private buckets
              require a short-lived share link (or the dashboard's authenticated
              streaming download).
            </p>
            <div className="mt-2 flex gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  value="private"
                  defaultChecked={policy.visibility === "private"}
                />
                Private
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  defaultChecked={policy.visibility === "public"}
                />
                Public
              </label>
            </div>
          </div>

          <div>
            <label htmlFor="max_upload_mb" className="block text-sm font-medium text-neutral-200">
              Max upload size (MB)
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Per-file cap. Applies to uploads through the dashboard.
            </p>
            <input
              id="max_upload_mb"
              type="number"
              name="max_upload_mb"
              min={1}
              max={5000}
              required
              defaultValue={policy.max_upload_mb}
              className="mt-2 w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            />
          </div>

          <div>
            <label htmlFor="allowed_mime" className="block text-sm font-medium text-neutral-200">
              Allowed MIME types
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Comma-separated. Supports wildcards like{" "}
              <span className="font-mono">image/*</span>. Leave empty to allow
              any file type.
            </p>
            <input
              id="allowed_mime"
              type="text"
              name="allowed_mime"
              defaultValue={allowedMimeText}
              placeholder="image/*, application/pdf, text/plain"
              className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
          </div>

          <div>
            <label htmlFor="read_check" className="block text-sm font-medium text-neutral-200">
              Read check (private buckets)
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Name of a{" "}
              <span className="font-mono">public.fn(p_bucket text, p_keys text[]) returns setof text</span>.
              Before signing a download URL for an end-user, the dashboard calls it through
              PostgREST with that user&apos;s token, so it runs as the user and your RLS
              decides which keys come back. Must not be SECURITY DEFINER. Leave empty to keep
              the bucket service_role only.
            </p>
            <input
              id="read_check"
              type="text"
              name="read_check"
              defaultValue={policy.read_check ?? ""}
              placeholder="storage_can_read_my_bucket"
              className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
          </div>

          <div>
            <label htmlFor="write_check" className="block text-sm font-medium text-neutral-200">
              Write check (private buckets)
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Same contract, consulted before an upload URL is issued. Leave empty to keep
              uploads service_role only.
            </p>
            <input
              id="write_check"
              type="text"
              name="write_check"
              defaultValue={policy.write_check ?? ""}
              placeholder="storage_can_write_my_bucket"
              className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
            >
              Save
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}
