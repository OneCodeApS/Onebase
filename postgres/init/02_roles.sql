-- Three logical roles used by the platform:
--   authenticator   — PostgREST connects as this; SET ROLE to anon/service_role
--   anon            — unauthenticated PostgREST requests
--   service_role    — authenticated PostgREST requests with a service JWT (bypasses RLS)
--   dashboard_admin — the admin dashboard's database connection (DDL, audit, etc.)
--
-- Passwords are read from the container environment via psql's \getenv.

\getenv authenticator_pw AUTHENTICATOR_PASSWORD
\getenv dashboard_admin_pw DASHBOARD_ADMIN_PASSWORD
\set bi_readonly_pw ''
\getenv bi_readonly_pw BI_READONLY_PASSWORD

-- anon: unauthenticated PostgREST traffic. NOLOGIN so it cannot connect directly.
CREATE ROLE anon NOLOGIN NOINHERIT;

-- service_role: bypasses RLS. NOLOGIN; reached via SET ROLE from authenticator.
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

-- authenticator: PostgREST connects as this. NOINHERIT so it must explicitly SET ROLE.
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD :'authenticator_pw';
GRANT anon TO authenticator;
GRANT service_role TO authenticator;
ALTER ROLE authenticator SET statement_timeout = '30s';

-- dashboard_admin: the dashboard's connection. Broad privileges within this DB.
-- BYPASSRLS so the management UI sees and edits every row regardless of the
-- policies meant to constrain anon/authenticated PostgREST clients.
-- Crucially, authenticator does NOT have access to this role, so it is unreachable
-- via PostgREST.
CREATE ROLE dashboard_admin LOGIN BYPASSRLS PASSWORD :'dashboard_admin_pw';
GRANT ALL ON DATABASE postgres TO dashboard_admin;

-- pg_read_all_stats lets the Home page's DB-health card see connections and
-- stats from every role (PostgREST's authenticator, postgres, etc.), not
-- just dashboard_admin's own sessions. Read-only stats access; no data access.
GRANT pg_read_all_stats TO dashboard_admin;

-- Server-side statement timeout. We can't rely on client-side
-- statement_timeout passed in the startup packet because PgBouncer drops
-- those (see ignore_startup_parameters). Enforced on the role instead.
ALTER ROLE dashboard_admin SET statement_timeout = '30s';

-- dashboard_admin needs full access to public so the dashboard's table browser,
-- SQL editor, etc. can read/modify any user data.
GRANT USAGE, CREATE ON SCHEMA public TO dashboard_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON TABLES TO dashboard_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON SEQUENCES TO dashboard_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON FUNCTIONS TO dashboard_admin;

-- Default privileges on the public schema for the API roles.
GRANT USAGE ON SCHEMA public TO anon, service_role;

-- service_role gets blanket access on public; per-object grants for anon are made
-- alongside each table definition.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT ALL ON FUNCTIONS TO service_role;

-- Restricted role the SQL editor SET ROLEs into for read_write users. It can
-- read AND write all data (pg_read_all_data + pg_write_all_data) and bypasses
-- RLS so operators see every row — but it is NOT an owner or superuser, so it
-- cannot run DDL (CREATE/DROP/ALTER), TRUNCATE, or role/grant management. That
-- removes the "effective DBA" power read_write users had through the editor
-- while still letting them edit data. read_only queries instead run in a
-- READ ONLY transaction; admins keep full dashboard_admin. The matching
-- migration is postgres/migrations/0020_sql_editor_role.sql.
CREATE ROLE dashboard_sql_rw NOLOGIN NOINHERIT BYPASSRLS;
GRANT pg_read_all_data  TO dashboard_sql_rw;
GRANT pg_write_all_data TO dashboard_sql_rw;
-- dashboard_admin must be a member to SET ROLE to it.
GRANT dashboard_sql_rw TO dashboard_admin;

-- MCP SQL roles. See postgres/migrations/0027_mcp_sql_roles.sql for the full
-- rationale. Narrow, explicit-grant roles the MCP server SET ROLEs into for
-- db:read / db:write tokens. Unlike dashboard_sql_rw they have NO access to
-- _dashboard, auth, etc. — only the public application schema — so a token's
-- scope is a hard Postgres boundary, not just the app-layer regex. Privileges
-- are granted DIRECTLY (not via pg_*_all_data) so they apply after SET ROLE
-- despite NOINHERIT. BYPASSRLS matches the dashboard's see-every-row model.
CREATE ROLE mcp_reader NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE mcp_writer NOLOGIN NOINHERIT BYPASSRLS;
GRANT mcp_reader TO dashboard_admin;
GRANT mcp_writer TO dashboard_admin;

GRANT USAGE ON SCHEMA public TO mcp_reader, mcp_writer;
-- public tables are created later in init by the bootstrap superuser, and at
-- runtime by dashboard_admin — cover both owners via default privileges so
-- every public table is reachable without re-granting.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT ON TABLES TO mcp_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO mcp_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT ON TABLES TO mcp_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO mcp_writer;

-- bi_readonly: a read-only LOGIN role for external SQL clients / BI tools
-- (Power BI, Excel, DBeaver) that connect to the database directly over an SSH
-- tunnel. The DB port is never public (prod publishes 127.0.0.1 only), so the
-- tunnel is the access path. SELECT on `public` ONLY — never granted USAGE on
-- _dashboard / auth / etc., so credentials, secrets and the audit log are
-- unreachable. BYPASSRLS so reporting sees every row (RLS constrains the public
-- PostgREST clients, not this admin-issued reporting login; ALTER to
-- NOBYPASSRLS if you want RLS applied). Created NOLOGIN and only flipped to
-- LOGIN when BI_READONLY_PASSWORD is set, so it can never accept an empty
-- password. The matching migration is postgres/migrations/0030_bi_readonly_role.sql.
CREATE ROLE bi_readonly NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO bi_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT ON TABLES TO bi_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT ON TABLES TO bi_readonly;

-- Seed the password only while the role has none (always true here on a fresh
-- init). Kept symmetric with migration 0030, which uses the same guard so a
-- rotated password is never reverted on re-run.
SELECT
	(:'bi_readonly_pw' <> '') AS bi_readonly_has_pw,
	NOT EXISTS (
		SELECT 1 FROM pg_authid
		WHERE rolname = 'bi_readonly' AND rolpassword IS NOT NULL
	) AS bi_readonly_needs_pw
\gset
\if :bi_readonly_has_pw
	\if :bi_readonly_needs_pw
		ALTER ROLE bi_readonly LOGIN PASSWORD :'bi_readonly_pw';
	\endif
\endif
