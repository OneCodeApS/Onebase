"use client";

import { useMemo, useState } from "react";
import type { RealtimeTable } from "@/lib/realtime";
import { setRealtime } from "../actions";

// One state button. Highlighted when it's the table's current state. Submits the
// `setRealtime` server action — server actions can be imported into client
// components and used as a form action, so the search box can live here too.
function StateButton({
  t,
  state,
  label,
  active,
  title,
  tone,
}: {
  t: RealtimeTable;
  state: "off" | "basic" | "authorized";
  label: string;
  active: boolean;
  title?: string;
  tone: "off" | "basic" | "authorized";
}) {
  const tones: Record<string, string> = {
    off: active
      ? "border-neutral-600 bg-neutral-700 text-neutral-100"
      : "border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:bg-neutral-800",
    basic: active
      ? "border-sky-900/60 bg-sky-950/40 text-sky-200"
      : "border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:bg-neutral-800",
    authorized: active
      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-200"
      : "border-neutral-700 bg-neutral-800/40 text-neutral-400 hover:bg-neutral-800",
  };
  return (
    <form action={setRealtime} className="inline">
      <input type="hidden" name="schema" value={t.schema} />
      <input type="hidden" name="table" value={t.table} />
      <input type="hidden" name="state" value={state} />
      <button
        type="submit"
        title={title}
        aria-pressed={active}
        className={`rounded border px-2.5 py-0.5 text-xs ${tones[tone]}`}
      >
        {label}
      </button>
    </form>
  );
}

export function RealtimeTableList({ tables }: { tables: RealtimeTable[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) =>
      `${t.schema}.${t.table}`.toLowerCase().includes(q),
    );
  }, [tables, query]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tables… (schema.table)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {tables.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Schema</th>
              <th className="px-3 py-2 font-normal">Table</th>
              <th className="px-3 py-2 font-normal">RLS</th>
              <th className="px-3 py-2 font-normal text-right">Realtime</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-neutral-500">
                  {tables.length === 0 ? "No tables." : "No tables match the filter."}
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const state = !t.enabled ? "off" : t.mode;
                return (
                  <tr
                    key={`${t.schema}.${t.table}`}
                    className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                  >
                    <td className="px-3 py-2 font-mono text-neutral-400">{t.schema}</td>
                    <td className="px-3 py-2 font-mono text-neutral-200">{t.table}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs ${
                          t.rls_enabled ? "text-emerald-400" : "text-neutral-500"
                        }`}
                      >
                        {t.rls_enabled ? "on" : "off"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <StateButton
                          t={t}
                          state="off"
                          tone="off"
                          label="Off"
                          active={state === "off"}
                        />
                        <StateButton
                          t={t}
                          state="basic"
                          tone="basic"
                          label="Basic"
                          active={state === "basic"}
                          title="Broadcast every change to all subscribers (no RLS)"
                        />
                        <StateButton
                          t={t}
                          state="authorized"
                          tone="authorized"
                          label="Authorized"
                          active={state === "authorized"}
                          title={
                            t.rls_enabled
                              ? "Filter each event per-subscriber by the RLS SELECT policy"
                              : "Enable RLS on this table first — authorized mode delivers nothing without it"
                          }
                        />
                      </div>
                      {t.enabled && t.mode === "authorized" && !t.rls_enabled && (
                        <p className="mt-1 text-right text-xs text-amber-400">
                          RLS is off — no events will be delivered.
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
