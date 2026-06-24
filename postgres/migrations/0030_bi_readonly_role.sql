-- 0030_bi_readonly_role.sql
-- A read-only LOGIN role for external SQL clients / BI tools (e.g. Power BI,
-- Excel, DBeaver) that connect to the database directly over an SSH tunnel —
-- the database port is never exposed to the public network (see
-- docker-compose.prod.yml: postgres is published on 127.0.0.1 only, reachable
-- from the server itself and therefore via `ssh -L`).
--
-- Scope: SELECT on the application schema (public) ONLY. Like mcp_reader, it is
-- never granted USAGE on _dashboard, auth, or any other management schema, so
-- credentials, secrets, and the audit log are unreachable at the database layer
-- regardless of how the query is written. It is BYPASSRLS so reporting sees
-- every row (the dashboard's see-every-row model) — RLS constrains the public
-- PostgREST API clients, not this trusted, admin-issued reporting login. If you
-- prefer RLS to apply to BI queries, `ALTER ROLE bi_readonly NOBYPASSRLS;`.
--
-- The password comes from BI_READONLY_PASSWORD in the container environment, but
-- only as a ONE-TIME SEED: it is applied only while the role still has no
-- password (first creation, or to enable a role you left disabled). Once the
-- role has a password, this migration never touches it again — so re-running it
-- (every upgrade re-runs all migrations) can NEVER revert a password you have
-- rotated. The live password lives in Postgres, not in .env.
--
-- To ROTATE (e.g. after a leak), run a single statement — instant, no restart:
--     ALTER ROLE bi_readonly PASSWORD '<new>';
-- (.env can stay as-is; it's only the seed and is no longer re-asserted.) To
-- enable a role first created while BI_READONLY_PASSWORD was empty: set the
-- variable, recreate the postgres container so it sees the env, and re-run this.
--
-- Purely additive: no existing role is touched and nothing is REVOKEd, so
-- application users and the dashboard are entirely unaffected. Idempotent.
-- Apply as a superuser / role admin (it CREATE ROLEs). Run through psql so the
-- \getenv / \gset / \if meta-commands work (the migration loop in the CHANGELOG
-- and docs/OPERATIONS.md does exactly this).
-- (Mirrored into postgres/init/02_roles.sql for fresh installs.)

\set bi_pw ''
\getenv bi_pw BI_READONLY_PASSWORD

BEGIN;

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_readonly') THEN
		-- Created disabled; the LOGIN + password is set below only when a
		-- password is configured, so the role can never accept connections
		-- with an empty password.
		CREATE ROLE bi_readonly NOLOGIN BYPASSRLS;
	END IF;
END $$;

-- Application schema only. No grant on _dashboard / auth / etc. = walled off.
GRANT USAGE ON SCHEMA public TO bi_readonly;

-- Existing tables in public.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bi_readonly;

-- Future tables: covered for both owners — the bootstrap superuser (init) and
-- dashboard_admin (apply_migration + the SQL editor's DDL path at runtime).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT ON TABLES TO bi_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_admin IN SCHEMA public
	GRANT SELECT ON TABLES TO bi_readonly;

COMMIT;

-- Seed the password ONLY while the role still has none, so a rotated password
-- (set later via ALTER ROLE) survives every re-run of this migration. Reading
-- pg_authid needs superuser — which is how this migration is applied (-U postgres).
SELECT
	(:'bi_pw' <> '') AS bi_has_pw,
	NOT EXISTS (
		SELECT 1 FROM pg_authid
		WHERE rolname = 'bi_readonly' AND rolpassword IS NOT NULL
	) AS bi_needs_pw
\gset
\if :bi_has_pw
	\if :bi_needs_pw
		ALTER ROLE bi_readonly LOGIN PASSWORD :'bi_pw';
	\else
		\echo 'bi_readonly already has a password — left unchanged (rotate with ALTER ROLE).'
	\endif
\else
	\echo 'BI_READONLY_PASSWORD not set — bi_readonly created/granted but left NOLOGIN (disabled).'
\endif
