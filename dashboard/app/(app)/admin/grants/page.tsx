import Link from "next/link";
import { Card } from "../../_components/Card";
import { listTableGrants, listUserSchemas } from "@/lib/db-introspect";
import { getSession } from "@/lib/session";

const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

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

export default async function GrantsPage({
  searchParams,
}: {
  searchParams: Promise<{ schema?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSession();
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

  const tables = await listTableGrants(selectedSchema);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Grants</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Table &amp; view privileges (<span className="font-mono">GRANT</span> /{" "}
          <span className="font-mono">REVOKE</span>). A role needs the privilege
          here <em>and</em>, on RLS-enabled tables, a matching{" "}
          <Link
            href="/admin/policies"
            className="underline hover:text-neutral-300"
          >
            policy
          </Link>{" "}
          before it can read or write. The owner always has full access
          implicitly.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-500">
            Schema
          </span>
          <div className="flex flex-wrap gap-1.5">
            {schemas.map((s) => (
              <Link
                key={s}
                href={`/admin/grants?schema=${encodeURIComponent(s)}`}
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
      </div>

      <Card className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Object</th>
              <th className="px-3 py-2 font-normal">Owner</th>
              <th className="px-3 py-2 font-normal">Grants</th>
            </tr>
          </thead>
          <tbody>
            {tables.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-center text-neutral-500"
                >
                  No tables or views in{" "}
                  <span className="font-mono">{selectedSchema}</span>.
                </td>
              </tr>
            ) : (
              tables.map((t) => {
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

      <p className="mt-3 text-xs text-neutral-600">
        <span className="text-amber-400">PUBLIC</span> = every role.{" "}
        <span className="text-sky-300">anon / authenticated / service_role</span>{" "}
        are the PostgREST API roles. <span className="text-amber-300">*</span> ={" "}
        <span className="font-mono">WITH GRANT OPTION</span>.
      </p>
    </main>
  );
}
