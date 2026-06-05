"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  getProvider,
  setAuthSettings,
  setProvider,
  type AuthSettings,
} from "@/lib/auth-settings";
import { encrypt, isEncryptionConfigured } from "@/lib/encryption";

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

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export async function updateAuthSettings(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const next: AuthSettings = {
    allow_signups: formData.get("allow_signups") === "on",
    confirm_email: formData.get("confirm_email") === "on",
  };

  await setAuthSettings(next, session.userId ?? null);
  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "auth.settings.update",
    target: "auth.settings",
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: next as unknown as Record<string, unknown>,
  });

  revalidatePath("/admin/auth-providers");
  redirect("/admin/auth-providers?ok=" + encodeURIComponent("Settings saved"));
}

export async function updateProvider(formData: FormData) {
  const session = await requireAdmin();
  const ip = await clientIp();

  const name = String(formData.get("name") ?? "");
  const enabled = formData.get("enabled") === "on";

  // Load existing config so empty fields don't wipe secrets that are already
  // set. For the client secret in particular, we only overwrite if the admin
  // typed a non-empty value.
  const existing = await getProvider(name);
  const existingCfg = (existing?.config ?? {}) as Record<string, unknown>;
  let nextConfig: Record<string, unknown> | undefined;
  let smtpPasswordChanged = false;

  if (name === "microsoft") {
    const clientId = String(formData.get("client_id") ?? "").trim();
    const clientSecretRaw = String(formData.get("client_secret") ?? "");
    const tenant = String(formData.get("tenant") ?? "").trim();
    nextConfig = {
      ...existingCfg,
      client_id: clientId || existingCfg.client_id || "",
      tenant: tenant || existingCfg.tenant || "common",
    };
    if (clientSecretRaw.length > 0) {
      nextConfig.client_secret = clientSecretRaw;
    }
  } else if (name === "email") {
    const minLen = clamp(
      Number(formData.get("min_password_length") ?? 12),
      6,
      256,
    );
    const otpExp = clamp(
      Number(formData.get("email_otp_expiration_seconds") ?? 86400),
      60,
      30 * 24 * 3600,
    );
    const otpLen = clamp(Number(formData.get("email_otp_length") ?? 6), 4, 12);
    const requirements = String(formData.get("password_requirements") ?? "none");
    const validRequirements = [
      "none",
      "lowercase_uppercase",
      "lowercase_uppercase_digits",
      "lowercase_uppercase_digits_symbols",
    ];
    nextConfig = {
      ...existingCfg,
      secure_email_change: formData.get("secure_email_change") === "on",
      secure_password_change: formData.get("secure_password_change") === "on",
      require_current_password_on_update:
        formData.get("require_current_password_on_update") === "on",
      prevent_leaked_passwords: formData.get("prevent_leaked_passwords") === "on",
      min_password_length: minLen,
      password_requirements: validRequirements.includes(requirements)
        ? requirements
        : "none",
      email_otp_expiration_seconds: otpExp,
      email_otp_length: otpLen,
    };
  } else if (name === "magiclink") {
    const num = (key: string, def: number, min: number, max: number) =>
      clamp(Number(formData.get(key) ?? def), min, max);
    nextConfig = {
      ...existingCfg,
      smtp_host: String(formData.get("smtp_host") ?? "").trim(),
      smtp_port: num("smtp_port", 587, 1, 65535),
      smtp_secure: formData.get("smtp_secure") === "on",
      smtp_user: String(formData.get("smtp_user") ?? "").trim(),
      from_email: String(formData.get("from_email") ?? "").trim(),
      from_name: String(formData.get("from_name") ?? "").trim(),
      app_name: String(formData.get("app_name") ?? "").trim(),
      link_expiration_seconds: num("link_expiration_seconds", 900, 60, 3600),
      session_ttl_days: num("session_ttl_days", 30, 1, 30),
      max_per_hour: num("max_per_hour", 3, 1, 20),
    };
    // Only overwrite the password when the admin typed one — and only store
    // it encrypted. Refusing to save plaintext is deliberate: a DB dump must
    // never contain a usable SMTP credential.
    const pwRaw = String(formData.get("smtp_password") ?? "");
    if (pwRaw.length > 0) {
      if (!isEncryptionConfigured()) {
        redirect(
          "/admin/auth-providers?error=" +
            encodeURIComponent(
              "FUNCTION_ENV_KEY is not set — the SMTP password is stored encrypted and can't be saved without it.",
            ),
        );
      }
      nextConfig.smtp_password = encrypt(pwRaw);
      smtpPasswordChanged = true;
    }
  }

  await setProvider(name, { enabled, config: nextConfig }, session.userId ?? null);

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: session.role!,
    action: "auth.provider.update",
    target: name,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: {
      provider: name,
      enabled,
      // Don't log secret contents — flag whether one was supplied this round.
      client_secret_changed:
        nextConfig && "client_secret" in nextConfig
          ? !!(nextConfig.client_secret as string)?.length &&
            nextConfig.client_secret !== existingCfg.client_secret
          : false,
      smtp_password_changed: smtpPasswordChanged,
    },
  });

  revalidatePath("/admin/auth-providers");
  redirect(
    "/admin/auth-providers?ok=" +
      encodeURIComponent(`${name} provider saved`),
  );
}
