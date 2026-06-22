import { Pool } from "pg";
import { logRealtime } from "./realtime-log";

// Dedicated connection pool for realtime's per-subscriber RLS check.
//
// CRITICAL: this MUST connect as a NON-BYPASSRLS role. The realtime fan-out hub
// (lib/realtime-listener.ts) uses REALTIME_DATABASE_URL, which is the
// `dashboard_admin` role (BYPASSRLS) — using it here would defeat the whole
// feature. We connect as `authenticator` (the same login role PostgREST uses)
// via REALTIME_RLS_DATABASE_URL; _dashboard.realtime_can_select then does
// `SET LOCAL ROLE authenticated` + sets request.jwt.claims, so the policy
// evaluation runs exactly as a REST request would.
//
// Direct to Postgres (not PgBouncer): the function relies on transaction-local
// GUCs, which a single statement satisfies, but keeping it off the transaction
// pooler avoids any cross-statement state surprises.

declare global {
  // eslint-disable-next-line no-var
  var __realtimeRlsPool: Pool | undefined;
}

function rlsPool(): Pool {
  if (!globalThis.__realtimeRlsPool) {
    const connectionString = process.env.REALTIME_RLS_DATABASE_URL;
    if (!connectionString) {
      throw new Error("REALTIME_RLS_DATABASE_URL is not set");
    }
    globalThis.__realtimeRlsPool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      // The check is a single fast function call; cap it so a pathological
      // policy can't pin a connection.
      statement_timeout: 5_000,
    });
  }
  return globalThis.__realtimeRlsPool;
}

// A parsed realtime event (see _dashboard.realtime_notify).
export type RealtimeEvent = {
  type: "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  old?: unknown;
  new?: unknown;
  truncated?: boolean;
  keys?: unknown;
  ts?: string;
};

// Decides whether the subscriber whose verified JWT claims are `claims` may
// receive `event`, by asking Postgres to re-evaluate the table's RLS SELECT
// policy for the changed row in that subscriber's context.
//
// Fails CLOSED: any error (DB unreachable, malformed event, etc.) returns false
// so a change is never leaked when we can't prove the subscriber may see it.
export async function canSelectEvent(
  event: RealtimeEvent,
  claims: Record<string, unknown>,
): Promise<boolean> {
  try {
    // INSERT/UPDATE authorize against the new image; DELETE against the old.
    const row = event.truncated
      ? null
      : event.type === "DELETE"
        ? (event.old ?? null)
        : (event.new ?? null);
    const keys = event.truncated ? (event.keys ?? null) : null;

    // Nothing to check against (e.g. a truncated DELETE) → fail closed.
    if (row === null && keys === null) return false;

    const { rows } = await rlsPool().query<{ ok: boolean }>(
      "SELECT _dashboard.realtime_can_select($1, $2, $3, $4, $5, $6) AS ok",
      [
        event.schema,
        event.table,
        row === null ? null : JSON.stringify(row),
        keys === null ? null : JSON.stringify(keys),
        event.type,
        JSON.stringify(claims),
      ],
    );
    const ok = rows[0]?.ok === true;
    if (!ok) {
      // The check ran but the policy said no. For an authorized table that
      // delivers nothing this is the difference between "RLS is filtering as
      // intended" and "every event is being dropped" — record it so the logs
      // page shows denials per subscriber. Throttled in logRealtime.
      logRealtime({
        schema: event.schema,
        table: event.table,
        level: "warn",
        event: "authorize_deny",
        subscriber: typeof claims.sub === "string" ? claims.sub : null,
        detail: { op: event.type, truncated: event.truncated ?? false },
      });
    }
    return ok;
  } catch (e) {
    // The check THREW — previously swallowed silently, which is exactly what
    // makes authorized mode "mysteriously" deliver nothing (bad grant, missing
    // claim, policy error). Surface the real reason on the logs page.
    logRealtime({
      schema: event.schema,
      table: event.table,
      level: "error",
      event: "authorize_error",
      subscriber: typeof claims.sub === "string" ? claims.sub : null,
      detail: { op: event.type, message: (e as Error).message },
    });
    return false;
  }
}
