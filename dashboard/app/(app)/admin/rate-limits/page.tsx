import { listRateLimits } from "@/lib/rate-limit";
import { Card } from "../../_components/Card";
import { saveRateLimit } from "./actions";

const AREA_LABELS: Record<string, string> = {
  signin: "Sign in (password)",
  signup: "Sign up",
  magiclink: "Magic link request",
};

function describe(rl: { max_attempts: number; window_seconds: number }): string {
  const w = rl.window_seconds;
  const human = w % 3600 === 0 ? `${w / 3600} h` : w % 60 === 0 ? `${w / 60} min` : `${w} s`;
  return `${rl.max_attempts} attempt${rl.max_attempts === 1 ? "" : "s"} per ${human}, per IP`;
}

export default async function RateLimitsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const limits = await listRateLimits();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mt-4 text-2xl font-semibold">Rate limits</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Per-IP throttles on the public auth endpoints. Enforced in Postgres, so
        a limit holds across all dashboard replicas (not per-process). Disabling
        an area turns its throttle off entirely.
      </p>

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

      {limits.length === 0 ? (
        <Card padded className="mt-6 text-sm text-neutral-500">
          No rate-limit config found. Apply migration{" "}
          <span className="font-mono">0019_rate_limits.sql</span>.
        </Card>
      ) : (
        limits.map((rl) => (
          <Card key={rl.area} padded className="mt-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-medium">{AREA_LABELS[rl.area] ?? rl.area}</h2>
              <span className="font-mono text-xs text-neutral-500">{rl.area}</span>
            </div>
            <p className="mt-1 text-sm text-neutral-500">
              {rl.enabled ? describe(rl) : "Disabled — no throttle."}
            </p>

            <form action={saveRateLimit} className="mt-3 flex flex-wrap items-end gap-4">
              <input type="hidden" name="area" value={rl.area} />
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                Max attempts
                <input
                  type="number"
                  name="max_attempts"
                  defaultValue={rl.max_attempts}
                  min={1}
                  max={100000}
                  step={1}
                  required
                  className="w-28 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                Window (seconds)
                <input
                  type="number"
                  name="window_seconds"
                  defaultValue={rl.window_seconds}
                  min={1}
                  max={86400}
                  step={1}
                  required
                  className="w-32 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm"
                />
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={rl.enabled}
                  className="h-4 w-4 accent-neutral-500"
                />
                Enabled
              </label>
              <div className="flex-1" />
              <button
                type="submit"
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
              >
                Save
              </button>
            </form>
          </Card>
        ))
      )}
    </main>
  );
}
