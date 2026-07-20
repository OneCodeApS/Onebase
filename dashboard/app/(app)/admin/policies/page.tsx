import Link from "next/link";
import { Card } from "../../_components/Card";
import { ConfirmDeleteForm } from "../../_components/ConfirmDeleteForm";
import {
  listPolicies,
  listRoles,
  listTablesInSchema,
  listTablesRlsStatus,
  listUserSchemas,
} from "@/lib/db-introspect";
import { setTableRls } from "./actions";
import { PolicyModal } from "./_components/PolicyModal";
import { PoliciesTable } from "./_components/PoliciesTable";
import { getSession } from "@/lib/session";

// Same set used by the tables browser — kept consistent across pages so
// read_only never sees these in any schema picker.
const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams: Promise<{ schema?: string; ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  const isAdmin = session.role === "admin";
  const canViewSystemSchemas = session.role !== "read_only";
  const allSchemas = await listUserSchemas();
  const schemas = canViewSystemSchemas
    ? allSchemas
    : allSchemas.filter((s) => !SYSTEM_SCHEMAS.has(s));
  const selectedSchema =
    sp.schema && schemas.includes(sp.schema)
      ? sp.schema
      : schemas.includes("public")
        ? "public"
        : (schemas[0] ?? "public");

  const [policies, tableStatus, roles] = await Promise.all([
    listPolicies(selectedSchema),
    listTablesRlsStatus(selectedSchema),
    listRoles(),
  ]);

  // Tables across all user schemas for the policy form's dropdown — admins
  // can target any of them, not just the schema currently being viewed.
  const allTables: { schema: string; table: string }[] = [];
  for (const s of schemas) {
    const ts = await listTablesInSchema(s);
    for (const t of ts) allTables.push({ schema: s, table: t });
  }

  // Tables with no RLS but where the admin has defined at least one policy
  // — those policies are inert until RLS is enabled. Worth flagging at the top.
  const inertTables = tableStatus.filter(
    (t) => !t.rls_enabled && t.policy_count > 0,
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">RLS policies</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Row Level Security policies in the database. Policies are only
            enforced when RLS is enabled on the underlying table.
          </p>
        </div>
        {isAdmin && (
          <PolicyModal
            tables={allTables}
            roleOptions={roles}
            trigger={
              <button
                type="button"
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
              >
                + New policy
              </button>
            }
          />
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-neutral-500">
          Schema
        </span>
        <div className="flex flex-wrap gap-1.5">
          {schemas.map((s) => (
            <Link
              key={s}
              href={`/admin/policies?schema=${encodeURIComponent(s)}`}
              className={`rounded px-2 py-0.5 text-xs ${
                s === selectedSchema
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </div>

      {sp.error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {sp.error}
        </p>
      )}
      {sp.ok && (
        <p className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {sp.ok}
        </p>
      )}

      {inertTables.length > 0 && (
        <Card padded className="mt-4 border-amber-900/50 bg-amber-950/10">
          <h2 className="text-sm font-medium text-amber-300">
            Inert policies — RLS not enabled
          </h2>
          <p className="mt-1 text-xs text-neutral-400">
            The following tables have policies defined but RLS is off; those
            policies do nothing until you enable RLS on the table.
          </p>
          <ul className="mt-2 space-y-1">
            {inertTables.map((t) => (
              <li
                key={`${t.schema}.${t.table}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="font-mono text-amber-200">
                  {t.schema}.{t.table}
                </span>
                {isAdmin && (
                <form action={setTableRls}>
                  <input type="hidden" name="schema" value={t.schema} />
                  <input type="hidden" name="table" value={t.table} />
                  <input type="hidden" name="mode" value="enable" />
                  <button
                    type="submit"
                    className="rounded border border-amber-800/60 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-900/30"
                  >
                    Enable RLS
                  </button>
                </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PoliciesTable
        policies={policies}
        tableStatus={tableStatus}
        roles={roles}
        allTables={allTables}
        selectedSchema={selectedSchema}
        isAdmin={isAdmin}
      />

      <Card className="mt-6 overflow-x-auto">
        <div className="border-b border-neutral-800 px-3 py-2 text-xs uppercase tracking-wider text-neutral-500">
          Table RLS status — {selectedSchema}
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-800 bg-neutral-800/40 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Table</th>
              <th className="px-3 py-2 font-normal">RLS</th>
              <th className="px-3 py-2 font-normal">Forced</th>
              <th className="px-3 py-2 font-normal text-right">Policies</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {tableStatus.map((t) => (
              <tr
                key={`${t.schema}.${t.table}`}
                className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40"
              >
                <td className="px-3 py-2 font-mono text-neutral-200">
                  {t.schema}.{t.table}
                </td>
                <td className="px-3 py-2">
                  {t.rls_enabled ? (
                    <span className="text-emerald-400">on</span>
                  ) : (
                    <span className="text-neutral-500">off</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-neutral-400">
                  {t.rls_forced ? "yes" : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-neutral-300">
                  {t.policy_count}
                </td>
                <td className="px-3 py-2">
                  {isAdmin && (
                  <div className="flex justify-end gap-2">
                    {!t.rls_enabled && (
                      <form action={setTableRls} className="inline">
                        <input type="hidden" name="schema" value={t.schema} />
                        <input type="hidden" name="table" value={t.table} />
                        <input type="hidden" name="mode" value="enable" />
                        <button
                          type="submit"
                          className="text-xs text-emerald-400 underline hover:text-emerald-200"
                        >
                          Enable
                        </button>
                      </form>
                    )}
                    {t.rls_enabled && !t.rls_forced && (
                      <form action={setTableRls} className="inline">
                        <input type="hidden" name="schema" value={t.schema} />
                        <input type="hidden" name="table" value={t.table} />
                        <input type="hidden" name="mode" value="enable_force" />
                        <button
                          type="submit"
                          className="text-xs text-amber-400 underline hover:text-amber-200"
                          title="Force RLS so the table owner is subject to policies too"
                        >
                          Force
                        </button>
                      </form>
                    )}
                    {t.rls_enabled && (
                      <ConfirmDeleteForm
                        action={setTableRls}
                        triggerLabel="Disable"
                        triggerClassName="text-xs text-red-400 underline hover:text-red-200"
                        title="Disable RLS?"
                        confirmLabel="Disable"
                        message={
                          <>
                            Disable Row Level Security on{" "}
                            <span className="font-mono text-neutral-100">
                              {t.schema}.{t.table}
                            </span>
                            ? All policies on this table will become inert
                            and any caller will be able to read every row.
                          </>
                        }
                      >
                        <input type="hidden" name="schema" value={t.schema} />
                        <input type="hidden" name="table" value={t.table} />
                        <input type="hidden" name="mode" value="disable" />
                      </ConfirmDeleteForm>
                    )}
                  </div>
                  )}
                </td>
              </tr>
            ))}
            {tableStatus.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                  No tables in <span className="font-mono">{selectedSchema}</span>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
