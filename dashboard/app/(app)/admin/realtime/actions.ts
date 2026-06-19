"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  disableRealtime,
  enableRealtime,
  SAFE_IDENT,
  type RealtimeMode,
} from "@/lib/realtime";

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

// Sets a table's realtime state from the Admin UI. `state` is one of:
//   "off"        → disable realtime
//   "basic"      → enable, legacy table-level broadcast (no RLS filtering)
//   "authorized" → enable, per-subscriber RLS filtering
export async function setRealtime(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();
  const schema = String(formData.get("schema") ?? "");
  const table = String(formData.get("table") ?? "");
  const state = String(formData.get("state") ?? "");

  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(table)) {
    throw new Error("Invalid identifier");
  }
  if (!["off", "basic", "authorized"].includes(state)) {
    throw new Error("Invalid realtime state");
  }

  const enable = state !== "off";
  let errMsg: string | null = null;
  try {
    if (enable) {
      await enableRealtime(schema, table, state as RealtimeMode);
    } else {
      await disableRealtime(schema, table);
    }
  } catch (e) {
    errMsg = (e as Error).message;
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: enable ? "realtime.enable" : "realtime.disable",
    target: `${schema}.${table}`,
    success: !errMsg,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      schema,
      table,
      ...(enable ? { mode: state } : {}),
      ...(errMsg ? { error: errMsg } : {}),
    },
  });

  // Don't silently swallow failures — re-throw so the user sees the actual
  // problem instead of the page looking stuck. We still write the audit row
  // above so the failed attempt is recorded.
  if (errMsg) {
    throw new Error(`realtime.${enable ? "enable" : "disable"} failed: ${errMsg}`);
  }

  revalidatePath("/admin/realtime");
  // Explicit redirect forces a full re-render so the controls reflect the new
  // state immediately.
  redirect("/admin/realtime");
}
