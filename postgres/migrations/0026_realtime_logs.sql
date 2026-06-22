-- 0026_realtime_logs.sql
-- Observability for the realtime change stream.
--
-- Authorized mode fails CLOSED: _dashboard.realtime_can_select returns false on
-- ANY error and the dashboard's fan-out hub silently drops the event for that
-- subscriber. That is correct for safety but terrible for diagnosis — a
-- misconfigured policy, a missing grant, or a malformed claim all look
-- identical from the outside: "basic works, authorized delivers nothing."
--
-- This table is where the engine records realtime diagnostics — authorize
-- errors (the previously-swallowed exception), per-subscriber denials, and
-- connection lifecycle — so the dashboard can surface them on a logs page
-- instead of leaving operators guessing. Writes come from the dashboard
-- (dashboard_admin) via lib/realtime-log.ts; it is never on the hot delivery
-- path for successful events.
--
-- Idempotent. Mirrored into postgres/init/09_realtime.sql for fresh installs.

-- ── 1. Log table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _dashboard.realtime_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  schema      text NOT NULL,
  "table"     text NOT NULL,
  -- 'info'  → lifecycle (subscribe / unsubscribe / token expiry)
  -- 'warn'  → a subscriber was legitimately denied an event by RLS
  -- 'error' → the authorize check threw, a payload was unparseable, or the
  --           listener connection dropped — i.e. something is broken.
  level       text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  -- Short machine-readable event name, e.g. 'authorize_error', 'authorize_deny',
  -- 'subscribe', 'token_expired', 'connection_lost', 'payload_parse_error'.
  event       text NOT NULL,
  -- The subscriber's auth uid (claims.sub) when the entry is per-subscriber.
  subscriber  uuid,
  -- Free-form context: error message, operation, reason, etc.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Newest-first listing, and the per-table filtered view the logs page uses.
CREATE INDEX IF NOT EXISTS realtime_logs_created_idx
  ON _dashboard.realtime_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS realtime_logs_table_idx
  ON _dashboard.realtime_logs (schema, "table", created_at DESC);

REVOKE ALL ON TABLE _dashboard.realtime_logs FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE _dashboard.realtime_logs TO dashboard_admin;

-- ── 2. Retention ────────────────────────────────────────────────────────────
-- Bounded by age AND by row count, with a deliberate split between 'error' rows
-- (rare, the reason this log exists) and routine 'info'/'warn' noise (lifecycle
-- + per-subscriber RLS denials, which a correctly-working authorized table
-- emits constantly). The noise has its OWN, tighter age and count caps so a
-- deny storm on one table can never evict the error rows that matter. The
-- engine calls this opportunistically (a small fraction of writes); idempotent.
CREATE OR REPLACE FUNCTION _dashboard.prune_realtime_logs(
  p_error_age  interval DEFAULT interval '7 days',
  p_noise_age  interval DEFAULT interval '24 hours',
  p_max_rows   integer  DEFAULT 50000,
  p_max_noise  integer  DEFAULT 20000
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- 1. Age: noise expires fast, errors are kept far longer.
  DELETE FROM _dashboard.realtime_logs
   WHERE level <> 'error' AND created_at < now() - p_noise_age;
  DELETE FROM _dashboard.realtime_logs
   WHERE level = 'error' AND created_at < now() - p_error_age;

  -- 2. Count cap on noise alone — keep only the newest p_max_noise non-error
  --    rows. (subquery returns NULL when under the cap → deletes nothing.)
  DELETE FROM _dashboard.realtime_logs
   WHERE level <> 'error'
     AND id < (
       SELECT id FROM _dashboard.realtime_logs
        WHERE level <> 'error'
        ORDER BY id DESC
        OFFSET p_max_noise LIMIT 1
     );

  -- 3. Absolute ceiling across all rows — disk-safety backstop.
  DELETE FROM _dashboard.realtime_logs
   WHERE id < (
     SELECT id FROM _dashboard.realtime_logs
      ORDER BY id DESC
      OFFSET p_max_rows LIMIT 1
   );
END;
$$;

REVOKE ALL ON FUNCTION _dashboard.prune_realtime_logs(interval, interval, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.prune_realtime_logs(interval, interval, integer, integer) TO dashboard_admin;
