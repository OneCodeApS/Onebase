-- Shared owner role for public tables, so the dashboard can manage RLS.
--
-- The dashboard connects as `dashboard_admin` (see 02_roles.sql), which has
-- BYPASSRLS and ALL privileges but is neither a superuser nor the *owner* of
-- the tables these init scripts create as the `postgres` superuser. Postgres
-- requires table ownership (or membership in the owning role) to run
-- CREATE/ALTER/DROP POLICY and ALTER TABLE ... ENABLE ROW LEVEL SECURITY, so
-- without this the dashboard's RLS UI fails with "must be owner of table".
--
-- We introduce a NOLOGIN group role `app_owner` that owns every public table,
-- and make `dashboard_admin` a member of it (WITH INHERIT). All dashboard
-- admins share that one connection, so the whole team gains RLS management
-- without tying ownership to a single login role. An event trigger keeps any
-- future public table owned by `app_owner` automatically.
--
-- This runs as the `postgres` superuser on first boot only. Fresh installs
-- start with an empty public schema (the old sample `todos` table was removed
-- from 04_sample_schema.sql), so the reassignment loop below is usually a no-op
-- on first boot — its real job is the event trigger, which keeps every table
-- created later (by the dashboard, SQL editor, etc.) owned by app_owner. The
-- later feature scripts (09 and up) only add tables in the _dashboard / auth
-- schemas, which the event trigger intentionally ignores (it reassigns public
-- tables only), so their position after this file is fine. The matching
-- migration for existing installs is postgres/migrations/0016_app_owner_rls.sql.

-- The shared owner role. NOLOGIN: it exists only to hold ownership.
CREATE ROLE app_owner NOLOGIN;

-- INHERIT TRUE is what lets dashboard_admin pass ownership checks (CREATE
-- POLICY, ENABLE RLS, ALTER TABLE) on tables owned by app_owner.
GRANT app_owner TO dashboard_admin WITH INHERIT TRUE;
GRANT app_owner TO postgres WITH INHERIT TRUE;

-- Reassign existing public tables (ordinary + partitioned) to app_owner.
-- Platform schemas (_dashboard, auth, ...) are intentionally left untouched.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles    o ON o.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND o.rolname <> 'app_owner'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner', r.relname);
  END LOOP;
END $$;

-- Auto-assign ownership of any NEW public table to app_owner. SECURITY DEFINER
-- so it runs as the postgres owner of this function regardless of who ran the
-- CREATE TABLE — mirrors the realtime SECURITY DEFINER helpers.
CREATE OR REPLACE FUNCTION _dashboard.assign_public_table_owner()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type = 'table'
       AND obj.schema_name = 'public'
       AND EXISTS (
         SELECT 1
         FROM pg_class c
         JOIN pg_roles r ON r.oid = c.relowner
         WHERE c.oid = obj.objid AND r.rolname <> 'app_owner'
       )
    THEN
      BEGIN
        EXECUTE format('ALTER TABLE %s OWNER TO app_owner', obj.object_identity);
      EXCEPTION WHEN others THEN
        RAISE WARNING 'app_owner: could not reassign owner of %: %',
          obj.object_identity, SQLERRM;
      END;
    END IF;
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS app_owner_assign_on_create;
CREATE EVENT TRIGGER app_owner_assign_on_create
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION _dashboard.assign_public_table_owner();
