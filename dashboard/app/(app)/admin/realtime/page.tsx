import { Card } from "../../_components/Card";
import { listRealtimeStatus, type RealtimeTable } from "@/lib/realtime";
import { setRealtime } from "./actions";

// One state button. Highlighted when it's the table's current state.
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

export default async function RealtimePage() {
  const tables = await listRealtimeStatus();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Realtime</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Enable per-table row-change streams over{" "}
        <span className="font-mono">/realtime?schema=&lt;s&gt;&amp;table=&lt;t&gt;</span>{" "}
        as Server-Sent Events. Subscribers need a valid access token from{" "}
        <span className="font-mono">/auth/v1</span>.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-neutral-500">
        <li>
          <span className="rounded border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 text-xs text-sky-200">
            Basic
          </span>{" "}
          broadcasts every change to all subscribers — RLS is <em>not</em> applied.
        </li>
        <li>
          <span className="rounded border border-emerald-900/60 bg-emerald-950/40 px-1.5 py-0.5 text-xs text-emerald-200">
            Authorized
          </span>{" "}
          filters each event per-subscriber by the table&apos;s RLS SELECT policy
          (requires RLS enabled on the table).
        </li>
      </ul>

      <Card className="mt-6 overflow-x-auto">
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
            {tables.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-neutral-500">
                  No tables.
                </td>
              </tr>
            ) : (
              tables.map((t) => {
                const state = !t.enabled ? "off" : t.mode;
                return (
                  <tr
                    key={`${t.schema}.${t.table}`}
                    className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                  >
                    <td className="px-3 py-2 font-mono text-neutral-400">
                      {t.schema}
                    </td>
                    <td className="px-3 py-2 font-mono text-neutral-200">
                      {t.table}
                    </td>
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
      </Card>
    </main>
  );
}
