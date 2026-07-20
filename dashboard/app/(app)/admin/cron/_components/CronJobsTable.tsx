"use client";

import { useMemo, useState } from "react";
import type { CronJob } from "@/lib/cron";
import { Card } from "../../../_components/Card";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { removeCronJob } from "../actions";
import { CronJobModal } from "./CronJobModal";

function formatTime(d: Date | string | null): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// Client-side filter over the cron jobs already on the page. Matches the job
// name, the target function, or the schedule expression.
export function CronJobsTable({
  jobs,
  functionNames,
  isAdmin,
}: {
  jobs: CronJob[];
  functionNames: string[];
  isAdmin: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.function_name.toLowerCase().includes(q) ||
        j.schedule.toLowerCase().includes(q),
    );
  }, [jobs, query]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter jobs… (name, function, schedule)"
          className="w-full max-w-xs rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {jobs.length}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Schedule</th>
              <th className="px-3 py-2 font-normal">Function</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Last run</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  {jobs.length === 0 ? (
                    <>
                      No cron jobs yet.{" "}
                      {functionNames.length === 0 ? (
                        "Create a function first."
                      ) : (
                        <>
                          Click <strong>+ New cron job</strong> to add one.
                        </>
                      )}
                    </>
                  ) : (
                    "No jobs match the filter."
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((j) => (
                <tr
                  key={j.name}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  <td className="px-3 py-2 font-mono text-neutral-200">
                    {j.name}
                    {!j.enabled && (
                      <span className="ml-2 rounded border border-neutral-700 bg-neutral-800/40 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-neutral-400">
                    {j.schedule}
                  </td>
                  <td className="px-3 py-2 font-mono text-neutral-300">
                    {j.function_name}
                  </td>
                  <td className="px-3 py-2">
                    {j.last_status === "success" && (
                      <span className="text-emerald-400">
                        ✓ {j.last_duration_ms ?? "?"}ms
                      </span>
                    )}
                    {j.last_status === "failed" && (
                      <span className="text-red-400" title={j.last_error ?? ""}>
                        ✗ {j.last_error?.slice(0, 40) ?? "failed"}
                      </span>
                    )}
                    {j.last_status === "running" && (
                      <span className="text-amber-400">running…</span>
                    )}
                    {!j.last_status && (
                      <span className="text-neutral-500">never run</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {formatTime(j.last_run_at)}
                  </td>
                  <td className="px-3 py-2">
                    {isAdmin && (
                      <div className="flex justify-end gap-3">
                        <CronJobModal
                          functions={functionNames}
                          trigger={
                            <button
                              type="button"
                              className="text-xs text-neutral-400 underline hover:text-neutral-100"
                            >
                              Edit
                            </button>
                          }
                          initial={{
                            name: j.name,
                            schedule: j.schedule,
                            function_name: j.function_name,
                            enabled: j.enabled,
                          }}
                        />
                        <ConfirmDeleteForm
                          action={removeCronJob}
                          triggerLabel="Delete"
                          triggerClassName="text-xs text-red-400 underline hover:text-red-200"
                          title="Delete cron job?"
                          message={
                            <>
                              Delete cron job{" "}
                              <span className="font-mono text-neutral-100">
                                {j.name}
                              </span>
                              ? The schedule stops immediately. The function
                              itself is not affected.
                            </>
                          }
                        >
                          <input type="hidden" name="name" value={j.name} />
                        </ConfirmDeleteForm>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
