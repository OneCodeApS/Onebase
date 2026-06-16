-- Dashboard-adjustable PostgREST config: API "max rows per request".
--
-- PostgREST's db-max-rows caps how many rows a single REST request can return.
-- We want admins to change it from the dashboard, but the dashboard connects as
-- `dashboard_admin`, which is not a superuser and has no rights to ALTER the
-- `authenticator` role. So we expose a SECURITY DEFINER helper (owned by the
-- postgres superuser that runs this script) which writes PostgREST's in-database
-- configuration — a GUC on the authenticator role that PostgREST reads on
-- startup / config reload and which overrides the PGRST_DB_MAX_ROWS env default.
--
-- NOTE: this stack runs PostgREST with db-channel-enabled=false (required behind
-- PgBouncer), so the NOTIFY-based live reload below is a no-op here and the new
-- value takes effect after `docker compose restart postgrest`. The compose env
-- PGRST_DB_MAX_ROWS provides the default until/unless an admin overrides it.

CREATE OR REPLACE FUNCTION _dashboard.set_api_max_rows(n integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- NULL or non-positive clears the override, falling back to the env default.
  IF n IS NULL OR n <= 0 THEN
    EXECUTE 'ALTER ROLE authenticator RESET pgrst.db_max_rows';
  ELSE
    -- n is an integer, so %L produces a safe quoted literal — no injection.
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_max_rows = %L', n::text);
  END IF;
  -- Best-effort live reload. Received only when PostgREST runs with
  -- db-channel-enabled=true; otherwise harmless and a restart applies the value.
  PERFORM pg_notify('pgrst', 'reload config');
END;
$$;

-- Only dashboard_admin (the dashboard's connection) may call it.
REVOKE ALL ON FUNCTION _dashboard.set_api_max_rows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.set_api_max_rows(integer) TO dashboard_admin;
