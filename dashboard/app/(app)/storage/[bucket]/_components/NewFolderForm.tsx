"use client";

import { useState } from "react";
import { createFolder } from "../../actions";

// Inline "New folder" affordance. Collapsed to a button until clicked, then a
// small form that posts to the createFolder server action. The folder is
// materialised as a zero-byte placeholder object under the current prefix.
export function NewFolderForm({
  bucket,
  prefix,
}: {
  bucket: string;
  prefix: string;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
      >
        New folder
      </button>
    );
  }

  return (
    <form action={createFolder} className="flex items-center gap-2">
      <input type="hidden" name="bucket" value={bucket} />
      <input type="hidden" name="prefix" value={prefix} />
      <input
        type="text"
        name="name"
        autoFocus
        required
        placeholder="folder-name"
        title="No slashes or control characters"
        className="w-44 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
      />
      <button
        type="submit"
        className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
      >
        Create
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
      >
        Cancel
      </button>
    </form>
  );
}
