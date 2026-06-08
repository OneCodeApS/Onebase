"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  createFunction,
  deleteFunction,
  FUNCTION_NAME,
  updateFunction,
  validateFunctionCode,
} from "@/lib/functions";

async function requireAdmin() {
  const s = await getSession();
  if (s.role !== "admin") throw new Error("Admin only");
  return s;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export async function createNewFunction(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const description = String(formData.get("description") ?? "").trim() || null;

  if (!FUNCTION_NAME.test(name)) {
    redirect(
      "/admin/functions?error=" +
        encodeURIComponent("Invalid name (lowercase letters/digits/-/_, max 63)"),
    );
  }

  try {
    await createFunction({
      name,
      description,
      updatedBy: session.userId ?? null,
    });
  } catch (e) {
    redirect("/admin/functions?error=" + encodeURIComponent((e as Error).message));
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "function.create",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { name, description },
  });

  revalidatePath("/admin/functions");
  redirect(`/admin/functions/${encodeURIComponent(name)}/overview`);
}

// Overview tab — enabled/description/timeout. Doesn't touch code or env.
export async function saveOverview(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const name = String(formData.get("name") ?? "");
  const description = String(formData.get("description") ?? "").trim() || null;
  const enabled = formData.get("enabled") === "on";
  const verifyJwt = formData.get("verify_jwt") === "on";
  const timeoutMs = clamp(Number(formData.get("timeout_ms") ?? 5000), 100, 60000);
  const minRoleRaw = String(formData.get("min_role") ?? "authenticated");
  const minRole = (["anon", "authenticated", "service_role"] as const).find(
    (r) => r === minRoleRaw,
  ) ?? "authenticated";

  await updateFunction(
    name,
    { description, enabled, timeout_ms: timeoutMs, verify_jwt: verifyJwt, min_role: minRole },
    session.userId ?? null,
  );

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "function.update",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      name,
      enabled,
      timeout_ms: timeoutMs,
      verify_jwt: verifyJwt,
      min_role: minRole,
      tab: "overview",
    },
  });

  revalidatePath(`/admin/functions/${encodeURIComponent(name)}`);
  redirect(
    `/admin/functions/${encodeURIComponent(name)}/overview?ok=${encodeURIComponent("Saved")}`,
  );
}

// Code tab — code only.
export async function saveCode(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const name = String(formData.get("name") ?? "");
  const code = String(formData.get("code") ?? "");

  const syntaxError = validateFunctionCode(code);
  if (syntaxError) {
    redirect(
      `/admin/functions/${encodeURIComponent(name)}/code?error=` +
        encodeURIComponent(`Syntax error: ${syntaxError}`),
    );
  }

  await updateFunction(name, { code }, session.userId ?? null);

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "function.update",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { name, tab: "code", bytes: code.length },
  });

  revalidatePath(`/admin/functions/${encodeURIComponent(name)}`);
  redirect(
    `/admin/functions/${encodeURIComponent(name)}/code?ok=${encodeURIComponent("Saved")}`,
  );
}

export async function removeFunction(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const name = String(formData.get("name") ?? "");

  await deleteFunction(name);

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "function.delete",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
  });

  revalidatePath("/admin/functions");
  redirect(`/admin/functions?ok=${encodeURIComponent(`Deleted ${name}`)}`);
}
