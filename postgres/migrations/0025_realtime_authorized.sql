-- 0025_realtime_authorized.sql
-- Per-subscriber RLS filtering for realtime ("authorized" mode).
--
-- Until now the realtime change stream was table-level: the trigger pg_notify'd
-- the full row to a channel and the fan-out hub delivered it to EVERY subscriber
-- of that table, ignoring Row-Level Security. Any authenticated user who could
-- subscribe saw every row's payload — even rows their RLS SELECT policy forbids.
--
-- This migration adds an "authorized" mode that re-evaluates the table's RLS
-- SELECT policy for each changed row in each subscriber's auth context before
-- the event is forwarded. The decision is made by _dashboard.realtime_can_select,
-- which the dashboard's fan-out hub calls over a NON-bypassrls `authenticator`
-- connection (never dashboard_admin / service_role).
--
-- Existing enabled tables are migrated as 'basic' so their semantics do NOT
-- change silently; an admin opts a table into 'authorized' from the dashboard.
--
-- Idempotent. Mirrored into postgres/init/09_realtime.sql for fresh installs.

-- ── 1. Per-table mode flag ──────────────────────────────────────────────────
ALTER TABLE _dashboard.realtime_tables
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'basic'
    CHECK (mode IN ('basic', 'authorized'));

-- ── 2. Policy applicability helper ──────────────────────────────────────────
-- Does an RLS policy (its polroles oid[]) apply to `p_role`? Mirrors Postgres's
-- own rule: the role list contains PUBLIC (oid 0) or any role the target role is
-- a member of. Called only from within _dashboard.realtime_can_select's
-- definer phase, so it needs no broad grants.
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

-- ── 3. The authorization primitive ──────────────────────────────────────────
-- Returns true iff a subscriber whose JWT claims are `p_claims` is allowed to
-- SELECT the changed row, per the table's RLS SELECT policies — the SAME
-- predicate PostgREST applies, so a row a user can't read via REST can never
-- reach them via realtime.
--
-- SECURITY DEFINER in TWO phases:
--   Phase 1 (as the owner): read the catalog and assemble the combined policy
--     expression. No application data is touched here.
--   Phase 2: SET LOCAL ROLE authenticated + request.jwt.claims, then evaluate
--     that expression / re-query the row. current_user is now `authenticated`
--     (no BYPASSRLS), so RLS — and any functions the policy calls — run exactly
--     as a REST request would.
-- This split lets the function read _dashboard/catalog internals without granting
-- end-user roles any access to them, while the actual visibility decision still
-- runs under the unprivileged `authenticated` role.
--
-- Inputs (the hub passes whichever it has):
--   p_row  — full row image (to_jsonb(NEW) for INSERT/UPDATE, to_jsonb(OLD) for
--            DELETE); evaluated against the policy directly.
--   p_keys — primary-key-only image, used only for oversized (truncated) INSERT/
--            UPDATE events; we re-query the live row under RLS. Truncated DELETE
--            has neither → fail closed.
--
-- Fails CLOSED (false) on any error, missing RLS, default-deny, invalid claims,
-- or a truncated DELETE.
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
SECURITY DEFINER
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
  -- Phase 1 (owner): resolve the relation; fail closed if it's gone, not an
  -- ordinary table, or has RLS disabled (authorized mode has nothing to honor).
  SELECT c.oid, c.relrowsecurity
    INTO v_relid, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = p_schema AND c.relname = p_table AND c.relkind = 'r';
  IF NOT FOUND OR NOT v_rls_enabled THEN
    RETURN false;
  END IF;

  -- Truncated INSERT/UPDATE: only the PK was broadcast; the row still exists, so
  -- re-query it under RLS (phase 2). Truncated DELETE has no image → fail closed.
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

  -- Normal path. Combine SELECT policies as Postgres does: permissive OR'd,
  -- restrictive AND'd on top. pg_get_expr runs here (search_path = pg_catalog),
  -- so it schema-qualifies every external reference — the expression is then
  -- safe to evaluate without depending on search_path in phase 2.
  SELECT string_agg('(' || pg_get_expr(pol.polqual, pol.polrelid) || ')', ' OR ')
    INTO v_permissive
    FROM pg_policy pol
   WHERE pol.polrelid = v_relid
     AND pol.polcmd IN ('r', '*')
     AND pol.polpermissive
     AND pol.polqual IS NOT NULL
     AND _dashboard._policy_applies(pol.polroles, 'authenticated');

  IF v_permissive IS NULL THEN
    RETURN false;  -- RLS on, no applicable permissive SELECT policy → default deny
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

  -- Phase 2: adopt the subscriber's identity and evaluate the predicate against
  -- the row image, materialised as a one-row relation aliased to the table name
  -- so the policy's bare column references resolve.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', p_claims::text, true);
  EXECUTE format(
    'SELECT coalesce((%s), false) '
    'FROM (SELECT (jsonb_populate_record(NULL::%I.%I, $1)).*) AS %I',
    v_expr, p_schema, p_table, p_table
  ) INTO v_result USING p_row;

  RETURN coalesce(v_result, false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;  -- fail closed on any error
END;
$$;

-- Only the hub's RLS-check connection (authenticator) may call it. NOT public,
-- NOT authenticated/anon. authenticator needs schema USAGE to reference it.
REVOKE ALL ON FUNCTION
  _dashboard.realtime_can_select(text, text, jsonb, jsonb, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  _dashboard.realtime_can_select(text, text, jsonb, jsonb, text, jsonb)
  TO authenticator;
GRANT USAGE ON SCHEMA _dashboard TO authenticator;

-- Defense in depth: now that authenticator can see the _dashboard schema, make
-- sure the SECURITY DEFINER disable helper is NOT callable by it or PUBLIC (only
-- the dashboard's own connection should manage triggers). The enable helper is
-- handled below once its new 3-arg form exists.
REVOKE ALL ON FUNCTION _dashboard.disable_realtime(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.disable_realtime(text, text) TO dashboard_admin;

-- ── 4. Trigger: attach an RLS key to oversized events ───────────────────────
-- The PK lookup is INLINED (not a nested _dashboard.* call) so the trigger keeps
-- working for unprivileged writers (e.g. an authenticated PostgREST INSERT),
-- which have no _dashboard schema access.
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
    -- Oversized: strip row data but keep the primary key so authorized
    -- subscribers can still be filtered (re-query under RLS).
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

-- ── 5. enable_realtime gains a mode argument ────────────────────────────────
-- Drop the old 2-arg overload so enable_realtime('s','t') resolves to the new
-- 3-arg form (defaulting to 'basic') instead of two ambiguous signatures.
DROP FUNCTION IF EXISTS _dashboard.enable_realtime(text, text);

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

-- The 3-arg form replaces the 2-arg one as the dashboard's entry point; lock it
-- down to the dashboard connection too.
REVOKE ALL ON FUNCTION _dashboard.enable_realtime(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _dashboard.enable_realtime(text, text, text) TO dashboard_admin;
