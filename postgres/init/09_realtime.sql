-- Per-table realtime via pg_notify. Admins enable realtime per table from the
-- dashboard; a trigger is installed/dropped on that table accordingly.
--
-- Mirrors postgres/migrations/0005_realtime.sql and
-- 0006_realtime_security_definer.sql for fresh installs. The enable/disable
-- helpers are the final SECURITY DEFINER form (0006): they DROP TRIGGER, which
-- requires table ownership, so they must run as the function owner (postgres),
-- not the calling dashboard_admin.

-- Tracking table the dashboard reads/writes to show toggle state.
CREATE TABLE _dashboard.realtime_tables (
	schema      text NOT NULL,
	"table"     text NOT NULL,
	enabled     boolean NOT NULL DEFAULT true,
	updated_at  timestamptz NOT NULL DEFAULT now(),
	updated_by  uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL,
	PRIMARY KEY (schema, "table")
);

GRANT ALL ON _dashboard.realtime_tables TO dashboard_admin;

-- Trigger function: builds a small JSON event and emits it on a
-- `realtime:<schema>:<table>` channel that SSE subscribers LISTEN on.
-- Payload max ~8000 bytes per pg_notify; oversize rows are dropped (we send
-- a smaller diff in that case so subscribers still see SOMETHING happened).
CREATE OR REPLACE FUNCTION _dashboard.realtime_notify()
RETURNS trigger AS $$
DECLARE
	channel text;
	full_payload jsonb;
	full_text text;
BEGIN
	channel := 'realtime:' || TG_TABLE_SCHEMA || ':' || TG_TABLE_NAME;
	full_payload := jsonb_build_object(
		'type',     TG_OP,
		'schema',   TG_TABLE_SCHEMA,
		'table',    TG_TABLE_NAME,
		'old',      CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
		'new',      CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END,
		'ts',       now()
	);
	full_text := full_payload::text;

	IF octet_length(full_text) <= 7900 THEN
		PERFORM pg_notify(channel, full_text);
	ELSE
		-- Strip row data and just announce the change happened.
		PERFORM pg_notify(
			channel,
			jsonb_build_object(
				'type',      TG_OP,
				'schema',    TG_TABLE_SCHEMA,
				'table',     TG_TABLE_NAME,
				'truncated', true,
				'ts',        now()
			)::text
		);
	END IF;

	RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Helpers the dashboard calls. Identifiers come from the dashboard which
-- already validates them, but we use format(%I) for defense in depth.
-- SECURITY DEFINER so DROP TRIGGER (needs table ownership) succeeds; without
-- it disable_realtime silently no-ops while enable_realtime works.
CREATE OR REPLACE FUNCTION _dashboard.enable_realtime(p_schema text, p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
	EXECUTE format(
		'DROP TRIGGER IF EXISTS realtime_notify_trigger ON %I.%I',
		p_schema, p_table
	);
	EXECUTE format(
		'CREATE TRIGGER realtime_notify_trigger '
		'AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
		'FOR EACH ROW EXECUTE FUNCTION _dashboard.realtime_notify()',
		p_schema, p_table
	);
	INSERT INTO _dashboard.realtime_tables (schema, "table", enabled, updated_at)
	VALUES (p_schema, p_table, true, now())
	ON CONFLICT (schema, "table") DO UPDATE
		SET enabled = true, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION _dashboard.disable_realtime(p_schema text, p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
	EXECUTE format(
		'DROP TRIGGER IF EXISTS realtime_notify_trigger ON %I.%I',
		p_schema, p_table
	);
	INSERT INTO _dashboard.realtime_tables (schema, "table", enabled, updated_at)
	VALUES (p_schema, p_table, false, now())
	ON CONFLICT (schema, "table") DO UPDATE
		SET enabled = false, updated_at = now();
END;
$$;
