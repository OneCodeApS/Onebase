import { pool } from "./db";
import { audit } from "./audit";
import { getSetting } from "./settings";
import { pruneRateLimitHits } from "./rate-limit";

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_PRUNE_DELAY_MS = 30_000;

export type PruneResult = {
  deleted: number;
  anchorId: string | null;
  cutoff: string | null;
  retentionDays: number;
};

// Deletes audit_log rows older than `audit_retention_days`. Writes the hash
// of the newest deleted row to `audit_chain_anchor` so verifyChain can keep
// walking from that point instead of failing on the surviving oldest row.
// Set audit_retention_days = 0 to disable pruning.
export async function pruneOldAuditRows(): Promise<PruneResult> {
  const raw = await getSetting<number>("audit_retention_days");
  const days = Number(raw ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    return { deleted: 0, anchorId: null, cutoff: null, retentionDays: days };
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Newest row that's still past the retention window. Its hash becomes
    // the chain anchor; everything up to and including its id gets deleted.
    const { rows: anchorRows } = await client.query<{
      id: string;
      hash: string | null;
      cutoff: Date;
    }>(
      `SELECT id, hash,
              (now() - ($1 || ' days')::interval) AS cutoff
         FROM _dashboard.audit_log
        WHERE created_at < (now() - ($1 || ' days')::interval)
        ORDER BY id DESC
        LIMIT 1`,
      [days],
    );

    if (anchorRows.length === 0) {
      await client.query("COMMIT");
      return { deleted: 0, anchorId: null, cutoff: null, retentionDays: days };
    }

    const { id: anchorId, hash: anchorHash, cutoff } = anchorRows[0];

    const del = await client.query(
      "DELETE FROM _dashboard.audit_log WHERE id <= $1",
      [anchorId],
    );

    await client.query(
      `INSERT INTO _dashboard.settings (key, value, updated_at)
       VALUES ('audit_chain_anchor', to_jsonb($1::text), now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = now()`,
      [anchorHash],
    );

    await client.query("COMMIT");

    // Self-audit AFTER commit so the new row chains cleanly to whatever
    // surviving rows are present (or to the anchor if everything was pruned).
    await audit({
      actor: "<system>",
      actorId: null,
      role: null,
      action: "audit.prune",
      success: true,
      ip: null,
      metadata: {
        retention_days: days,
        deleted: del.rowCount ?? 0,
        anchor_id: anchorId,
        cutoff: cutoff.toISOString(),
      },
    });

    return {
      deleted: del.rowCount ?? 0,
      anchorId,
      cutoff: cutoff.toISOString(),
      retentionDays: days,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Timer handles on globalThis so dev HMR (which re-evaluates the module) can't
// orphan a running interval, and so start/stop can be called repeatedly as
// scheduler leadership moves between replicas.
declare global {
  // eslint-disable-next-line no-var
  var __auditRetentionTimers:
    | { first?: NodeJS.Timeout; interval?: NodeJS.Timeout }
    | undefined;
}

function timers() {
  if (!globalThis.__auditRetentionTimers) globalThis.__auditRetentionTimers = {};
  return globalThis.__auditRetentionTimers;
}

// Start the sweeper: one run shortly after boot (so startup isn't blocked by a
// potentially long DELETE), then daily. Only the scheduler leader calls this
// (lib/scheduler.ts); a no-op if it's already running in this process.
export function startAuditRetention(): void {
  const t = timers();
  if (t.interval) return;

  const tick = () => {
    pruneOldAuditRows()
      .then((r) => {
        if (r.deleted > 0) {
          console.log(
            `[audit-retention] pruned ${r.deleted} row(s) older than ${r.retentionDays} day(s)`,
          );
        }
      })
      .catch((e) => console.error("[audit-retention] prune failed", e));
    // Same daily leader-run sweep also drops stale rate-limit counter rows.
    pruneRateLimitHits().catch((e) =>
      console.error("[rate-limit] hit-table prune failed", e),
    );
  };

  t.first = setTimeout(tick, FIRST_PRUNE_DELAY_MS);
  t.interval = setInterval(tick, PRUNE_INTERVAL_MS);
}

// Stop the sweeper when this replica loses scheduler leadership.
export function stopAuditRetention(): void {
  const t = timers();
  if (t.first) {
    clearTimeout(t.first);
    t.first = undefined;
  }
  if (t.interval) {
    clearInterval(t.interval);
    t.interval = undefined;
  }
}
