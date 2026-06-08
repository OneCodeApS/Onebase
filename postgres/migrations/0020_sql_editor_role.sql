-- 0020_sql_editor_role.sql
-- Restricted role for the SQL editor's read_write users: read/write all data
-- (bypassing RLS so operators see every row), but no DDL / TRUNCATE / role
-- management. The dashboard SET ROLEs into this for read_write queries; admins
-- keep full dashboard_admin, read_only runs in a READ ONLY transaction.
-- Idempotent. (Mirrored into postgres/init/02_roles.sql for fresh installs.)

BEGIN;

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_sql_rw') THEN
		CREATE ROLE dashboard_sql_rw NOLOGIN NOINHERIT BYPASSRLS;
	END IF;
END $$;

GRANT pg_read_all_data  TO dashboard_sql_rw;
GRANT pg_write_all_data TO dashboard_sql_rw;
GRANT dashboard_sql_rw TO dashboard_admin;

COMMIT;
