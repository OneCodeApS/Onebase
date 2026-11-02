-- 0031_sql_rw_inherit.sql
-- dashboard_sql_rw (0020) is the role the SQL editor and the Tables page SET
-- ROLE into for read_write users. It was created NOINHERIT and made a member of
-- pg_read_all_data / pg_write_all_data, but a NOINHERIT member does not receive
-- the privileges of the roles it belongs to -- so after SET ROLE dashboard_sql_rw
-- every table read or write failed with "permission denied for table". Re-grant
-- both memberships WITH INHERIT TRUE (PG16+), which applies the predefined
-- roles' privileges regardless of the member's own INHERIT attribute. The role
-- itself stays NOINHERIT, so nothing else it might be granted later leaks in.
-- Purely additive, no REVOKE. Idempotent (re-granting updates the option).
-- (Mirrored into postgres/init/02_roles.sql for fresh installs.)

BEGIN;

GRANT pg_read_all_data  TO dashboard_sql_rw WITH INHERIT TRUE;
GRANT pg_write_all_data TO dashboard_sql_rw WITH INHERIT TRUE;

COMMIT;