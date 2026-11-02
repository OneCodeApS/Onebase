"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card } from "../../_components/Card";
import { ConfirmDeleteForm } from "../../_components/ConfirmDeleteForm";
import { deleteRows } from "../actions";
import { EditRowDrawer, type EditCell, type EditColumn } from "./EditRowDrawer";

// One rendered row: the server has already turned every value into display
// text (and masked the sensitive ones). `edit` is the editable text form of the
// value for the Edit drawer (null = SQL NULL; absent = not editable here).
// `key` is the primary-key value as a string, or null when the table has no
// single-column PK (then rows can't be selected, deleted or edited).
export type DataRow = {
  key: string | null;
  cells: EditCell[];
};

// The Data-tab grid. Client-side only for row selection: tick rows (or the
// header box for all on this page) and a bar appears with "Delete n rows"
// (posts the selected keys to deleteRows through the shared confirm dialog)
// and, for exactly one row, "Edit"; double-clicking a row opens the EditRowDrawer
// directly. Role / schema /
// PK gating is the caller's (canMutate); the actions re-check everything.
export function DataTable({
  schema,
  table,
  pkCol,
  columns,
  rows,
  canMutate,
  addColumn,
}: {
  schema: string;
  table: string;
  pkCol: string | null;
  columns: EditColumn[];
  rows: DataRow[];
  canMutate: boolean;
  // The "+" Add-column header cell, rendered by the server page when allowed.
  addColumn: ReactNode | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // `rows` is a new array whenever the server re-renders (after a save, a
  // delete, paging...), and referentially stable across client-only updates.
  // Close the drawer on fresh data so it never shows stale values.
  useEffect(() => {
    setEditingKey(null);
  }, [rows]);

  // Only keys still on screen count: after a delete the page re-renders without
  // those rows, so a stale selection silently shrinks instead of lingering.
  const visibleKeys = rows.map((r) => r.key).filter((k): k is string => k !== null);
  const selectedVisible = visibleKeys.filter((k) => selected.has(k));
  const allSelected = visibleKeys.length > 0 && selectedVisible.length === visibleKeys.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;

  const headerBox = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleKeys));
  }

  const extraCols = (canMutate ? 1 : 0) + (addColumn ? 1 : 0);
  const n = selectedVisible.length;
  const editingRow = editingKey === null ? null : (rows.find((r) => r.key === editingKey) ?? null);

  return (
    <>
      {canMutate && n > 0 && (
        <div className="mt-3 flex items-center gap-3 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm">
          <span className="text-neutral-300">
            {n} {n === 1 ? "row" : "rows"} selected
          </span>
          <ConfirmDeleteForm
            action={deleteRows}
            triggerLabel={`Delete ${n} ${n === 1 ? "row" : "rows"}`}
            triggerClassName="rounded border border-red-900/50 bg-red-950/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-900/40"
            title="Delete rows?"
            message={
              <>
                Delete {n} {n === 1 ? "row" : "rows"} from{" "}
                <span className="font-mono text-neutral-100">
                  {schema}.{table}
                </span>
                ? This cannot be undone.
              </>
            }
          >
            <input type="hidden" name="schema" value={schema} />
            <input type="hidden" name="table" value={table} />
            {selectedVisible.map((k) => (
              <input key={k} type="hidden" name="pk" value={k} />
            ))}
          </ConfirmDeleteForm>
          {/* Edit sits at the far end, away from Delete, so a reach for one
              can't land on the other. Double-clicking a row opens it too. */}
          <div className="ml-auto flex items-center gap-3">
            {n === 1 && (
              <button
                type="button"
                onClick={() => setEditingKey(selectedVisible[0])}
                className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs text-neutral-500 hover:text-neutral-200"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {canMutate && pkCol && editingRow && editingRow.key !== null && (
        <EditRowDrawer
          key={editingRow.key}
          schema={schema}
          table={table}
          pkCol={pkCol}
          pkValue={editingRow.key}
          columns={columns}
          cells={editingRow.cells}
          onClose={() => setEditingKey(null)}
        />
      )}

      <Card className="mt-3 min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="sticky top-0 z-10 border-b border-neutral-700 bg-neutral-800 text-left text-neutral-400">
              {canMutate && (
                <th className="w-8 px-2 py-2 align-middle">
                  <input
                    ref={headerBox}
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={visibleKeys.length === 0}
                    className="h-3.5 w-3.5 cursor-pointer accent-neutral-500 [color-scheme:dark]"
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.column_name} className="px-3 py-2 font-normal">
                  <div className="font-mono text-neutral-100">{c.column_name}</div>
                  <div className="text-xs text-neutral-500">{c.data_type}</div>
                </th>
              ))}
              {addColumn && (
                <th className="w-10 px-2 py-2 align-middle font-normal">{addColumn}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + extraCols}
                  className="px-3 py-6 text-center text-neutral-500"
                >
                  No rows.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const isSelected = row.key !== null && selected.has(row.key);
                return (
                  <tr
                    key={row.key ?? i}
                    onDoubleClick={() => {
                      if (canMutate && row.key !== null) setEditingKey(row.key);
                    }}
                    title={canMutate && row.key !== null ? "Double-click to edit" : undefined}
                    className={`border-b border-neutral-800 last:border-b-0 hover:bg-neutral-800/50 ${
                      isSelected ? "bg-neutral-800/70" : "odd:bg-neutral-900 even:bg-neutral-950/40"
                    }`}
                  >
                    {canMutate && (
                      <td className="w-8 px-2 py-2 align-middle">
                        {row.key !== null && (
                          <input
                            type="checkbox"
                            aria-label="Select row"
                            checked={isSelected}
                            onChange={() => toggle(row.key as string)}
                            className="h-3.5 w-3.5 cursor-pointer accent-neutral-500 [color-scheme:dark]"
                          />
                        )}
                      </td>
                    )}
                    {row.cells.map((cell, ci) => (
                      <td
                        key={columns[ci]?.column_name ?? ci}
                        className={`max-w-xs truncate px-3 py-2 font-mono ${
                          cell.sensitive ? "text-neutral-500" : "text-neutral-300"
                        }`}
                        // Don't put the real value in a title= attribute for
                        // sensitive cells — that would re-expose it on hover.
                        title={cell.sensitive ? "masked" : cell.text}
                      >
                        {cell.text}
                      </td>
                    ))}
                    {addColumn && <td className="w-10 px-2 py-2" aria-hidden="true" />}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
