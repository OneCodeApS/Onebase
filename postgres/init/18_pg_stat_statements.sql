-- Per-query statistics (calls, total / mean time, rows, buffer hits vs reads),
-- the source for "which query is slow". The server loads the library via
-- shared_preload_libraries in docker-compose.yml; this creates the extension.
--
-- Installed into _dashboard, not public: the extension grants SELECT on its
-- view to PUBLIC and PostgREST exposes all of `public`, so installing it there
-- would publish query shapes under /rest/v1. dashboard_admin reads every row
-- through pg_read_all_stats (02_roles.sql). The _dashboard schema is created in
-- 03_audit_log.sql — the 18_ prefix orders this after it.
-- Mirrors postgres/migrations/0034_pg_stat_statements.sql.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA _dashboard;
