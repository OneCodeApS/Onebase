"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmDeleteForm } from "../../_components/ConfirmDeleteForm";
import { deleteTable } from "../actions";

// Per-row kebab (⋮) menu shown on row hover. Just a "Delete" action, which
// opens the shared ConfirmDeleteForm dialog. Only rendered for admins on
// non-system schemas (see TablesSidebar), so it carries no extra auth itself —
// deleteTable re-checks admin server-side regardless.
//
// relkind ('r' table / 'v' view / 'm' materialized view) is forwarded to the
// server action so it can issue the matching DROP, and tunes the wording here.
const NOUN: Record<string, string> = {
  r: "table",
  v: "view",
  m: "materialized view",
};

export function TableRowMenu({
  schema,
  table,
  relkind,
}: {
  schema: string;
  table: string;
  relkind: string;
}) {
  const noun = NOUN[relkind] ?? "table";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Actions for ${noun} ${table}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 ${
          open
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50"
        >
          <ConfirmDeleteForm
            action={deleteTable}
            triggerLabel={`Delete ${noun}`}
            triggerClassName="block w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-neutral-800 hover:text-red-300"
            title={`Delete ${noun}?`}
            confirmLabel={`Drop ${noun}`}
            message={
              <>
                Permanently drop{" "}
                <span className="font-mono text-neutral-100">
                  {schema}.{table}
                </span>
                ? {relkind === "r" && "This deletes all of its rows and "}
                can&apos;t be undone. The drop fails if other objects (views,
                foreign keys) still depend on it — remove those first, or use the
                SQL editor for a deliberate{" "}
                <span className="font-mono">CASCADE</span>.
              </>
            }
          >
            <input type="hidden" name="schema" value={schema} />
            <input type="hidden" name="table" value={table} />
            <input type="hidden" name="kind" value={relkind} />
          </ConfirmDeleteForm>
        </div>
      )}
    </div>
  );
}
