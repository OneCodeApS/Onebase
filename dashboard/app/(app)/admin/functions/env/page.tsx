import { listEnvVars } from "@/lib/function-env";
import { EnvVarModal } from "./_components/EnvVarModal";
import { EnvVarsTable } from "./_components/EnvVarsTable";

export default async function EnvPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const vars = await listEnvVars();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Environment variables</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Global vars available to every edge function as{" "}
            <span className="font-mono">ctx.env.&lt;KEY&gt;</span>.
          </p>
        </div>
        <EnvVarModal
          trigger={
            <button
              type="button"
              className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
            >
              + New variable
            </button>
          }
        />
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

      <EnvVarsTable vars={vars} />
    </main>
  );
}
