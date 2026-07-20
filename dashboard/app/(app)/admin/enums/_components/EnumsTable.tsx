"use client";

import { useMemo, useState } from "react";
import type { EnumType } from "@/lib/db-introspect";
import { Card } from "../../../_components/Card";

// Client-side filter over the enum types already loaded for this schema. The
// list is small and fully on the page, so there's nothing to refetch — we just
// match the type name or any of its values against the query.
export function EnumsTable({
  enums,
  selectedSchema,
}: {
  enums: EnumType[];
  selectedSchema: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return enums;
    return enums.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.values.some((v) => v.toLowerCase().includes(q)),
    );
  }, [enums, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter enums… (name or value)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {enums.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Type</th>
              <th className="px-3 py-2 font-normal">Values</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-neutral-500">
                  {enums.length === 0 ? (
                    <>
                      No enum types in{" "}
                      <span className="font-mono">{selectedSchema}</span>.
                    </>
                  ) : (
                    "No enums match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((e) => (
                <tr
                  key={`${e.schema}.${e.name}`}
                  className="border-b border-neutral-800 align-top last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-200">
                    {e.name}
                    <span className="ml-2 rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] text-neutral-500">
                      {e.values.length}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      {e.values.map((v) => (
                        <span
                          key={v}
                          className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
                        >
                          {v}
                        </span>
                      ))}
                    </span>
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
