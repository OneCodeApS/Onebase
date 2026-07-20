import { listFunctions } from "@/lib/functions";
import { NewFunctionModal } from "./_components/NewFunctionModal";
import { FunctionsTable } from "./_components/FunctionsTable";
import { getSession } from "@/lib/session";

export default async function FunctionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const functions = await listFunctions();
  const session = await getSession();
  const isAdmin = session.role === "admin";

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Edge functions</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Server-side JavaScript invoked via{" "}
            <span className="font-mono">/functions/v1/&lt;name&gt;</span>.
          </p>
        </div>
        {isAdmin && <NewFunctionModal />}
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

      <FunctionsTable functions={functions} />
    </main>
  );
}
