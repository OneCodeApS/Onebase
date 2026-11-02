"use client";

import { useMemo, useState } from "react";
import type { FunctionEnvVarRow } from "@/lib/function-env";
import { Card } from "../../../../_components/Card";
import { ConfirmDeleteForm } from "../../../../_components/ConfirmDeleteForm";
import { removeEnvVar } from "../actions";
import { EnvVarModal } from "./EnvVarModal";

function formatTime(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// Client-side filter over the env vars already on the page. Matches the key
// or the description — never the value, which is only ever shown masked.
export function EnvVarsTable({ vars }: { vars: FunctionEnvVarRow[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vars;
    return vars.filter(
      (v) =>
        v.key.toLowerCase().includes(q) ||
        (v.description ?? "").toLowerCase().includes(q),
    );
  }, [vars, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter variables… (key or description)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {vars.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Key</th>
              <th className="px-3 py-2 font-normal">Value</th>
              <th className="px-3 py-2 font-normal">Description</th>
              <th className="px-3 py-2 font-normal">Updated</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                  {vars.length === 0 ? (
                    <>
                      No variables yet. Click <strong>+ New variable</strong>.
                    </>
                  ) : (
                    "No variables match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((v) => (
                <tr
                  key={v.key}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  <td className="px-3 py-2 font-mono text-neutral-200">{v.key}</td>
                  <td className="px-3 py-2 font-mono text-neutral-400">
                    {v.value === "" ? (
                      <span className="text-neutral-600">(empty)</span>
                    ) : (
                      <span className="text-neutral-300">{v.preview}</span>
                    )}
                    {v.legacy_plaintext && (
                      <span
                        className="ml-2 rounded border border-amber-900/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-400"
                        title="Stored in the legacy plaintext column. Re-save (Edit → Save) to encrypt."
                      >
                        unencrypted
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {v.description ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {formatTime(v.updated_at)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-3">
                      <EnvVarModal
                        trigger={
                          <button
                            type="button"
                            className="text-xs text-neutral-400 underline hover:text-neutral-100"
                          >
                            Edit
                          </button>
                        }
                        initial={{
                          key: v.key,
                          value: v.value,
                          description: v.description,
                        }}
                      />
                      <ConfirmDeleteForm
                        action={removeEnvVar}
                        triggerLabel="Delete"
                        triggerClassName="text-xs text-red-400 underline hover:text-red-200"
                        title="Delete environment variable?"
                        message={
                          <>
                            Delete <span className="font-mono text-neutral-100">{v.key}</span>?
                            Any edge function reading{" "}
                            <span className="font-mono text-neutral-100">ctx.env.{v.key}</span>{" "}
                            will see <span className="font-mono">undefined</span> on its next invocation.
                          </>
                        }
                      >
                        <input type="hidden" name="key" value={v.key} />
                      </ConfirmDeleteForm>
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
