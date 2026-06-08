import { Client } from "pg";

// Single-leader election across dashboard replicas, backed by a Postgres
// session-level advisory lock. Whichever replica holds the lock runs the
// platform background jobs (see lib/scheduler.ts); the rest stand by and take
// over automatically if the leader's connection drops (Postgres releases a
// session-level lock when its session ends).
//
// The lock is held on a dedicated, DIRECT connection (REALTIME_DATABASE_URL —
// straight to Postgres, not PgBouncer): PgBouncer's transaction pooling would
// neither keep the session that owns the lock nor support the LISTEN the leader
// runs on the same connection.

// Deterministic lock id — hashtext() is immutable, so every replica derives the
// same key, and nothing else in this database uses advisory locks.
const LOCK_KEY_SQL = "hashtext('onebase.scheduler')";

const DEFAULT_RETRY_MS = 15_000; // how often a standby re-attempts the lock
const HEARTBEAT_MS = 10_000; // detect a half-open socket faster than TCP timeout
const RECONNECT_MS = 5_000; // backoff before rebuilding a dropped connection

type LeaderOpts = {
  // Invoked when this process wins the lock. `client` is the lock-holding
  // session — reuse it for LISTEN so the subscription lives exactly as long as
  // leadership does.
  onAcquire: (client: Client) => Promise<void> | void;
  // Invoked when a held lock is lost (connection dropped). Stop the jobs here.
  onLose: () => void;
  retryMs?: number;
};

export function runLeaderLoop(opts: LeaderOpts): void {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const connectionString =
    process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "[leader] REALTIME_DATABASE_URL/DATABASE_URL unset — background jobs disabled",
    );
    return;
  }

  function connect(): void {
    const client = new Client({ connectionString, keepAlive: true });
    let isLeader = false;
    let loggedStandby = false;
    let retryTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let down = false;

    function teardown(err?: Error): void {
      if (down) return; // a single connection only tears down once
      down = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (isLeader) {
        isLeader = false;
        try {
          opts.onLose();
        } catch (e) {
          console.error("[leader] onLose threw", e);
        }
      }
      if (err) console.error("[leader] connection lost:", err.message);
      client.end().catch(() => {});
      setTimeout(connect, RECONNECT_MS); // rebuild from scratch
    }

    client.on("error", teardown);
    client.on("end", () => teardown());

    async function tryAcquire(): Promise<void> {
      try {
        const { rows } = await client.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS ok`,
        );
        if (rows[0]?.ok) {
          isLeader = true;
          // Backstop the 'error' event: a periodic round-trip surfaces a dead
          // socket within ~10s so failover doesn't wait on a TCP timeout.
          heartbeatTimer = setInterval(() => {
            client.query("SELECT 1").catch((e) => teardown(e as Error));
          }, HEARTBEAT_MS);
          await opts.onAcquire(client);
        } else {
          if (!loggedStandby) {
            console.log("[leader] another replica holds the scheduler lock — standing by");
            loggedStandby = true;
          }
          retryTimer = setTimeout(tryAcquire, retryMs);
        }
      } catch (e) {
        teardown(e as Error);
      }
    }

    client.connect().then(tryAcquire).catch(teardown);
  }

  connect();
}
