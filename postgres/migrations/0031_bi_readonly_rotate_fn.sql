-- 0031_bi_readonly_rotate_fn.sql
-- SECURITY DEFINER helper that lets the dashboard rotate the bi_readonly login
-- password from the UI (Admin → Settings → Direct database access). dashboard_admin
-- is not a superuser and has no CREATEROLE, so it cannot ALTER ROLE directly —
-- same reason _dashboard.set_api_max_rows() exists (migration 0023). The function
-- is owned by the superuser that applies this migration, so it runs with the
-- privilege to ALTER ROLE; EXECUTE is granted to dashboard_admin only.
--
-- The new password is passed as a bound parameter from the dashboard, so it never
-- appears in the call's query text; ALTER ROLE … PASSWORD is redacted from the
-- Postgres logs. Rotating also (re-)enables LOGIN, so this doubles as the in-UI
-- way to set the password the first time without editing .env.
--
-- Idempotent (CREATE OR REPLACE + REVOKE/GRANT). Apply as the postgres superuser.
-- (Mirrored into postgres/init/17_bi_readonly.sql for fresh installs.)

CREATE OR REPLACE FUNCTION _dashboard.rotate_bi_readonly_password(new_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF new_password IS NULL OR length(new_password) < 16 THEN
    RAISE EXCEPTION 'new_password must be at least 16 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_readonly') THEN
    RAISE EXCEPTION 'role bi_readonly does not exist — apply migration 0030 first';
  END IF;
  -- %L safely quotes the literal; LOGIN (re-)enables a role left disabled.
  EXECUTE format('ALTER ROLE bi_readonly LOGIN PASSWORD %L', new_password);
END;
$$;

REVOKE ALL ON FUNCTION _dashboard.rotate_bi_readonly_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.rotate_bi_readonly_password(text) TO dashboard_admin;
