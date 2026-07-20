import Link from "next/link";
import {
  countExtensionFunctions,
  listDbFunctions,
  listUserSchemas,
} from "@/lib/db-introspect";
import { getSession } from "@/lib/session";
import { DbFunctionsTable } from "./_components/DbFunctionsTable";

const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

export default async function DbFunctionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    schema?: string;
    ext?: string;
    ok?: string;
    error?: string;
  }>;
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

  const includeExtensions = sp.ext === "1";
  const [fns, extensionCount] = await Promise.all([
    listDbFunctions(selectedSchema, includeExtensions),
    countExtensionFunctions(selectedSchema),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Database functions</h1>
          <p className="mt-1 text-sm text-neutral-500">
            User-defined SQL / PLpgSQL functions and procedures. Not to be
            confused with{" "}
            <Link href="/admin/functions" className="underline hover:text-neutral-300">
              edge functions
            </Link>
            , which run JavaScript in the dashboard process.
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/admin/db-functions/new"
            className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
          >
            + New function
          </Link>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-neutral-500">
            Schema
          </span>
          <div className="flex flex-wrap gap-1.5">
            {schemas.map((s) => {
              const params = new URLSearchParams();
              params.set("schema", s);
              if (includeExtensions) params.set("ext", "1");
              return (
                <Link
                  key={s}
                  href={`/admin/db-functions?${params.toString()}`}
                  className={`rounded px-2 py-0.5 text-xs ${
                    s === selectedSchema
                      ? "bg-neutral-700 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                  }`}
                >
                  {s}
                </Link>
              );
            })}
          </div>
        </div>

        {extensionCount > 0 && (
          <Link
            href={
              includeExtensions
                ? `/admin/db-functions?schema=${encodeURIComponent(selectedSchema)}`
                : `/admin/db-functions?schema=${encodeURIComponent(selectedSchema)}&ext=1`
            }
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            title="Functions installed by extensions (pgcrypto, etc.) are hidden by default"
          >
            {includeExtensions
              ? `Hide ${extensionCount} extension function${extensionCount === 1 ? "" : "s"}`
              : `Show ${extensionCount} extension function${extensionCount === 1 ? "" : "s"}`}
          </Link>
        )}
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

      <DbFunctionsTable
        fns={fns}
        selectedSchema={selectedSchema}
        isAdmin={isAdmin}
      />
    </main>
  );
}
