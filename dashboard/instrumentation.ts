// Next.js runs this once when the server starts (Node runtime only).
// Boots the platform background jobs — the cron scheduler and the audit-log
// retention sweeper — through a Postgres advisory lock so exactly one replica
// runs them (see lib/scheduler.ts). Safe to run unchanged on every replica.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Dynamic import keeps the node-only scheduler subtree (pg, node-cron,
  // node:crypto, …) out of the edge/browser bundles — see the IgnorePlugin in
  // next.config.ts, which drops `./lib/scheduler` from non-Node compilations.
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
