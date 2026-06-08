"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { updateRateLimit } from "@/lib/rate-limit";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

const AREA = /^[a-z][a-z0-9_]{0,62}$/;

export async function saveRateLimit(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") redirect("/");

  const area = String(formData.get("area") ?? "").trim();
  const maxAttempts = Number(formData.get("max_attempts"));
  const windowSeconds = Number(formData.get("window_seconds"));
  const enabled = formData.get("enabled") === "on";

  if (!AREA.test(area)) {
    redirect("/admin/rate-limits?error=" + encodeURIComponent("Invalid area"));
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100000) {
    redirect(
      "/admin/rate-limits?error=" +
        encodeURIComponent("Max attempts must be an integer between 1 and 100000"),
    );
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) {
    redirect(
      "/admin/rate-limits?error=" +
        encodeURIComponent("Window must be an integer between 1 and 86400 seconds"),
    );
  }

  // UPDATE-only (areas are defined in code where checkRateLimit is called); a
  // tampered area simply matches no row and is a no-op.
  await updateRateLimit(
    area,
    { max_attempts: maxAttempts, window_seconds: windowSeconds, enabled },
    session.userId ?? null,
  );

  await audit({
    actor: session.email!,
    actorId: session.userId!,
    role: "admin",
    action: "settings.rate_limit.update",
    target: area,
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: { area, max_attempts: maxAttempts, window_seconds: windowSeconds, enabled },
  });

  redirect("/admin/rate-limits?ok=" + encodeURIComponent(`Saved ${area}`));
}
