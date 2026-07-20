"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EdgeFunction } from "@/lib/functions";
import { Card } from "../../../_components/Card";

// Client-side filter over the edge functions already on the page. Matches the
// function name or its description.
export function FunctionsTable({ functions }: { functions: EdgeFunction[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return functions;
    return functions.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.description ?? "").toLowerCase().includes(q),
    );
  }, [functions, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter functions… (name or description)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {functions.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Description</th>
              <th className="px-3 py-2 font-normal text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-neutral-500">
                  {functions.length === 0 ? (
                    <>
                      No functions yet. Click <strong>+ New function</strong> to
                      get started.
                    </>
                  ) : (
                    "No functions match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((f) => (
                <tr
                  key={f.name}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/functions/${encodeURIComponent(f.name)}/overview`}
                      className="font-mono text-neutral-100 hover:underline"
                    >
                      {f.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {f.description ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {f.enabled ? (
                      <span className="rounded border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-xs text-emerald-300">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded border border-neutral-700 bg-neutral-800/40 px-2 py-0.5 text-xs text-neutral-400">
                        disabled
                      </span>
                    )}
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
