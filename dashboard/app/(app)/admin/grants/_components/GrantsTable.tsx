"use client";

import { useMemo, useState } from "react";
import type { TableGrantsRow } from "@/lib/db-introspect";
import { Card } from "../../../_components/Card";

// The roles PostgREST connects as — worth highlighting, since their grants are
// exactly what's reachable over the public REST API.
const API_ROLES = new Set(["anon", "authenticated", "service_role"]);

function kindBadge(kind: string): string | null {
  switch (kind) {
    case "view":
      return "view";
    case "materialized view":
      return "matview";
    case "partitioned table":
      return "partitioned";
    default:
      return null; // plain table — no badge
  }
}

// Client-side filter over the grants already loaded for this schema. Matches the
// object name or any grantee (role) name, so you can find "which objects can
// anon touch?" by typing the role.
export function GrantsTable({
  tables,
  selectedSchema,
}: {
  tables: TableGrantsRow[];
  selectedSchema: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        t.table.toLowerCase().includes(q) ||
        t.grants.some((g) => g.grantee.toLowerCase().includes(q)),
    );
  }, [tables, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter grants… (object or role)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {tables.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Object</th>
              <th className="px-3 py-2 font-normal">Owner</th>
              <th className="px-3 py-2 font-normal">Grants</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-neutral-500">
                  {tables.length === 0 ? (
                    <>
                      No tables or views in{" "}
                      <span className="font-mono">{selectedSchema}</span>.
                    </>
                  ) : (
                    "No objects match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const badge = kindBadge(t.kind);
                return (
                  <tr
                    key={`${t.schema}.${t.table}`}
                    className="border-b border-neutral-800 align-top last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-200">
                      {t.table}
                      {badge && (
                        <span
                          className="ml-2 rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400"
                          title={`Postgres ${t.kind}`}
                        >
                          {badge}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">
                      {t.owner}
                    </td>
                    <td className="px-3 py-2">
                      {t.grants.length === 0 ? (
                        <span className="text-xs text-neutral-600">
                          owner only — no grants
                        </span>
                      ) : (
                        <ul className="space-y-1">
                          {t.grants.map((g) => (
                            <li
                              key={g.grantee}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                            >
                              <span
                                className={`min-w-[8rem] font-mono text-xs ${
                                  g.grantee === "PUBLIC"
                                    ? "text-amber-400"
                                    : API_ROLES.has(g.grantee)
                                      ? "text-sky-300"
                                      : "text-neutral-300"
                                }`}
                                title={
                                  g.grantee === "PUBLIC"
                                    ? "Every role, including unauthenticated"
                                    : undefined
                                }
                              >
                                {g.grantee}
                              </span>
                              <span className="flex flex-wrap gap-1">
                                {g.privileges.map((p) => {
                                  const grantable = g.grantable.includes(p);
                                  return (
                                    <span
                                      key={p}
                                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                                        grantable
                                          ? "border border-amber-700/60 bg-amber-950/30 text-amber-300"
                                          : "bg-neutral-800 text-neutral-300"
                                      }`}
                                      title={
                                        grantable ? "WITH GRANT OPTION" : undefined
                                      }
                                    >
                                      {p}
                                      {grantable ? " *" : ""}
                                    </span>
                                  );
                                })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
