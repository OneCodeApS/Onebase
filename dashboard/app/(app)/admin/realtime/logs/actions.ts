"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { pool } from "@/lib/db";

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

// Clears the realtime diagnostics log. Audited like every other admin action.
export async function clearRealtimeLogs() {
  const session = await requireAdmin();
  const ip = await clientIp();

  let errMsg: string | null = null;
  try {
    await pool().query("DELETE FROM _dashboard.realtime_logs");
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "realtime.logs.clear",
    target: "_dashboard.realtime_logs",
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: errMsg ? { error: errMsg } : {},
  });

  if (errMsg) throw new Error(`realtime.logs.clear failed: ${errMsg}`);

  revalidatePath("/admin/realtime/logs");
  redirect("/admin/realtime/logs");
}
