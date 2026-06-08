-- Cron-scheduled invocations of edge functions. The dashboard's in-process
-- scheduler (dashboard/lib/cron.ts, booted from instrumentation.ts) reads
-- enabled rows here and fires the named function on each schedule.
--
-- Mirrors postgres/migrations/0011_cron_jobs.sql for fresh installs. The FK to
-- _dashboard.functions(name) is why this file runs after 10_functions.sql.

CREATE TABLE _dashboard.cron_jobs (
	name              text PRIMARY KEY
	                  CHECK (name ~ '^[a-z][a-z0-9_-]{0,62}$'),
	schedule          text NOT NULL,
	function_name     text NOT NULL,
	enabled           boolean NOT NULL DEFAULT true,
	last_run_at       timestamptz,
	last_status       text CHECK (last_status IN ('success','failed','running')),
	last_error        text,
	last_duration_ms  integer,
	created_at        timestamptz NOT NULL DEFAULT now(),
	updated_at        timestamptz NOT NULL DEFAULT now(),
	updated_by        uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL,
	FOREIGN KEY (function_name) REFERENCES _dashboard.functions(name) ON DELETE CASCADE
);

CREATE INDEX cron_jobs_enabled_idx
	ON _dashboard.cron_jobs (enabled) WHERE enabled = true;

GRANT ALL ON _dashboard.cron_jobs TO dashboard_admin;
