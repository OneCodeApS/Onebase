"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { pruneOldAuditRows } from "@/lib/audit-retention";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

export async function updateAuditSubdir(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") redirect("/");

  const raw = String(formData.get("subdir") ?? "").trim();
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";

  const previous = (await getSetting<string>("audit_subdir")) ?? "default";
  await setSetting("audit_subdir", sanitized, session.userId ?? null);

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.audit_subdir.update",
    target: "audit_subdir",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: { from: previous, to: sanitized, raw_input: raw },
  });

  const msg = sanitized === raw ? `Saved: ${sanitized}` : `Saved (sanitized): ${sanitized}`;
  redirect("/admin/settings/logs?ok=" + encodeURIComponent(msg));
}

export async function updateAuditRetention(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") redirect("/");

  const raw = String(formData.get("days") ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    redirect(
      "/admin/settings/logs?error=" +
        encodeURIComponent("Retention must be a non-negative integer (0 = keep forever)."),
    );
  }

  const previous = (await getSetting<number>("audit_retention_days")) ?? 30;
  await setSetting("audit_retention_days", n, session.userId ?? null);

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.audit_retention.update",
    target: "audit_retention_days",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: { from: previous, to: n },
  });

  const msg = n === 0 ? "Retention disabled (keep forever)" : `Retention: ${n} day(s)`;
  redirect("/admin/settings/logs?ok=" + encodeURIComponent(msg));
}

export async function updateApiMaxRows(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") redirect("/");

  const raw = String(formData.get("max_rows") ?? "").trim();

  // Empty = clear the override and fall back to the PGRST_DB_MAX_ROWS default.
  let n: number | null;
  if (raw === "") {
    n = null;
  } else {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      redirect(
        "/admin/settings/api?error=" +
          encodeURIComponent(
            "Max rows must be a positive integer, or empty to use the default.",
          ),
      );
    }
    n = parsed;
  }

  const previous = await getSetting<number>("api_max_rows");

  // Write PostgREST's in-database config (a GUC on the authenticator role) via
  // the SECURITY DEFINER helper — dashboard_admin can't ALTER ROLE directly.
  // Persist the same value for display on the settings page.
  await pool().query("SELECT _dashboard.set_api_max_rows($1)", [n]);
  await setSetting("api_max_rows", n, session.userId ?? null);

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.api_max_rows.update",
    target: "api_max_rows",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: { from: previous, to: n },
  });

  const msg =
    n === null
      ? "API max rows reset to the default. Restart PostgREST to apply."
      : `API max rows set to ${n}. Restart PostgREST to apply.`;
  redirect("/admin/settings/api?ok=" + encodeURIComponent(msg));
}

// Rotate the read-only `bi_readonly` database login (Power BI / SQL clients).
// Unlike the other actions here this RETURNS a value rather than redirecting,
// because the freshly generated password must be shown to the admin exactly
// once — it is never persisted in cleartext anywhere we can read back, and is
// deliberately kept out of the URL, the audit log, and the query text.
export async function rotateBiReadonlyPassword(): Promise<
  { ok: true; password: string } | { ok: false; error: string }
> {
  const session = await getSession();
  if (session.role !== "admin") return { ok: false, error: "Forbidden." };

  // base64url → only A–Z a–z 0–9 - _, so it's safe to paste into a Postgres
  // connection string (no /, +, @, : to confuse URL parsing). 24 bytes ≈ 32
  // chars ≈ 192 bits of entropy.
  const password = randomBytes(24).toString("base64url");

  try {
    // SECURITY DEFINER helper — dashboard_admin can't ALTER ROLE directly. The
    // password is a bound parameter, so it never lands in the query text.
    await pool().query("SELECT _dashboard.rotate_bi_readonly_password($1)", [
      password,
    ]);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Surface the helper's friendly "apply migration 0030 first" hint as-is;
    // anything else is reported generically.
    const error = raw.includes("bi_readonly")
      ? raw
      : "Could not rotate the password. Is migration 0030/0031 applied?";
    return { ok: false, error };
  }

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.bi_readonly_password.rotate",
    target: "bi_readonly",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    // The password itself is never recorded.
    metadata: {},
  });

  return { ok: true, password };
}

// Rotate the read-only `bi_readonly` database login (Power BI / SQL clients).
// Unlike the other actions here this RETURNS a value rather than redirecting,
// because the freshly generated password must be shown to the admin exactly
// once — it is never persisted in cleartext anywhere we can read back, and is
// deliberately kept out of the URL, the audit log, and the query text.
export async function rotateBiReadonlyPassword(): Promise<
  { ok: true; password: string } | { ok: false; error: string }
> {
  const session = await getSession();
  if (session.role !== "admin") return { ok: false, error: "Forbidden." };

  // base64url → only A–Z a–z 0–9 - _, so it's safe to paste into a Postgres
  // connection string (no /, +, @, : to confuse URL parsing). 24 bytes ≈ 32
  // chars ≈ 192 bits of entropy.
  const password = randomBytes(24).toString("base64url");

  try {
    // SECURITY DEFINER helper — dashboard_admin can't ALTER ROLE directly. The
    // password is a bound parameter, so it never lands in the query text.
    await pool().query("SELECT _dashboard.rotate_bi_readonly_password($1)", [
      password,
    ]);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Surface the helper's friendly "apply migration 0030 first" hint as-is;
    // anything else is reported generically.
    const error = raw.includes("bi_readonly")
      ? raw
      : "Could not rotate the password. Is migration 0030/0031 applied?";
    return { ok: false, error };
  }

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.bi_readonly_password.rotate",
    target: "bi_readonly",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    // The password itself is never recorded.
    metadata: {},
  });

  return { ok: true, password };
}

export async function runAuditPruneNow() {
  const session = await getSession();
  if (session.role !== "admin") redirect("/");

  const result = await pruneOldAuditRows();

  // pruneOldAuditRows() writes its own audit.prune row, so no extra audit
  // call here. But we do want to capture that an admin triggered it.
  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "audit.prune.manual",
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: {
      retention_days: result.retentionDays,
      deleted: result.deleted,
      anchor_id: result.anchorId,
      cutoff: result.cutoff,
    },
  });

  const msg =
    result.retentionDays <= 0
      ? "Retention is disabled (0 days). No rows pruned."
      : result.deleted === 0
        ? `Nothing to prune (no rows older than ${result.retentionDays} day(s)).`
        : `Pruned ${result.deleted} row(s) older than ${result.retentionDays} day(s).`;
  redirect("/admin/settings/logs?ok=" + encodeURIComponent(msg));
}
