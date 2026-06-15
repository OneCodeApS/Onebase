import { pool } from "../db";
import { listTablesRlsStatus, listTableGrants, listUserSchemas } from "../db-introspect";
import { listRateLimits } from "../rate-limit";
import { getBucketPolicy } from "../storage";
import { minio } from "../minio";

// "Onebase doctor" — security and configuration lints tailored to this
// stack. Each check is independent and failure-isolated: if one data source
// is down (e.g. MinIO), the rest of the report still renders, with an info
// entry noting the gap.

export type Advisory = {
  level: "warn" | "info";
  category: string;
  title: string;
  detail: string;
  remediation?: string;
};

const APP_SCHEMAS_EXCLUDED = new Set(["_dashboard", "auth"]);

export async function runAdvisors(): Promise<Advisory[]> {
  const out: Advisory[] = [];

  const push = (a: Advisory) => out.push(a);
  const guard = async (category: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      push({
        level: "info",
        category,
        title: `Check skipped: ${category}`,
        detail: `Could not run this check: ${(e as Error).message}`,
      });
    }
  };

  // RLS coverage on user-facing schemas (what PostgREST exposes).
  await guard("rls", async () => {
    const schemas = (await listUserSchemas()).filter((s) => !APP_SCHEMAS_EXCLUDED.has(s));
    for (const schema of schemas) {
      for (const t of await listTablesRlsStatus(schema)) {
        if (!t.rls_enabled) {
          push({
            level: "warn",
            category: "rls",
            title: `RLS disabled on ${t.schema}.${t.table}`,
            detail:
              "Row Level Security is off — every PostgREST request that can reach this table sees all rows.",
            remediation: `ALTER TABLE "${t.schema}"."${t.table}" ENABLE ROW LEVEL SECURITY; then add policies.`,
          });
        } else if (t.policy_count === 0) {
          push({
            level: "info",
            category: "rls",
            title: `RLS enabled but no policies on ${t.schema}.${t.table}`,
            detail:
              "With zero policies the table is inaccessible to anon/authenticated (deny-all). Fine if intentional; add policies if clients should read it.",
          });
        }
      }
    }
  });

  // Write grants reachable by unauthenticated PostgREST requests.
  await guard("grants", async () => {
    const WRITE = new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);
    for (const row of await listTableGrants("public")) {
      for (const g of row.grants) {
        if (g.grantee !== "anon" && g.grantee !== "PUBLIC") continue;
        const writes = g.privileges.filter((p) => WRITE.has(p));
        if (writes.length > 0) {
          push({
            level: "warn",
            category: "grants",
            title: `${g.grantee} can ${writes.join("/")} on public.${row.table}`,
            detail:
              "The anon role serves unauthenticated requests — write grants here mean anyone on the internet can modify this table (RLS permitting).",
            remediation: `REVOKE ${writes.join(", ")} ON public."${row.table}" FROM ${g.grantee === "PUBLIC" ? "PUBLIC" : "anon"};`,
          });
        }
      }
    }
  });

  // Edge functions with weak gates.
  await guard("functions", async () => {
    const { rows } = await pool().query<{
      name: string;
      enabled: boolean;
      verify_jwt: boolean;
      min_role: string;
    }>(
      `SELECT name, enabled, verify_jwt, min_role FROM _dashboard.functions`,
    );
    for (const f of rows) {
      if (!f.enabled) continue;
      if (!f.verify_jwt) {
        push({
          level: "warn",
          category: "functions",
          title: `Edge function "${f.name}" has verify_jwt off`,
          detail:
            "Anyone who can reach /functions/v1 can invoke it with no token at all. Its code runs with full database access (dashboard_admin).",
          remediation: "Enable Verify JWT unless the function is deliberately public.",
        });
      } else if (f.min_role === "anon") {
        push({
          level: "info",
          category: "functions",
          title: `Edge function "${f.name}" allows the anon key`,
          detail:
            "min_role=anon means the public anon key (embedded in client apps) is sufficient to invoke it.",
        });
      }
    }
  });

  // Public buckets.
  await guard("storage", async () => {
    const buckets = await minio.listBuckets();
    for (const b of buckets) {
      const policy = await getBucketPolicy(b.name);
      if (policy.visibility === "public") {
        push({
          level: "info",
          category: "storage",
          title: `Bucket "${b.name}" is public`,
          detail:
            "Anonymous reads are allowed on every object, and any authenticated end-user can sign upload URLs for it.",
        });
      }
    }
  });

  // Disabled rate limits.
  await guard("rate-limits", async () => {
    for (const rl of await listRateLimits()) {
      if (!rl.enabled) {
        push({
          level: "warn",
          category: "rate-limits",
          title: `Rate limit "${rl.area}" is disabled`,
          detail: "Brute-force protection for this area is off across all replicas.",
          remediation: "Re-enable it under Admin → Rate limits.",
        });
      }
    }
  });

  // CORS posture.
  await guard("cors", async () => {
    const origins = (process.env.AUTH_ALLOWED_ORIGINS ?? "").trim();
    if (origins === "*") {
      push({
        level: "warn",
        category: "cors",
        title: "AUTH_ALLOWED_ORIGINS is *",
        detail:
          "Every origin may call /auth/v1, /functions/v1 and /realtime from the browser. Safe only because auth uses bearer JWTs (no cookies) — still, an explicit allowlist is tighter.",
        remediation: "Set AUTH_ALLOWED_ORIGINS to the exact app origins.",
      });
    } else if (origins === "") {
      push({
        level: "info",
        category: "cors",
        title: "No browser origins allowlisted",
        detail:
          "AUTH_ALLOWED_ORIGINS is empty — browser apps on other origins cannot call the auth/functions/realtime APIs (non-browser clients are unaffected). Expected until a web app goes live.",
      });
    }
  });

  // Realtime streaming tables without RLS — the SSE stream sends full row
  // data to any holder of a valid access token.
  await guard("realtime", async () => {
    const { rows } = await pool().query<{ schema: string; table: string }>(
      `SELECT "schema", "table" FROM _dashboard.realtime_tables WHERE enabled`,
    );
    for (const rt of rows) {
      const status = await listTablesRlsStatus(rt.schema);
      const t = status.find((s) => s.table === rt.table);
      if (t && !t.rls_enabled) {
        push({
          level: "warn",
          category: "realtime",
          title: `Realtime is on for ${rt.schema}.${rt.table}, which has RLS disabled`,
          detail:
            "Every change (including full row data) is broadcast to any signed-in end user subscribed to the table.",
        });
      }
    }
  });

  // Long-lived write tokens.
  await guard("access-tokens", async () => {
    const { rows } = await pool().query<{ name: string; expires_at: Date }>(
      `SELECT name, expires_at
         FROM _dashboard.access_tokens
        WHERE revoked_at IS NULL
          AND expires_at > now()
          AND read_only = false`,
    );
    for (const t of rows) {
      push({
        level: "info",
        category: "access-tokens",
        title: `Write-capable MCP token "${t.name}" is active`,
        detail: `Expires ${t.expires_at.toISOString().slice(0, 10)}. Revoke it under Admin → Access tokens when it is no longer needed.`,
      });
    }
  });

  if (out.length === 0) {
    push({
      level: "info",
      category: "summary",
      title: "No findings",
      detail: "All advisor checks passed.",
    });
  }
  return out;
}
