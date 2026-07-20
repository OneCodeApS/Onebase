import Link from "next/link";
import { listEnums, listUserSchemas } from "@/lib/db-introspect";
import { getSession } from "@/lib/session";
import { EnumsTable } from "./_components/EnumsTable";

const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

export default async function EnumsPage({
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

  const enums = await listEnums(selectedSchema);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Enums</h1>
        <p className="mt-1 text-sm text-neutral-500">
          User-defined enum types and their values. Create them from the{" "}
          <Link href="/sql" className="underline hover:text-neutral-300">
            SQL editor
          </Link>{" "}
          with <span className="font-mono">CREATE TYPE … AS ENUM (…)</span>.
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
                href={`/admin/enums?schema=${encodeURIComponent(s)}`}
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

      <EnumsTable enums={enums} selectedSchema={selectedSchema} />
    </main>
  );
}
