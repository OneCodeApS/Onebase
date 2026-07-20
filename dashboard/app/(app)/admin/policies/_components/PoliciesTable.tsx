"use client";

import { useMemo, useState } from "react";
import type { PolicyRow, TableRlsStatus } from "@/lib/db-introspect";
import { Card } from "../../../_components/Card";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { deletePolicy } from "../actions";
import { PolicyModal } from "./PolicyModal";

// Client-side filter over the policies already loaded for this schema. Matches
// the table name, the policy name, or any role the policy applies to.
export function PoliciesTable({
  policies,
  tableStatus,
  roles,
  allTables,
  selectedSchema,
  isAdmin,
}: {
  policies: PolicyRow[];
  tableStatus: TableRlsStatus[];
  roles: string[];
  allTables: { schema: string; table: string }[];
  selectedSchema: string;
  isAdmin: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter(
      (p) =>
        p.table.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.roles.some((r) => r.toLowerCase().includes(q)),
    );
  }, [policies, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter policies… (table, policy, role)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {policies.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Table</th>
              <th className="px-3 py-2 font-normal">Policy</th>
              <th className="px-3 py-2 font-normal">Cmd</th>
              <th className="px-3 py-2 font-normal">Kind</th>
              <th className="px-3 py-2 font-normal">Roles</th>
              <th className="px-3 py-2 font-normal">USING</th>
              <th className="px-3 py-2 font-normal">WITH CHECK</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  {policies.length === 0 ? (
                    <>
                      No policies in{" "}
                      <span className="font-mono">{selectedSchema}</span>.
                    </>
                  ) : (
                    "No policies match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((p) => {
                const status = tableStatus.find(
                  (t) => t.schema === p.schema && t.table === p.table,
                );
                return (
                  <tr
                    key={`${p.schema}.${p.table}.${p.name}`}
                    className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-200">
                      {p.schema}.{p.table}
                      {status && !status.rls_enabled && (
                        <span
                          className="ml-2 rounded border border-amber-900/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] uppercase text-amber-300"
                          title="RLS not enabled — this policy is inert"
                        >
                          inert
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-300">
                      {p.name}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-300">
                      {p.cmd}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
                      {p.permissive === "PERMISSIVE" ? "permissive" : "restrictive"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-400">
                      {p.roles.join(", ")}
                    </td>
                    <td
                      className="max-w-[20ch] truncate px-3 py-2 font-mono text-xs text-neutral-400"
                      title={p.using_expr ?? ""}
                    >
                      {p.using_expr ?? "—"}
                    </td>
                    <td
                      className="max-w-[20ch] truncate px-3 py-2 font-mono text-xs text-neutral-400"
                      title={p.check_expr ?? ""}
                    >
                      {p.check_expr ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {isAdmin && (
                        <div className="flex justify-end gap-3">
                          <PolicyModal
                            tables={allTables}
                            roleOptions={roles}
                            initial={p}
                            trigger={
                              <button
                                type="button"
                                className="text-xs text-neutral-400 underline hover:text-neutral-100"
                              >
                                Edit
                              </button>
                            }
                          />
                          <ConfirmDeleteForm
                            action={deletePolicy}
                            triggerLabel="Delete"
                            triggerClassName="text-xs text-red-400 underline hover:text-red-200"
                            title="Delete policy?"
                            message={
                              <>
                                Delete policy{" "}
                                <span className="font-mono text-neutral-100">
                                  {p.name}
                                </span>{" "}
                                on{" "}
                                <span className="font-mono text-neutral-100">
                                  {p.schema}.{p.table}
                                </span>
                                ? This cannot be undone.
                              </>
                            }
                          >
                            <input type="hidden" name="schema" value={p.schema} />
                            <input type="hidden" name="table" value={p.table} />
                            <input type="hidden" name="name" value={p.name} />
                          </ConfirmDeleteForm>
                        </div>
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
