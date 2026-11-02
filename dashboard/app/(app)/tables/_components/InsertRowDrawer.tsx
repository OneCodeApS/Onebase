"use client";

import { useEffect, useState } from "react";
import { insertRow } from "../actions";

// Column metadata straight from information_schema.columns (see loadColumns in
// [name]/page.tsx). Structural, so the page's own Column type satisfies it.
type InsertColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string; // 'YES' | 'NO'
  column_default: string | null;
  is_identity: string; // 'YES' | 'NO'
  identity_generation: string | null; // 'ALWAYS' | 'BY DEFAULT' | null
  is_generated: string; // 'ALWAYS' | 'NEVER'
};

// Columns the user can't (or needn't) supply: generated columns and
// GENERATED ALWAYS AS IDENTITY reject explicit values, so they get no field.
// The server applies the same rule to whatever comes back in the form.
function isInsertable(c: InsertColumn): boolean {
  return c.is_generated !== "ALWAYS" && c.identity_generation !== "ALWAYS";
}

function isRequired(c: InsertColumn): boolean {
  return c.is_nullable === "NO" && c.column_default === null && c.is_identity === "NO";
}

function hint(c: InsertColumn): string {
  if (isRequired(c)) return `${c.data_type} · required`;
  if (c.column_default !== null) return `${c.data_type} · default ${c.column_default}`;
  return `${c.data_type} · NULL if blank`;
}

// "+ Insert row" button in the table header, plus the right-side drawer it
// opens with one field per column. Role / schema / relkind gating is done by
// the caller (the button only renders when allowed); insertRow re-checks all
// of it server-side regardless. On submit the action redirects back with an
// ?ok / ?error banner, which tears this client subtree down — so no manual close.
export function InsertRowDrawer({
  schema,
  table,
  columns,
}: {
  schema: string;
  table: string;
  columns: InsertColumn[];
}) {
  const [open, setOpen] = useState(false);
  const fields = columns.filter(isInsertable);

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
        onClick={() => setOpen(true)}
        className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
      >
        + Insert row
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
            aria-label="Insert row"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/50"
          >
            <div className="flex items-start justify-between border-b border-neutral-800 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-neutral-100">Insert row</h2>
                <p className="mt-0.5 text-sm text-neutral-500">
                  into <span className="font-mono">{schema}.{table}</span>
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

            <form action={insertRow} className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
              <input type="hidden" name="schema" value={schema} />
              <input type="hidden" name="table" value={table} />

              {fields.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  Every column is generated, so the row takes its defaults.
                </p>
              ) : (
                fields.map((c, i) => (
                  <label key={c.column_name} className="block">
                    <span className="font-mono text-sm text-neutral-300">{c.column_name}</span>
                    <input
                      name={`col:${c.column_name}`}
                      required={isRequired(c)}
                      autoFocus={i === 0}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={c.column_default ?? (c.is_nullable === "YES" ? "NULL" : "")}
                      className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-700 focus:border-neutral-500"
                    />
                    <span className="mt-0.5 block text-xs text-neutral-500">{hint(c)}</span>
                  </label>
                ))
              )}

              <p className="text-xs text-neutral-500">
                Values are cast to each column&apos;s type by Postgres; a bad value is
                reported above the table. Leave a field blank to use its default.
              </p>

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
                  Insert row
                </button>
              </div>
            </form>
          </aside>
        </>
      )}
    </>
  );
}
