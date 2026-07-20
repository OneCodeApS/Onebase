"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { DbFunctionRow } from "@/lib/db-introspect";
import { Card } from "../../../_components/Card";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { deleteDbFunction } from "../actions";

// Client-side filter over the functions already loaded for this schema. Matches
// the function name, its argument list, or its return type.
export function DbFunctionsTable({
  fns,
  selectedSchema,
  isAdmin,
}: {
  fns: DbFunctionRow[];
  selectedSchema: string;
  isAdmin: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fns;
    return fns.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.args.toLowerCase().includes(q) ||
        f.returns.toLowerCase().includes(q),
    );
  }, [fns, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter functions… (name, args, return type)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {fns.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Args</th>
              <th className="px-3 py-2 font-normal">Returns</th>
              <th className="px-3 py-2 font-normal">Lang</th>
              <th className="px-3 py-2 font-normal">Volatility</th>
              <th className="px-3 py-2 font-normal">Security</th>
              <th className="px-3 py-2 font-normal">Owner</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                  {fns.length === 0 ? (
                    <>
                      No functions in{" "}
                      <span className="font-mono">{selectedSchema}</span>.
                    </>
                  ) : (
                    "No functions match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((f) => (
                <tr
                  key={f.oid}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-200">
                    <Link
                      href={`/admin/db-functions/${f.oid}`}
                      className="underline hover:text-neutral-100"
                    >
                      {f.name}
                    </Link>
                    {f.kind !== "function" && (
                      <span
                        className="ml-2 rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400"
                        title={`Postgres ${f.kind}`}
                      >
                        {f.kind}
                      </span>
                    )}
                  </td>
                  <td
                    className="max-w-[24ch] truncate px-3 py-2 font-mono text-xs text-neutral-400"
                    title={f.args || "(none)"}
                  >
                    {f.args || "—"}
                  </td>
                  <td
                    className="max-w-[20ch] truncate px-3 py-2 font-mono text-xs text-neutral-400"
                    title={f.returns}
                  >
                    {f.returns}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
                    {f.language}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
                    {f.volatility}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {f.security_definer ? (
                      <span
                        className="text-amber-400"
                        title="Runs with the privileges of the function owner — be careful with what's inside"
                      >
                        DEFINER
                      </span>
                    ) : (
                      <span className="text-neutral-500">INVOKER</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">
                    {f.owner}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-3">
                      <Link
                        href={`/admin/db-functions/${f.oid}`}
                        className="text-xs text-neutral-400 underline hover:text-neutral-100"
                      >
                        Open
                      </Link>
                      {isAdmin && (
                        <ConfirmDeleteForm
                          action={deleteDbFunction}
                          triggerLabel="Delete"
                          triggerClassName="text-xs text-red-400 underline hover:text-red-200"
                          title="Delete function?"
                          message={
                            <>
                              Permanently drop{" "}
                              <span className="font-mono text-neutral-100">
                                {f.schema}.{f.name}({f.args || ""})
                              </span>
                              ? Anything depending on it (views, other functions,
                              policies referencing it) will fail unless dropped
                              too.
                            </>
                          }
                        >
                          <input type="hidden" name="oid" value={f.oid} />
                        </ConfirmDeleteForm>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
