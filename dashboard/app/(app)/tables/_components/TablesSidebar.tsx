"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TableRowMenu } from "./TableRowMenu";

export type TableEntry = {
  schema: string;
  table_name: string;
  approx_rows: number;
  rls_enabled: boolean;
};

const DEFAULT_SCHEMA = "public";

// Schemas whose tables have hand-built UIs that enforce invariants (audit-log
// hash chain, AES-GCM-encrypted env vars, Argon2id password hashing, scheduler
// re-registration). Hidden from the picker by default; admins can opt in via
// the "Show system schemas" toggle. SQL editor remains an unrestricted escape
// hatch as in Supabase Studio.
const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

const SHOW_SYSTEM_KEY = "tables.showSystemSchemas";

export function TablesSidebar({
  tables,
  canViewSystemSchemas,
  isAdmin,
}: {
  tables: TableEntry[];
  canViewSystemSchemas: boolean;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState("");
  const [showSystem, setShowSystem] = useState(false);

  // Restore the toggle from localStorage on mount. Kept off the first paint to
  // avoid an SSR/CSR mismatch — the picker just renders without system schemas
  // for one frame, then re-renders if the user had it on. read_only users
  // can't see system schemas at all (filtered server-side too), so the
  // restored value is ignored for them.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!canViewSystemSchemas) return;
    setShowSystem(window.localStorage.getItem(SHOW_SYSTEM_KEY) === "1");
  }, [canViewSystemSchemas]);

  function toggleSystem(next: boolean) {
    setShowSystem(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SHOW_SYSTEM_KEY, next ? "1" : "0");
    }
    // If the user just hid system schemas while sitting on one, bounce back to
    // public so they don't stare at an invisible-but-active selection.
    const current = searchParams.get("schema") ?? DEFAULT_SCHEMA;
    if (!next && SYSTEM_SCHEMAS.has(current)) {
      router.push("/tables");
    }
  }

  // Available schemas come from whichever schemas have tables (no point
  // listing an empty schema in the picker). Sorted with `public` first.
  const schemas = useMemo(() => {
    const set = new Set(tables.map((t) => t.schema));
    const arr = Array.from(set).filter(
      (s) => showSystem || !SYSTEM_SCHEMAS.has(s),
    );
    arr.sort((a, b) => {
      if (a === DEFAULT_SCHEMA) return -1;
      if (b === DEFAULT_SCHEMA) return 1;
      return a.localeCompare(b);
    });
    return arr;
  }, [tables, showSystem]);

  const activeSchema = searchParams.get("schema") ?? DEFAULT_SCHEMA;
  const activeIsSystem = SYSTEM_SCHEMAS.has(activeSchema);

  const filteredTables = useMemo(() => {
    let result = tables.filter((t) => t.schema === activeSchema);
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter((t) => t.table_name.toLowerCase().includes(q));
    }
    return result;
  }, [tables, activeSchema, filter]);

  function pickSchema(s: string) {
    const params = new URLSearchParams(searchParams);
    if (s === DEFAULT_SCHEMA) params.delete("schema");
    else params.set("schema", s);
    // Always send the user to the /tables index when switching schemas —
    // the currently-open table doesn't necessarily exist in the new schema.
    const qs = params.toString();
    router.push(qs ? `/tables?${qs}` : "/tables");
  }

  function tableHref(t: TableEntry): string {
    const params = new URLSearchParams();
    if (t.schema !== DEFAULT_SCHEMA) params.set("schema", t.schema);
    const qs = params.toString();
    return qs
      ? `/tables/${encodeURIComponent(t.table_name)}?${qs}`
      : `/tables/${encodeURIComponent(t.table_name)}`;
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-3">
        <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Schema
        </div>
        <select
          value={activeSchema}
          onChange={(e) => pickSchema(e.target.value)}
          className="mt-2 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-neutral-500 focus:outline-none"
        >
          {schemas.length === 0 ? (
            <option value={DEFAULT_SCHEMA}>{DEFAULT_SCHEMA}</option>
          ) : (
            schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))
          )}
        </select>

        {canViewSystemSchemas && (
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-neutral-400 hover:text-neutral-200">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => toggleSystem(e.target.checked)}
              className="h-3 w-3 cursor-pointer accent-neutral-500"
            />
            Show system schemas
          </label>
        )}

        {activeIsSystem && (
          <div
            className="mt-2 rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300"
            title="System schemas enforce invariants (audit hash chain, encrypted env vars, password hashing). Use the dedicated admin pages to modify rows safely."
          >
            Read-only · use the admin UI
          </div>
        )}

        <div className="mt-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Tables
        </div>
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mt-2 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-500 focus:border-neutral-500 focus:outline-none"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {filteredTables.length === 0 ? (
          <p className="px-2 py-2 text-xs text-neutral-500">
            {filter ? "No matches." : "No tables in this schema."}
          </p>
        ) : (
          filteredTables.map((t) => {
            const href = tableHref(t);
            // Active state: pathname matches AND schema query matches.
            const pathnameMatches =
              pathname === `/tables/${encodeURIComponent(t.table_name)}`;
            const schemaMatches =
              (searchParams.get("schema") ?? DEFAULT_SCHEMA) === t.schema;
            const isActive = pathnameMatches && schemaMatches;
            // Only admins can drop tables, and never the platform-managed
            // system schemas (deleteTable refuses those server-side too).
            const canDelete = isAdmin && !SYSTEM_SCHEMAS.has(t.schema);
            // RLS off on a non-system (API-exposed) table = effectively public.
            const isPublic = !SYSTEM_SCHEMAS.has(t.schema) && !t.rls_enabled;
            return (
              <div
                key={`${t.schema}.${t.table_name}`}
                className={`group relative flex items-center rounded ${
                  isActive ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
              >
                <Link
                  href={href}
                  className={`flex min-w-0 flex-1 items-center justify-between px-2 py-1.5 text-sm ${
                    isActive
                      ? "text-neutral-100"
                      : "text-neutral-400 group-hover:text-neutral-100"
                  }`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate font-mono">{t.table_name}</span>
                    {isPublic && (
                      <span
                        title="Public — Row Level Security is off; rows are exposed through the API to any role you grant access"
                        aria-label="Public: Row Level Security off"
                        className="shrink-0 text-[10px] leading-none text-amber-500"
                      >
                        ●
                      </span>
                    )}
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-neutral-500">
                    {t.approx_rows < 0 ? "" : t.approx_rows.toLocaleString()}
                  </span>
                </Link>
                {canDelete && (
                  <div className="pr-1">
                    <TableRowMenu schema={t.schema} table={t.table_name} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>
    </aside>
  );
}
