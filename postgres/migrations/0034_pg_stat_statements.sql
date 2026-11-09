-- 0034_pg_stat_statements.sql
-- Per-query statistics: calls, total / mean time, rows, and buffer hits versus
-- reads for every statement the server runs, with literals normalised out.
-- This is what "which query is slow" is answered from. Without it the only
-- performance signal is the cumulative cache-hit ratio on the Home page, which
-- says THAT reads miss the cache but not WHICH query causes them.
--
-- Installed into the _dashboard schema on purpose: the extension grants SELECT
-- on its view to PUBLIC, and PostgREST exposes everything in `public`, so
-- installing it there would publish query shapes under /rest/v1. dashboard_admin
-- sees every row through pg_read_all_stats (0013); the SQL editor roles through
-- pg_read_all_data (0020). Roles without those see other users' query text as
-- "<insufficient privilege>".
--
-- Requires `shared_preload_libraries=pg_stat_statements` on the server
-- (docker-compose.yml, postgres command flags). CREATE EXTENSION succeeds
-- without it, but querying the view then errors with "pg_stat_statements must
-- be loaded via shared_preload_libraries" until Postgres is restarted with the
-- library loaded. See docs/OPERATIONS.md → "Postgres and MinIO resource
-- settings".
--
-- Mirrored in postgres/init/18_pg_stat_statements.sql for fresh installs.
-- Idempotent: safe on fresh installs and existing deployments.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA _dashboard;

COMMIT;
