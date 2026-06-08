import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function buildPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString,
    // Sized for a few hundred concurrent users sharing this single dashboard
    // instance. With PgBouncer in front (compose: pgbouncer service) this is
    // the client-side cap on simultaneous transactions, not on actual
    // Postgres backends. PostgREST has its own pool of the same size.
    max: 30,
    idleTimeoutMillis: 30_000,
    // Statement timeout is enforced per-query in the SQL editor;
    // a global default protects against runaway queries from other paths.
    statement_timeout: 30_000,
  });
}

export function pool(): Pool {
  if (!globalThis.__pgPool) {
    globalThis.__pgPool = buildPool();
  }
  return globalThis.__pgPool;
}

// Session-pinned consumers that must bypass PgBouncer — the realtime fan-out
// hub (lib/realtime-listener.ts) and the scheduler leader lock (lib/leader.ts) —
// open their own dedicated pg.Client from REALTIME_DATABASE_URL (falling back to
// DATABASE_URL), since PgBouncer's transaction pooling can't hold a LISTEN or a
// session-level advisory lock. They don't use this transaction pool.
