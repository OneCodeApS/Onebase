"use client";

import { useRef } from "react";
import { createNewFunction } from "../actions";
import { useBackdropDismiss } from "../../../_components/useBackdropDismiss";

export function NewFunctionModal() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
      >
        + New function
      </button>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">New function</div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <form action={createNewFunction} className="space-y-4 px-5 py-4">
          <div>
            <label
              htmlFor="new-fn-name"
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Name
            </label>
            <input
              id="new-fn-name"
              type="text"
              name="name"
              autoFocus
              required
              placeholder="hello-world"
              pattern="[a-z][a-z0-9_-]{0,62}"
              title="Lowercase letters/digits/underscore/hyphen, starts with a letter"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Becomes the URL slug: /functions/v1/&lt;name&gt;.
            </p>
          </div>

          <div>
            <label
              htmlFor="new-fn-desc"
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Description (optional)
            </label>
            <input
              id="new-fn-desc"
              type="text"
              name="description"
              placeholder="What does this function do?"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
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
              Create
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
