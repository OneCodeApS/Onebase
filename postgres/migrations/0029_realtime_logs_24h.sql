-- 0029_realtime_logs_24h.sql
-- Shorten realtime-log retention: errors now expire after 24h too (was 7 days).
--
-- The realtime log (0026) is a debugging aid, not an audit trail — there's no
-- value in keeping rows for days. This redefines _dashboard.prune_realtime_logs
-- so its DEFAULT p_error_age is 24h, matching the noise age. The engine calls
-- prune_realtime_logs() with no args, so this changes its behaviour with no
-- code change. The error/noise split (and the count caps) is kept so a deny
-- storm still can't evict error rows within the 24h window.
--
-- Idempotent. Mirrored into postgres/init/09_realtime.sql for fresh installs.

CREATE OR REPLACE FUNCTION _dashboard.prune_realtime_logs(
  p_error_age  interval DEFAULT interval '24 hours',
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
  -- Age: everything older than 24h goes (errors kept no longer than noise now).
  DELETE FROM _dashboard.realtime_logs
   WHERE level <> 'error' AND created_at < now() - p_noise_age;
  DELETE FROM _dashboard.realtime_logs
   WHERE level = 'error' AND created_at < now() - p_error_age;

  -- Count cap on noise alone — keep only the newest p_max_noise non-error rows,
  -- so a deny storm can't evict error rows. (NULL when under cap → no-op.)
  DELETE FROM _dashboard.realtime_logs
   WHERE level <> 'error'
     AND id < (
       SELECT id FROM _dashboard.realtime_logs
        WHERE level <> 'error'
        ORDER BY id DESC
        OFFSET p_max_noise LIMIT 1
     );

  -- Absolute ceiling across all rows — disk-safety backstop.
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
