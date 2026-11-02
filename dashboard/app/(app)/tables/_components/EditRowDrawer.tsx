"use client";

import { useEffect, useState } from "react";
import { updateRow } from "../actions";

export type EditColumn = {
  column_name: string;
  data_type: string;
  is_nullable?: string; // 'YES' | 'NO'
  identity_generation?: string | null; // 'ALWAYS' | 'BY DEFAULT' | null
  is_generated?: string; // 'ALWAYS' | 'NEVER'
};

// What the server gave us for one cell: display text, whether it's a masked
// sensitive column, and -- when the value can be edited as text -- its editable
// form (null = SQL NULL; undefined = not editable here, e.g. arrays / bytea).
export type EditCell = { text: string; sensitive: boolean; edit?: string | null };

type Field = { value: string; isNull: boolean };

// Why a column has no editable field. null = editable.
function lockedReason(c: EditColumn, cell: EditCell, pkCol: string): string | null {
  if (c.column_name === pkCol) return "primary key";
  if (cell.sensitive) return "masked";
  if (c.is_generated === "ALWAYS") return "generated column";
  if (c.identity_generation === "ALWAYS") return "generated identity";
  if (cell.edit === undefined) return "not editable here — use the SQL editor";
  return null;
}

// Right-side drawer for editing one row. Every column shows its current value;
// locked ones are read-only with the reason underneath. Only fields that differ
// from what was loaded are posted, as `set:<col>` or `null:<col>`, so an
// untouched column is never rewritten. The server (updateRow) re-checks role,
// schema, the PK and which columns are updatable regardless of what we send.
export function EditRowDrawer({
  schema,
  table,
  pkCol,
  pkValue,
  columns,
  cells,
  onClose,
}: {
  schema: string;
  table: string;
  pkCol: string;
  pkValue: string;
  columns: EditColumn[];
  cells: EditCell[];
  onClose: () => void;
}) {
  const initial: Record<string, Field> = {};
  columns.forEach((c, i) => {
    const e = cells[i]?.edit;
    initial[c.column_name] = { value: e ?? "", isNull: e === null };
  });
  const [fields, setFields] = useState<Record<string, Field>>(initial);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set(col: string, patch: Partial<Field>) {
    setFields((prev) => ({ ...prev, [col]: { ...prev[col], ...patch } }));
  }

  const changed = columns.filter((c, i) => {
    if (lockedReason(c, cells[i], pkCol)) return false;
    const a = fields[c.column_name];
    const b = initial[c.column_name];
    return a.value !== b.value || a.isNull !== b.isNull;
  });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label="Edit row"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">Edit row</h2>
            <p className="mt-0.5 truncate text-sm text-neutral-500">
              <span className="font-mono">
                {schema}.{table}
              </span>{" "}
              where{" "}
              <span className="font-mono">
                {pkCol} = {pkValue}
              </span>
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94 4.28 3.22Z" />
            </svg>
          </button>
        </div>

        <form action={updateRow} className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <input type="hidden" name="schema" value={schema} />
          <input type="hidden" name="table" value={table} />
          <input type="hidden" name="pk" value={pkValue} />
          {/* Only the edited columns travel; the visible inputs below carry no name. */}
          {changed.map((c) =>
            fields[c.column_name].isNull ? (
              <input key={c.column_name} type="hidden" name={`null:${c.column_name}`} value="1" />
            ) : (
              <input
                key={c.column_name}
                type="hidden"
                name={`set:${c.column_name}`}
                value={fields[c.column_name].value}
              />
            ),
          )}

          {columns.map((c, i) => {
            const cell = cells[i];
            const locked = lockedReason(c, cell, pkCol);
            const f = fields[c.column_name];
            const dirty = changed.includes(c);
            return (
              <div key={c.column_name}>
                <div className="flex items-center justify-between">
                  <span className={`font-mono text-sm ${dirty ? "text-amber-200" : "text-neutral-300"}`}>
                    {c.column_name}
                  </span>
                  {!locked && c.is_nullable === "YES" && (
                    <label className="flex items-center gap-1 text-xs text-neutral-500">
                      <input
                        type="checkbox"
                        checked={f.isNull}
                        onChange={(e) => set(c.column_name, { isNull: e.target.checked })}
                        className="h-3 w-3 accent-neutral-500 [color-scheme:dark]"
                      />
                      NULL
                    </label>
                  )}
                </div>
                {locked ? (
                  <input
                    value={cell.text}
                    disabled
                    className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 font-mono text-sm text-neutral-500"
                  />
                ) : (
                  <input
                    value={f.isNull ? "" : f.value}
                    disabled={f.isNull}
                    placeholder={f.isNull ? "NULL" : ""}
                    onChange={(e) => set(c.column_name, { value: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500 disabled:text-neutral-500"
                  />
                )}
                <span className="mt-0.5 block text-xs text-neutral-500">
                  {c.data_type}
                  {locked && ` · ${locked}`}
                </span>
              </div>
            );
          })}

          <p className="text-xs text-neutral-500">
            Values are cast to each column&apos;s type by Postgres; a bad value is reported
            above the table. Untouched columns are left as they are.
          </p>

          <div className="mt-auto flex items-center justify-end gap-2 pt-2">
            <span className="mr-auto text-xs text-neutral-500">
              {changed.length === 0
                ? "No changes"
                : `${changed.length} ${changed.length === 1 ? "field" : "fields"} changed`}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={changed.length === 0}
              className="rounded bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
