"use client";

import { useRef } from "react";
import type { BucketPolicy } from "@/lib/storage";
import { updateBucketPolicy } from "../../actions";
import { useBackdropDismiss } from "../../../_components/useBackdropDismiss";

// Uses the native <dialog> element — gets backdrop, Escape to close, focus
// trap, and click-outside dismissal "for free" without a UI lib dependency.
export function SettingsModal({ policy }: { policy: BucketPolicy }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const allowedMimeText = policy.allowed_mime?.join(", ") ?? "";

  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
      >
        Settings
      </button>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-lg rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">
            Settings · <span className="font-mono text-neutral-300">{policy.bucket}</span>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <form action={updateBucketPolicy} className="space-y-5 px-5 py-4">
          <input type="hidden" name="bucket" value={policy.bucket} />

          <div>
            <label className="block text-sm font-medium text-neutral-200">
              Visibility
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Public buckets serve every object via direct URL. Private buckets
              require a short-lived share link or the dashboard download.
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
            <label
              htmlFor="max_upload_mb"
              className="block text-sm font-medium text-neutral-200"
            >
              Max upload size (MB)
            </label>
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
            <label
              htmlFor="allowed_mime"
              className="block text-sm font-medium text-neutral-200"
            >
              Allowed MIME types
            </label>
            <p className="mt-0.5 text-xs text-neutral-500">
              Comma-separated. Supports wildcards like{" "}
              <span className="font-mono">image/*</span>. Empty = allow any.
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

          <div className="flex justify-end gap-2 border-t border-neutral-800 pt-4">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
            >
              Save
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
