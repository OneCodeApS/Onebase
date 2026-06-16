"use client";

import { useEffect, useState } from "react";
import { addColumn } from "../actions";

// Must mirror COLUMN_TYPES in ../actions.ts — the server re-validates against
// that allow-list, so an out-of-list value is rejected there regardless.
const TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "timestamptz",
  "date",
  "uuid",
  "numeric",
  "jsonb",
] as const;

// The "+" header cell in the Data tab, plus the right-side drawer it opens for
// adding a column. Admin-only / non-system / real-table gating is done by the
// caller (the column only renders when allowed); the addColumn server action
// re-checks server-side regardless. On submit the action redirects back with an
// ?ok / ?error banner, which tears this client subtree down — so no manual close.
export function AddColumnDrawer({ schema, table }: { schema: string; table: string }) {
  const [open, setOpen] = useState(false);
  const [notNull, setNotNull] = useState(false);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Add column"
        title="Add column"
        onClick={() => setOpen(true)}
        className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M8 2.5a.75.75 0 0 1 .75.75v4h4a.75.75 0 0 1 0 1.5h-4v4a.75.75 0 0 1-1.5 0v-4h-4a.75.75 0 0 1 0-1.5h4v-4A.75.75 0 0 1 8 2.5Z" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Drawer */}
          <aside
            role="dialog"
            aria-label="Add column"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/50"
          >
            <div className="flex items-start justify-between border-b border-neutral-800 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-neutral-100">Add column</h2>
                <p className="mt-0.5 text-sm text-neutral-500">
                  to <span className="font-mono">{schema}.{table}</span>
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94 4.28 3.22Z" />
                </svg>
              </button>
            </div>

            <form action={addColumn} className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
              <input type="hidden" name="schema" value={schema} />
              <input type="hidden" name="table" value={table} />

              <label className="block">
                <span className="text-sm text-neutral-300">Name</span>
                <input
                  name="column"
                  required
                  autoFocus
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  title="Letters, digits and underscores; must not start with a digit."
                  placeholder="e.g. notes"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-neutral-500"
                />
              </label>

              <label className="block">
                <span className="text-sm text-neutral-300">Type</span>
                <select
                  name="type"
                  defaultValue="text"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-neutral-500"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="not_null"
                  checked={notNull}
                  onChange={(e) => setNotNull(e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
                />
                <span className="text-sm text-neutral-300">NOT NULL</span>
              </label>
              {notNull && (
                <p className="-mt-2 text-xs text-amber-300/80">
                  Only works on an empty table — existing rows can&apos;t be left
                  without a value. For a populated table, add a default via the SQL
                  editor.
                </p>
              )}

              <div className="mt-auto flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                >
                  Add column
                </button>
              </div>
            </form>
          </aside>
        </>
      )}
    </>
  );
}
