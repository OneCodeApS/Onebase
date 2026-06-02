-- 0016_app_owner_rls.sql
-- Let every dashboard admin manage RLS (and table DDL) on public tables.
--
-- The problem: the dashboard connects as `dashboard_admin`, which has
-- BYPASSRLS and ALL privileges on the database but is NOT a superuser and is
-- NOT the *owner* of the tables created during DB init. Postgres requires
-- table ownership (or membership in the owning role, or superuser) to run
-- CREATE/ALTER/DROP POLICY and ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
-- Privileges like ALL/BYPASSRLS do not count. Init tables (e.g. public.todos)
-- are created by the bootstrap `postgres` superuser, so they're owned by
-- `postgres` and the dashboard's RLS UI fails with "must be owner of table".
--
-- The fix: a NOLOGIN group role `app_owner` that owns every public table.
-- `dashboard_admin` is granted membership WITH INHERIT, so it passes Postgres's
-- ownership checks for those tables and can manage their policies. Because all
-- dashboard admins share the single `dashboard_admin` connection, this gives
-- the whole admin team RLS management without pinning ownership to one login
-- role. An event trigger keeps future public tables owned by `app_owner` so
-- this never regresses for newly created tables.
--
-- MUST be run as the `postgres` superuser (creating roles, reassigning
-- ownership of postgres-owned tables, and CREATE EVENT TRIGGER all require it):
--
--   docker compose exec -T postgres \
--     psql -U postgres -d "$POSTGRES_DB" < postgres/migrations/0016_app_owner_rls.sql
--
-- Idempotent: safe to run more than once.

BEGIN;

-- 1. The shared owner role. NOLOGIN: nobody connects as it; it exists only to
--    hold ownership of public objects.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;
  END IF;
END $$;

-- 2. Membership. INHERIT TRUE is what makes dashboard_admin pass ownership
--    checks (CREATE POLICY, ENABLE RLS, ALTER TABLE) on app_owner's tables.
--    postgres is a superuser already, but membership lets it ALTER ... OWNER TO
--    app_owner without special-casing.
GRANT app_owner TO dashboard_admin WITH INHERIT TRUE;
GRANT app_owner TO postgres WITH INHERIT TRUE;

-- 3. Reassign existing public tables (ordinary + partitioned) to app_owner.
--    Leaves platform schemas (_dashboard, auth, pg_catalog, ...) untouched.
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
      AND c.relkind IN ('r', 'p')   -- ordinary and partitioned tables
      AND o.rolname <> 'app_owner'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner', r.relname);
  END LOOP;
END $$;

-- 4. Auto-assign ownership of any NEW public table to app_owner. SECURITY
--    DEFINER so it runs as this script's superuser owner regardless of who ran
--    the CREATE TABLE (dashboard_admin via the SQL editor, postgres via psql,
--    a later init script, etc.) — mirrors the realtime helpers in 0006.
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
    -- Only newly created tables in public that aren't already app_owner's.
    IF obj.object_type = 'table'
       AND obj.schema_name = 'public'
       AND EXISTS (
         SELECT 1
         FROM pg_class c
         JOIN pg_roles r ON r.oid = c.relowner
         WHERE c.oid = obj.objid AND r.rolname <> 'app_owner'
       )
    THEN
      -- Don't let a reassign failure abort the user's CREATE TABLE; warn
      -- instead so the table is still created and can be fixed manually.
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

COMMIT;
