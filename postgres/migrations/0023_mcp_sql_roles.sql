-- 0023_mcp_sql_roles.sql
-- Dedicated, narrowly-scoped roles for the MCP server's SQL paths, so a
-- personal access token's db:read / db:write scope maps to a HARD Postgres
-- boundary — not the application-layer PROTECTED_OBJECTS regex, which is
-- bypassable via quoted identifiers or a changed search_path.
--
-- Unlike dashboard_sql_rw (which relies on pg_read_all_data / pg_write_all_data
-- and can therefore reach _dashboard, auth, every schema), these roles get
-- EXPLICIT grants on the application schema (public) only. _dashboard, auth and
-- all other management schemas are unreachable simply because these roles are
-- never granted USAGE on them. Privileges are granted DIRECTLY to the role
-- (not through a predefined-role membership), so they take effect after
-- SET ROLE even though the roles are NOINHERIT — sidestepping the inheritance
-- trap that left dashboard_sql_rw unable to write anything on PG16+.
--
-- BYPASSRLS keeps the management-tool semantics the dashboard already uses
-- (operators/agents see every row; RLS constrains the PostgREST API clients,
-- not the dashboard). The MCP read path SET ROLEs into mcp_reader, the write
-- path into mcp_writer; db:ddl stays dashboard_admin (admin-scoped, trusted).
--
-- Purely additive: no app-facing role (anon, authenticated, authenticator,
-- service_role) is touched and nothing is REVOKEd, so application users are
-- entirely unaffected. Idempotent. Apply as a superuser / role admin (same as
-- every other migration here — they CREATE ROLE).
-- (Mirrored into postgres/init/02_roles.sql for fresh installs.)

BEGIN;

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
		CREATE ROLE mcp_reader NOLOGIN NOINHERIT BYPASSRLS;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
		CREATE ROLE mcp_writer NOLOGIN NOINHERIT BYPASSRLS;
	END IF;
END $$;

-- dashboard_admin (the dashboard's DB connection) must be a member to SET ROLE.
GRANT mcp_reader TO dashboard_admin;
GRANT mcp_writer TO dashboard_admin;

-- Application schema only. No grant on _dashboard / auth / etc. = walled off.
GRANT USAGE ON SCHEMA public TO mcp_reader, mcp_writer;

-- Existing tables / sequences in public.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_writer;

-- Future tables/sequences: the dashboard creates them as dashboard_admin
-- (apply_migration and the SQL editor's DDL path), so cover that owner.
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT ON TABLES TO mcp_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO mcp_writer;

COMMIT;
