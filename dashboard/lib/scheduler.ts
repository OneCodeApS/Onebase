import type { Client } from "pg";
import { runLeaderLoop } from "./leader";
import { reloadCron, stopCron } from "./cron";
import { startAuditRetention, stopAuditRetention } from "./audit-retention";

// Boots the platform background jobs — the cron scheduler and the audit-log
// retention sweeper — on EXACTLY ONE replica at a time, chosen by a Postgres
// advisory lock (lib/leader.ts). Safe to call from every replica's
// instrumentation hook: only the lock holder runs the jobs, and a standby
// takes over automatically if the leader dies.
export function startScheduler(): void {
  runLeaderLoop({
    async onAcquire(client: Client) {
      await reloadCron();
      startAuditRetention();

      // Cron CRUD on any replica fires `NOTIFY cron_reload` (lib/cron.ts).
      // The leader listens on its lock-holding session and rebuilds when it
      // hears it, so edits take effect immediately regardless of which replica
      // handled the request.
      await client.query("LISTEN cron_reload");
      client.on("notification", (msg) => {
        if (msg.channel === "cron_reload") {
          reloadCron().catch((e) => console.error("[cron] reload failed", e));
        }
      });

      console.log("[scheduler] acquired leadership — cron + audit-retention active");
    },
    onLose() {
      stopCron();
      stopAuditRetention();
      console.log("[scheduler] released leadership — background jobs stopped");
    },
  });
}
