"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  CRON_JOB_NAME,
  deleteCronJob,
  notifyCronReload,
  upsertCronJob,
  validateCronExpression,
} from "@/lib/cron";

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

export async function saveCronJob(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const schedule = String(formData.get("schedule") ?? "").trim();
  const functionName = String(formData.get("function_name") ?? "").trim();
  const enabled = formData.get("enabled") === "on";

  if (!CRON_JOB_NAME.test(name)) {
    redirect(
      "/admin/cron?error=" +
        encodeURIComponent("Invalid name (lowercase letters/digits/-/_, max 63)"),
    );
  }
  if (!validateCronExpression(schedule)) {
    redirect(
      "/admin/cron?error=" +
        encodeURIComponent(`Invalid cron expression: "${schedule}"`),
    );
  }
  if (!functionName) {
    redirect("/admin/cron?error=" + encodeURIComponent("Pick a function"));
  }

  try {
    await upsertCronJob(
      { name, schedule, function_name: functionName, enabled },
      session.userId ?? null,
    );
    // Signal the scheduler leader (possibly a different replica) to rebuild its
    // in-memory schedule, so the change takes effect immediately.
    await notifyCronReload();
  } catch (e) {
    redirect("/admin/cron?error=" + encodeURIComponent((e as Error).message));
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "cron.save",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { name, schedule, function_name: functionName, enabled },
  });

  revalidatePath("/admin/cron");
  redirect("/admin/cron?ok=" + encodeURIComponent(`Saved ${name}`));
}

export async function removeCronJob(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const name = String(formData.get("name") ?? "");

  await deleteCronJob(name);
  await notifyCronReload();

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "cron.delete",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
  });

  revalidatePath("/admin/cron");
  redirect("/admin/cron?ok=" + encodeURIComponent(`Deleted ${name}`));
}
