-- SECURITY DEFINER helper to rotate the bi_readonly login password from the
-- dashboard (Admin → Settings → Direct database access). dashboard_admin is not
-- a superuser and cannot ALTER ROLE directly, so this owned-by-superuser function
-- does it on its behalf; EXECUTE is granted to dashboard_admin only.
--
-- The bi_readonly role itself is created in 02_roles.sql. This file only adds the
-- rotation helper, so it must run after the _dashboard schema exists (created in
-- 03_audit_log.sql) — the 17_ prefix orders it last.
-- Mirrors postgres/migrations/0031_bi_readonly_rotate_fn.sql.

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
