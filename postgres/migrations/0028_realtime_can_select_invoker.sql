-- 0028_realtime_can_select_invoker.sql
-- FIX: authorized-mode realtime never delivered any event (since 2.4.0).
--
-- _dashboard.realtime_can_select evaluates a table's RLS SELECT policy in the
-- subscriber's context by doing `SET LOCAL ROLE authenticated` + setting
-- request.jwt.claims, then evaluating the policy — the same thing PostgREST
-- does. The dashboard's RLS-check pool calls it over a non-BYPASSRLS
-- `authenticator` connection precisely so that role switch is legitimate.
--
-- But the function shipped as SECURITY DEFINER. Postgres FORBIDS changing the
-- `role` GUC inside a security-definer function:
--     ERROR 42501: cannot set parameter "role" within security-definer function
-- So phase 2 threw on every call, the function's own `EXCEPTION WHEN OTHERS`
-- swallowed it and returned false, and EVERY authorized-mode event — on every
-- table, for every subscriber — was dropped. Basic mode (no RLS check) was
-- unaffected, which is why "basic works, authorized = silence."
--
-- The fix is to run it as the *caller* (the `authenticator` role, which IS
-- allowed to SET ROLE authenticated and is what the design always intended):
-- switch it to SECURITY INVOKER. As INVOKER the function also evaluates
-- _dashboard._policy_applies as the caller, so authenticator needs EXECUTE on
-- it (previously unnecessary under the definer phase).
--
-- Idempotent. Mirrored into postgres/init/09_realtime.sql for fresh installs.

ALTER FUNCTION _dashboard.realtime_can_select(text, text, jsonb, jsonb, text, jsonb)
  SECURITY INVOKER;

GRANT EXECUTE ON FUNCTION _dashboard._policy_applies(oid[], text) TO authenticator;
