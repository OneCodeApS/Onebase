-- Migration: dashboard-adjustable PostgREST "max rows per request".
-- Matches postgres/init/15_api_config.sql for installs that predate it.
-- Apply as the postgres superuser:
--   docker compose exec -T postgres psql -U postgres -d postgres -f - < postgres/migrations/0023_api_max_rows.sql
-- (or psql ... -f postgres/migrations/0023_api_max_rows.sql on the server)
--
-- Idempotent: CREATE OR REPLACE + REVOKE/GRANT can be re-run safely.
--
-- After applying, the dashboard's Settings page can set the value; it takes
-- effect on the next `docker compose restart postgrest` (live reload is off
-- behind PgBouncer). Also add PGRST_DB_MAX_ROWS to the postgrest service env
-- (default 1000) so the cap applies even before any override is set.

CREATE OR REPLACE FUNCTION _dashboard.set_api_max_rows(n integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF n IS NULL OR n <= 0 THEN
    EXECUTE 'ALTER ROLE authenticator RESET pgrst.db_max_rows';
  ELSE
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_max_rows = %L', n::text);
  END IF;
  PERFORM pg_notify('pgrst', 'reload config');
END;
$$;

REVOKE ALL ON FUNCTION _dashboard.set_api_max_rows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.set_api_max_rows(integer) TO dashboard_admin;
