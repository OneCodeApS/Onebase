import Link from "next/link";
import { listTableGrants, listUserSchemas } from "@/lib/db-introspect";
import { getSession } from "@/lib/session";
import { GrantsTable } from "./_components/GrantsTable";

const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

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

      <GrantsTable tables={tables} selectedSchema={selectedSchema} />

      <p className="mt-3 text-xs text-neutral-600">
        <span className="text-amber-400">PUBLIC</span> = every role.{" "}
        <span className="text-sky-300">anon / authenticated / service_role</span>{" "}
        are the PostgREST API roles. <span className="text-amber-300">*</span> ={" "}
        <span className="font-mono">WITH GRANT OPTION</span>.
      </p>
    </main>
  );
}
