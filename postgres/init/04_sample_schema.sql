-- The `authenticated` role.
--
-- This is the role PostgREST SET ROLEs into for any request carrying a valid
-- end-user JWT (role=authenticated). It must exist for RLS policies to reference
-- it and for the auth flow to work, so it's created on first boot here.
--
-- There is intentionally NO sample table: fresh installs start with an empty
-- `public` schema. (A demo `todos` table used to live here; it was removed so
-- installs don't ship a stray, platform-owned table that the dashboard can't
-- manage — see the note on ownership below.)
--
-- NOTE ON OWNERSHIP: init scripts run as the `postgres` superuser, so anything
-- created here is owned by `postgres`, not `dashboard_admin`. The dashboard
-- connects as `dashboard_admin`, which has BYPASSRLS + full privileges but is
-- not an owner — so it can read/write rows but cannot ALTER/DROP a postgres-
-- owned table. If you ever seed a table in `public` that the dashboard should
-- manage, create it and then `ALTER TABLE ... OWNER TO dashboard_admin;`.

-- We need an 'authenticated' role for RLS policies to reference and for
-- PostgREST to SET ROLE into on JWT-authenticated requests.
CREATE ROLE authenticated NOLOGIN NOINHERIT;
GRANT authenticated TO authenticator;
GRANT USAGE ON SCHEMA public TO authenticated;
