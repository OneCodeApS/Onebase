"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  createUser,
  findUserByEmail,
  hashPassword,
  upsertIdentity,
} from "@/lib/auth-users";

async function requireAdmin() {
  const s = await getSession();
  if (s.role !== "admin") {
    throw new Error("Admin only");
  }
  return s;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function setDisabled(id: string, disabled: boolean) {
  const session = await requireAdmin();
  const ip = await clientIp();
  if (!UUID.test(id)) {
    redirect("/admin/end-users?error=" + encodeURIComponent("Invalid id"));
  }

  const { rows } = await pool().query<{ email: string }>(
    `UPDATE auth.users
        SET disabled_at = ${disabled ? "now()" : "NULL"},
            updated_at  = now()
      WHERE id = $1
      RETURNING email`,
    [id],
  );
  const email = rows[0]?.email ?? id;

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: disabled ? "end_user.disable" : "end_user.enable",
    target: email,
    success: rows.length > 0,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { user_id: id },
  });

  // Revoking all active sessions when disabling stops them mid-session.
  if (disabled && rows.length > 0) {
    await pool().query(
      `UPDATE auth.sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  revalidatePath("/admin/end-users");
  redirect("/admin/end-users");
}

// Admin-created end user with email/password — the operator path for
// provisioning accounts without opening public signups. Mirrors the signup
// route's createUser + upsertIdentity('email') so the providers column and
// any provider-based logic see the account identically.
export async function createEndUser(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email.includes("@")) {
    redirect("/admin/end-users?error=" + encodeURIComponent("Invalid email"));
  }
  if (password.length < 12) {
    redirect(
      "/admin/end-users?error=" +
        encodeURIComponent("Password must be at least 12 characters"),
    );
  }
  if (await findUserByEmail(email)) {
    redirect(
      "/admin/end-users?error=" +
        encodeURIComponent(`${email} already exists`),
    );
  }

  const encrypted = await hashPassword(password);
  const user = await createUser({ email, encrypted_password: encrypted });
  await upsertIdentity({
    user_id: user.id,
    provider: "email",
    provider_user_id: user.email,
    identity_data: { email: user.email },
  });

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "end_user.create",
    target: email,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { user_id: user.id },
  });

  revalidatePath("/admin/end-users");
  redirect("/admin/end-users?ok=" + encodeURIComponent(`Created ${email}`));
}

export async function disableEndUser(formData: FormData) {
  await setDisabled(String(formData.get("id") ?? ""), true);
}

export async function enableEndUser(formData: FormData) {
  await setDisabled(String(formData.get("id") ?? ""), false);
}

export async function deleteEndUser(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const id = String(formData.get("id") ?? "");
  if (!UUID.test(id)) {
    redirect("/admin/end-users?error=" + encodeURIComponent("Invalid id"));
  }

  const { rows } = await pool().query<{ email: string }>(
    `DELETE FROM auth.users WHERE id = $1 RETURNING email`,
    [id],
  );
  const email = rows[0]?.email ?? id;

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "end_user.delete",
    target: email,
    success: rows.length > 0,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { user_id: id },
  });

  revalidatePath("/admin/end-users");
  redirect("/admin/end-users?ok=" + encodeURIComponent(`Deleted ${email}`));
}

export async function resetEndUserPassword(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!UUID.test(id)) {
    redirect("/admin/end-users?error=" + encodeURIComponent("Invalid id"));
  }
  if (password.length < 12) {
    redirect(
      "/admin/end-users?error=" +
        encodeURIComponent("Password must be at least 12 characters"),
    );
  }

  const encrypted = await hashPassword(password);
  const { rows } = await pool().query<{ email: string }>(
    `UPDATE auth.users
        SET encrypted_password = $2,
            updated_at         = now()
      WHERE id = $1
      RETURNING email`,
    [id, encrypted],
  );

  // Revoke active sessions so the user is forced to sign back in with the
  // new password.
  await pool().query(
    `UPDATE auth.sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [id],
  );

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "end_user.password_reset",
    target: rows[0]?.email ?? id,
    success: rows.length > 0,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { user_id: id },
  });

  revalidatePath("/admin/end-users");
  redirect("/admin/end-users?ok=" + encodeURIComponent("Password reset"));
}
