-- 0024_postgrest_reload.sql
-- Auto-reload PostgREST's schema cache on DDL (existing installs).
--
-- Companion to the docker-compose change that moves PostgREST onto a DIRECT
-- session connection with PGRST_DB_CHANNEL_ENABLED=true. With the channel back
-- on, these event triggers make PostgREST refresh its schema cache after any
-- DDL, so new tables/columns appear under /rest/v1 without a manual
-- `docker compose restart postgrest`. See postgres/init/16_postgrest_reload.sql
-- for the full rationale.
--
-- IMPORTANT: applying this migration alone is not enough — PostgREST must be on
-- a direct connection with the channel enabled (compose change) for the NOTIFY
-- to be received, AND it must be restarted once to pick up that config and
-- thereby learn about any tables added since its last start. After that, this
-- trigger keeps it in sync automatically.
--
-- Idempotent: CREATE OR REPLACE + DROP IF EXISTS / CREATE.

CREATE OR REPLACE FUNCTION _dashboard.pgrst_reload()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

DROP EVENT TRIGGER IF EXISTS pgrst_reload_on_ddl;
CREATE EVENT TRIGGER pgrst_reload_on_ddl
  ON ddl_command_end
  EXECUTE FUNCTION _dashboard.pgrst_reload();

DROP EVENT TRIGGER IF EXISTS pgrst_reload_on_drop;
CREATE EVENT TRIGGER pgrst_reload_on_drop
  ON sql_drop
  EXECUTE FUNCTION _dashboard.pgrst_reload();
