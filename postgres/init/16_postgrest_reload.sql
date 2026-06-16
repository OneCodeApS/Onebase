-- Auto-reload PostgREST's schema cache on DDL.
--
-- PostgREST builds its view of the database schema at startup and only refreshes
-- it when it receives NOTIFY on the `pgrst` channel. That requires two things,
-- both now in place (see the postgrest service in docker-compose.yml):
--   1. PGRST_DB_CHANNEL_ENABLED=true, and
--   2. a DIRECT (session) connection to Postgres — a transaction-pooled
--      connection silently drops the LISTEN, which is why PostgREST is no longer
--      routed through PgBouncer.
--
-- These event triggers fire that NOTIFY after every schema change, so new
-- tables / columns / functions appear under /rest/v1 within a second — no manual
-- `docker compose restart postgrest`. Without this, a freshly created table 404s
-- over REST until PostgREST is restarted (the bug this fixes).
--
-- Runs as the `postgres` superuser on first boot (event triggers require
-- superuser). Mirrors the SECURITY DEFINER + pinned search_path style of the
-- app_owner trigger in 07_app_owner.sql. The matching migration for existing
-- installs is postgres/migrations/0024_postgrest_reload.sql.

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

-- ddl_command_end covers CREATE/ALTER/GRANT/COMMENT; sql_drop covers DROP (which
-- never shows up in ddl_command_end). Both point at the same NOTIFY-only
-- function. Reloads are cheap and debounced by PostgREST, so we don't filter by
-- command tag.
DROP EVENT TRIGGER IF EXISTS pgrst_reload_on_ddl;
CREATE EVENT TRIGGER pgrst_reload_on_ddl
  ON ddl_command_end
  EXECUTE FUNCTION _dashboard.pgrst_reload();

DROP EVENT TRIGGER IF EXISTS pgrst_reload_on_drop;
CREATE EVENT TRIGGER pgrst_reload_on_drop
  ON sql_drop
  EXECUTE FUNCTION _dashboard.pgrst_reload();
