"use client";

import { useRef, useState } from "react";
import { saveCronJob } from "../actions";
import { useBackdropDismiss } from "../../../_components/useBackdropDismiss";

export function CronJobModal({
  trigger,
  initial,
  functions,
}: {
  trigger: React.ReactNode;
  initial?: {
    name: string;
    schedule: string;
    function_name: string;
    enabled: boolean;
  };
  functions: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editing = !!initial;
  const [showHelp, setShowHelp] = useState(false);

  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <span onClick={() => dialogRef.current?.showModal()}>{trigger}</span>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-lg rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">
            {editing ? `Edit ${initial!.name}` : "New cron job"}
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <form action={saveCronJob} className="space-y-4 px-5 py-4">
          <div>
            <label
              htmlFor={`cron-name-${initial?.name ?? "new"}`}
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Name
            </label>
            <input
              id={`cron-name-${initial?.name ?? "new"}`}
              type="text"
              name="name"
              required
              autoFocus={!editing}
              readOnly={editing}
              defaultValue={initial?.name ?? ""}
              pattern="[a-z][a-z0-9_-]{0,62}"
              placeholder="hourly-cleanup"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm read-only:opacity-70"
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <label
                htmlFor={`cron-schedule-${initial?.name ?? "new"}`}
                className="block text-xs uppercase tracking-wider text-neutral-500"
              >
                Schedule
              </label>
              <button
                type="button"
                onClick={() => setShowHelp((v) => !v)}
                aria-expanded={showHelp}
                aria-label="Cron format help"
                title="Cron format help"
                className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-neutral-600 text-[10px] leading-none text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"
              >
                ?
              </button>
            </div>
            <input
              id={`cron-schedule-${initial?.name ?? "new"}`}
              type="text"
              name="schedule"
              required
              defaultValue={initial?.schedule ?? "0 * * * *"}
              placeholder="0 * * * *"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-neutral-500">
              5-field cron format. Examples:{" "}
              <span className="font-mono">0 * * * *</span> (every hour),{" "}
              <span className="font-mono">*/5 * * * *</span> (every 5 min),{" "}
              <span className="font-mono">0 0 * * *</span> (daily at midnight UTC).
            </p>
            {showHelp && (
              <div className="mt-2 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-300">
                <p className="mb-2 font-medium text-neutral-200">Cron format</p>
                <pre className="mb-2 whitespace-pre font-mono text-[11px] leading-snug text-neutral-400">
{`┌──── minute        (0-59)
│ ┌── hour          (0-23)
│ │ ┌── day of month (1-31)
│ │ │ ┌── month       (1-12)
│ │ │ │ ┌── day of week (0-7, both 0 and 7 = Sunday)
│ │ │ │ │
* * * * *`}
                </pre>
                <p className="mb-1 font-medium text-neutral-200">Operators</p>
                <ul className="mb-2 list-disc space-y-0.5 pl-5 text-neutral-400">
                  <li>
                    <span className="font-mono text-neutral-200">*</span> — any value
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">a,b,c</span> — list of values
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">a-b</span> — range
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">*/n</span> — every <em>n</em> units
                  </li>
                </ul>
                <p className="mb-1 font-medium text-neutral-200">More examples</p>
                <ul className="list-disc space-y-0.5 pl-5 text-neutral-400">
                  <li>
                    <span className="font-mono text-neutral-200">30 2 * * *</span> — daily at 02:30 UTC
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">0 9 * * 1-5</span> — weekdays at 09:00 UTC
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">0 0 1 * *</span> — first of each month
                  </li>
                  <li>
                    <span className="font-mono text-neutral-200">*/10 * * * *</span> — every 10 minutes
                  </li>
                </ul>
                <p className="mt-2 text-neutral-500">
                  All times are evaluated in the dashboard container&apos;s timezone (UTC by default).
                </p>
              </div>
            )}
          </div>

          <div>
            <label
              htmlFor={`cron-fn-${initial?.name ?? "new"}`}
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Function to invoke
            </label>
            <select
              id={`cron-fn-${initial?.name ?? "new"}`}
              name="function_name"
              required
              defaultValue={initial?.function_name ?? ""}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            >
              <option value="" disabled>
                — pick one —
              </option>
              {functions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              The function receives a POST with{" "}
              <span className="font-mono">X-Cron-Trigger: &lt;job-name&gt;</span>{" "}
              header.
            </p>
          </div>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={initial?.enabled ?? true}
              className="mt-1 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-200">
                Enabled
              </span>
              <span className="block text-xs text-neutral-500">
                Disable to pause without losing the schedule.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2 border-t border-neutral-800 pt-4">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
            >
              Save
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
