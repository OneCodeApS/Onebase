import { listCronJobs } from "@/lib/cron";
import { listFunctions } from "@/lib/functions";
import { CronJobModal } from "./_components/CronJobModal";
import { CronJobsTable } from "./_components/CronJobsTable";
import { getSession } from "@/lib/session";

export default async function CronPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const [jobs, functions] = await Promise.all([listCronJobs(), listFunctions()]);
  const functionNames = functions.map((f) => f.name);
  const session = await getSession();
  const isAdmin = session.role === "admin";

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cron jobs</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Scheduled invocations of edge functions. The scheduler runs
            in-process — only one dashboard instance fires each job.
          </p>
        </div>
        {isAdmin && (
          <CronJobModal
            functions={functionNames}
            trigger={
              <button
                type="button"
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
              >
                + New cron job
              </button>
            }
          />
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

      <CronJobsTable
        jobs={jobs}
        functionNames={functionNames}
        isAdmin={isAdmin}
      />
    </main>
  );
}
