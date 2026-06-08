import Link from "next/link";
import { Card } from "../../_components/Card";
import { listEnums, listUserSchemas } from "@/lib/db-introspect";
import { getSession } from "@/lib/session";

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

      <Card className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Type</th>
              <th className="px-3 py-2 font-normal">Values</th>
            </tr>
          </thead>
          <tbody>
            {enums.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-neutral-500">
                  No enum types in{" "}
                  <span className="font-mono">{selectedSchema}</span>.
                </td>
              </tr>
            ) : (
              enums.map((e) => (
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
    </main>
  );
}
