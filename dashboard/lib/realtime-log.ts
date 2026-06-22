import { pool } from "./db";

// Diagnostics sink for the realtime change stream.
//
// Authorized mode fails CLOSED (see realtime-rls.ts): any error in the
// per-subscriber RLS check, an unparseable payload, or a dropped listener
// connection silently removes events from a subscriber's stream. That is the
// safe default, but it makes "basic works, authorized delivers nothing"
// impossible to diagnose from the outside. This module records WHY an event was
// dropped (or that a subscriber connected at all) into _dashboard.realtime_logs
// so the dashboard's logs page can show it.
//
// Hard rules:
//  - logging must NEVER throw into the realtime path (a broken log sink must not
//    break delivery), so every write is wrapped and failures only console.error;
//  - logging must NEVER be on the hot path for *successful* delivery — we record
//    errors, denials, and lifecycle, not every delivered row;
//  - a misconfigured table must not be able to storm the log — identical entries
//    are throttled per (table+event+subscriber) and rows are pruned by age/count.

export type RealtimeLogLevel = "info" | "warn" | "error";

export type RealtimeLogEntry = {
  schema: string;
  table: string;
  level: RealtimeLogLevel;
  event: string;
  subscriber?: string | null;
  detail?: Record<string, unknown>;
};

// Minimum gap between two identical entries (same table + event + subscriber),
// chosen per level. Errors are rare and high-value, so collapse only rapid
// duplicates. Denials and lifecycle are routine, expected, high-volume traffic
// (a working authorized table denies every event to every non-member) — they
// are throttled hard so the log carries a heartbeat ("sub X still denied on
// table Y, ≤1/min") rather than one row per message.
const ERROR_THROTTLE_MS = 10_000;
const NOISE_THROTTLE_MS = 60_000;

function throttleMs(level: RealtimeLogLevel): number {
  return level === "error" ? ERROR_THROTTLE_MS : NOISE_THROTTLE_MS;
}

// Opportunistic prune: roughly 1 in N writes also trims the table. Keeps the
// log bounded without a separate cron, and the prune itself is cheap.
const PRUNE_EVERY = 200;

const lastLogged = new Map<string, number>();
let writeCount = 0;

// Bound the throttle map so a flood of distinct subscribers can't grow it
// without limit. When it gets large we drop the oldest-inserted halves; the
// worst case is a few extra log rows, never a leak.
function rememberThrottle(key: string, now: number): void {
  lastLogged.set(key, now);
  if (lastLogged.size > 5_000) {
    let i = 0;
    for (const k of lastLogged.keys()) {
      lastLogged.delete(k);
      if (++i >= 2_500) break;
    }
  }
}

export function logRealtime(entry: RealtimeLogEntry): void {
  const now = Date.now();
  const key = `${entry.schema}.${entry.table}|${entry.event}|${entry.subscriber ?? ""}`;
  const prev = lastLogged.get(key);
  if (prev !== undefined && now - prev < throttleMs(entry.level)) return;
  rememberThrottle(key, now);

  // Fire-and-forget: never await in the caller, never reject outward.
  void (async () => {
    try {
      await pool().query(
        `INSERT INTO _dashboard.realtime_logs
           (schema, "table", level, event, subscriber, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          entry.schema,
          entry.table,
          entry.level,
          entry.event,
          entry.subscriber ?? null,
          JSON.stringify(entry.detail ?? {}),
        ],
      );

      if (++writeCount % PRUNE_EVERY === 0) {
        await pool()
          .query("SELECT _dashboard.prune_realtime_logs()")
          .catch(() => {});
      }
    } catch (e) {
      // The log sink itself failed — say so on the server console, but do not
      // propagate: realtime must keep working even if logging is down.
      console.error("[realtime-log] write failed:", (e as Error).message);
    }
  })();
}
