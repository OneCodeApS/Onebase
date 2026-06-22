-- Per-table realtime via pg_notify. Admins enable realtime per table from the
-- dashboard; a trigger is installed/dropped on that table accordingly.
--
-- Mirrors postgres/migrations/0005_realtime.sql, 0006_realtime_security_definer.sql
-- and 0025_realtime_authorized.sql for fresh installs. The enable/disable
-- helpers are SECURITY DEFINER: they DROP TRIGGER, which requires table
-- ownership, so they must run as the function owner (postgres), not the calling
-- dashboard_admin.
--
-- Realtime has two modes per table (the `mode` column):
--   'basic'      → table-level broadcast; the change is delivered to every
--                  subscriber. RLS is NOT applied (use only for tables whose
--                  rows all subscribers may see).
--   'authorized' → per-subscriber RLS filtering: before an event is forwarded to
--                  a subscriber, _dashboard.realtime_can_select re-evaluates the
--                  table's RLS SELECT policy for the changed row in that
--                  subscriber's auth context. A row a user can't read via REST
--                  can never reach them via realtime.

-- Tracking table the dashboard reads/writes to show toggle state.
CREATE TABLE _dashboard.realtime_tables (
	schema      text NOT NULL,
	"table"     text NOT NULL,
	enabled     boolean NOT NULL DEFAULT true,
	-- 'basic' = legacy table-level broadcast; 'authorized' = per-subscriber RLS.
	mode        text NOT NULL DEFAULT 'basic'
	            CHECK (mode IN ('basic', 'authorized')),
	updated_at  timestamptz NOT NULL DEFAULT now(),
	updated_by  uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL,
	PRIMARY KEY (schema, "table")
);

GRANT ALL ON _dashboard.realtime_tables TO dashboard_admin;

-- Does an RLS policy (its polroles oid[]) apply to `p_role`? Mirrors Postgres's
-- rule: PUBLIC (oid 0) or any role the target role is a member of. Called from
-- realtime_can_select, which is SECURITY INVOKER, so the `authenticator` caller
-- needs EXECUTE on it (granted below).
CREATE OR REPLACE FUNCTION _dashboard._policy_applies(p_roles oid[], p_role text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
	SELECT EXISTS (
		SELECT 1 FROM unnest(p_roles) AS r
		 WHERE r = 0 OR pg_has_role(p_role, r, 'MEMBER')
	);
$$;

-- Authorization primitive for authorized mode. Returns true iff a subscriber
-- with JWT claims `p_claims` may SELECT the changed row, per the table's RLS
-- SELECT policies — the SAME predicate PostgREST applies. It reads the catalog
-- and builds the combined policy expression, then does SET LOCAL ROLE
-- authenticated + sets request.jwt.claims and evaluates it, so RLS runs under
-- the unprivileged authenticated role exactly as a REST request would.
--
-- MUST be SECURITY INVOKER: it runs as its caller (the non-BYPASSRLS
-- `authenticator` connection the hub uses), which is allowed to SET ROLE
-- authenticated. As SECURITY DEFINER it would run as the owner, and Postgres
-- FORBIDS changing `role` inside a security-definer function (ERROR 42501) — the
-- EXCEPTION handler below would then swallow it and fail every check closed,
-- delivering nothing in authorized mode. See 0028_realtime_can_select_invoker.sql.
-- Fails CLOSED on any error, missing RLS, default-deny, invalid claims, or a
-- truncated DELETE.
CREATE OR REPLACE FUNCTION _dashboard.realtime_can_select(
	p_schema  text,
	p_table   text,
	p_row     jsonb,
	p_keys    jsonb,
	p_op      text,
	p_claims  jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
	v_relid       oid;
	v_rls_enabled boolean;
	v_permissive  text;
	v_restrictive text;
	v_expr        text;
	v_result      boolean;
BEGIN
	SELECT c.oid, c.relrowsecurity
	  INTO v_relid, v_rls_enabled
	  FROM pg_class c
	  JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE n.nspname = p_schema AND c.relname = p_table AND c.relkind = 'r';
	IF NOT FOUND OR NOT v_rls_enabled THEN
		RETURN false;  -- authorized mode requires RLS
	END IF;

	-- Truncated INSERT/UPDATE: only the PK was broadcast; the row still exists,
	-- so re-query it under RLS. Truncated DELETE has no image → fail closed.
	IF p_row IS NULL THEN
		IF p_keys IS NULL OR p_op NOT IN ('INSERT', 'UPDATE') THEN
			RETURN false;
		END IF;
		PERFORM set_config('role', 'authenticated', true);
		PERFORM set_config('request.jwt.claims', p_claims::text, true);
		EXECUTE format(
			'SELECT EXISTS (SELECT 1 FROM %I.%I t WHERE to_jsonb(t) @> $1)',
			p_schema, p_table
		) INTO v_result USING p_keys;
		RETURN coalesce(v_result, false);
	END IF;

	-- Normal path: permissive SELECT policies OR'd, restrictive AND'd on top.
	-- pg_get_expr runs with search_path = pg_catalog so it schema-qualifies every
	-- external reference, making the expression safe to evaluate in phase 2.
	SELECT string_agg('(' || pg_get_expr(pol.polqual, pol.polrelid) || ')', ' OR ')
	  INTO v_permissive
	  FROM pg_policy pol
	 WHERE pol.polrelid = v_relid
	   AND pol.polcmd IN ('r', '*')
	   AND pol.polpermissive
	   AND pol.polqual IS NOT NULL
	   AND _dashboard._policy_applies(pol.polroles, 'authenticated');

	IF v_permissive IS NULL THEN
		RETURN false;  -- RLS on, no permissive SELECT policy → default deny
	END IF;

	SELECT string_agg('(' || pg_get_expr(pol.polqual, pol.polrelid) || ')', ' AND ')
	  INTO v_restrictive
	  FROM pg_policy pol
	 WHERE pol.polrelid = v_relid
	   AND pol.polcmd IN ('r', '*')
	   AND NOT pol.polpermissive
	   AND pol.polqual IS NOT NULL
	   AND _dashboard._policy_applies(pol.polroles, 'authenticated');

	v_expr := '(' || v_permissive || ')';
	IF v_restrictive IS NOT NULL THEN
		v_expr := v_expr || ' AND (' || v_restrictive || ')';
	END IF;

	PERFORM set_config('role', 'authenticated', true);
	PERFORM set_config('request.jwt.claims', p_claims::text, true);
	EXECUTE format(
		'SELECT coalesce((%s), false) '
		'FROM (SELECT (jsonb_populate_record(NULL::%I.%I, $1)).*) AS %I',
		v_expr, p_schema, p_table, p_table
	) INTO v_result USING p_row;

	RETURN coalesce(v_result, false);
EXCEPTION WHEN OTHERS THEN
	RETURN false;  -- fail closed
END;
$$;

-- Only the hub's RLS-check connection (authenticator) may call it.
REVOKE ALL ON FUNCTION
	_dashboard.realtime_can_select(text, text, jsonb, jsonb, text, jsonb)
	FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	_dashboard.realtime_can_select(text, text, jsonb, jsonb, text, jsonb)
	TO authenticator;
-- realtime_can_select is SECURITY INVOKER, so the authenticator caller (not the
-- owner) evaluates _policy_applies — it needs EXECUTE on it too.
GRANT EXECUTE ON FUNCTION _dashboard._policy_applies(oid[], text) TO authenticator;
GRANT USAGE ON SCHEMA _dashboard TO authenticator;

-- Trigger function: builds a small JSON event and emits it on a
-- `realtime:<schema>:<table>` channel that SSE subscribers LISTEN on.
-- Payload max ~8000 bytes per pg_notify; oversize rows are sent without row data
-- but WITH the primary key ("keys") so authorized mode can still filter them.
-- The PK lookup is INLINED (no nested _dashboard.* call) so the trigger keeps
-- working for unprivileged writers, which have no _dashboard schema access.
CREATE OR REPLACE FUNCTION _dashboard.realtime_notify()
RETURNS trigger AS $$
DECLARE
	channel text;
	full_payload jsonb;
	full_text text;
	rec jsonb;
	keys jsonb;
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
		-- Strip row data but keep the primary key so authorized subscribers can
		-- still be filtered (re-query under RLS).
		rec := to_jsonb(COALESCE(NEW, OLD));
		SELECT jsonb_object_agg(a.attname, rec -> a.attname)
		  INTO keys
		  FROM pg_index i
		  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord)
		  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
		 WHERE i.indrelid = TG_RELID AND i.indisprimary;
		PERFORM pg_notify(
			channel,
			jsonb_build_object(
				'type',      TG_OP,
				'schema',    TG_TABLE_SCHEMA,
				'table',     TG_TABLE_NAME,
				'truncated', true,
				'keys',      keys,
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
CREATE OR REPLACE FUNCTION _dashboard.enable_realtime(
	p_schema text, p_table text, p_mode text DEFAULT 'basic'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
	IF p_mode NOT IN ('basic', 'authorized') THEN
		RAISE EXCEPTION 'invalid realtime mode: %', p_mode;
	END IF;
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
	INSERT INTO _dashboard.realtime_tables (schema, "table", enabled, mode, updated_at)
	VALUES (p_schema, p_table, true, p_mode, now())
	ON CONFLICT (schema, "table") DO UPDATE
		SET enabled = true, mode = EXCLUDED.mode, updated_at = now();
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

-- Lock the trigger-management helpers to the dashboard connection. They are
-- SECURITY DEFINER and now that `authenticator` can see the _dashboard schema
-- (for realtime_can_select), they must not be callable by it or by PUBLIC.
REVOKE ALL ON FUNCTION _dashboard.enable_realtime(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION _dashboard.disable_realtime(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.enable_realtime(text, text, text) TO dashboard_admin;
GRANT EXECUTE ON FUNCTION _dashboard.disable_realtime(text, text) TO dashboard_admin;

-- ── Realtime diagnostics log ────────────────────────────────────────────────
-- Mirrors postgres/migrations/0026_realtime_logs.sql. Authorized mode fails
-- closed and silently drops events on any error; the engine records the reason
-- here (authorize errors, per-subscriber denials, connection lifecycle) so the
-- dashboard's realtime logs page can surface failures instead of hiding them.
CREATE TABLE IF NOT EXISTS _dashboard.realtime_logs (
	id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	created_at  timestamptz NOT NULL DEFAULT now(),
	schema      text NOT NULL,
	"table"     text NOT NULL,
	level       text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
	event       text NOT NULL,
	subscriber  uuid,
	detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS realtime_logs_created_idx
	ON _dashboard.realtime_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS realtime_logs_table_idx
	ON _dashboard.realtime_logs (schema, "table", created_at DESC);

REVOKE ALL ON TABLE _dashboard.realtime_logs FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE _dashboard.realtime_logs TO dashboard_admin;

-- Retention: the log is a 24h debugging aid, not an audit trail — everything
-- expires after a day. The error/noise split + count caps are kept so a deny
-- storm can't evict error rows within that window. See 0026 / 0029.
CREATE OR REPLACE FUNCTION _dashboard.prune_realtime_logs(
	p_error_age  interval DEFAULT interval '24 hours',
	p_noise_age  interval DEFAULT interval '24 hours',
	p_max_rows   integer  DEFAULT 50000,
	p_max_noise  integer  DEFAULT 20000
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
	DELETE FROM _dashboard.realtime_logs
	 WHERE level <> 'error' AND created_at < now() - p_noise_age;
	DELETE FROM _dashboard.realtime_logs
	 WHERE level = 'error' AND created_at < now() - p_error_age;

	DELETE FROM _dashboard.realtime_logs
	 WHERE level <> 'error'
	   AND id < (
	     SELECT id FROM _dashboard.realtime_logs
	      WHERE level <> 'error'
	      ORDER BY id DESC
	      OFFSET p_max_noise LIMIT 1
	   );

	DELETE FROM _dashboard.realtime_logs
	 WHERE id < (
	   SELECT id FROM _dashboard.realtime_logs
	    ORDER BY id DESC
	    OFFSET p_max_rows LIMIT 1
	 );
END;
$$;

REVOKE ALL ON FUNCTION _dashboard.prune_realtime_logs(interval, interval, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.prune_realtime_logs(interval, interval, integer, integer) TO dashboard_admin;
