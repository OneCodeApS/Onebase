import { pool } from "./db";

export type AuthSettings = {
  allow_signups: boolean;
  confirm_email: boolean;
};

export type AuthProvider = {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

const DEFAULTS: AuthSettings = {
  allow_signups: true,
  confirm_email: false,
};

export async function getAuthSettings(): Promise<AuthSettings> {
  const { rows } = await pool().query<AuthSettings>(
    "SELECT allow_signups, confirm_email FROM auth.settings WHERE id = 1",
  );
  return rows[0] ?? DEFAULTS;
}

export async function setAuthSettings(
  next: AuthSettings,
  updatedBy: string | null,
): Promise<void> {
  await pool().query(
    `INSERT INTO auth.settings (id, allow_signups, confirm_email, updated_by, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET allow_signups = EXCLUDED.allow_signups,
           confirm_email = EXCLUDED.confirm_email,
           updated_by    = EXCLUDED.updated_by,
           updated_at    = now()`,
    [next.allow_signups, next.confirm_email, updatedBy],
  );
}

export async function listProviders(): Promise<AuthProvider[]> {
  const { rows } = await pool().query<AuthProvider>(
    "SELECT name, enabled, config FROM auth.providers ORDER BY name",
  );
  return rows;
}

export async function getProvider(name: string): Promise<AuthProvider | null> {
  const { rows } = await pool().query<AuthProvider>(
    "SELECT name, enabled, config FROM auth.providers WHERE name = $1",
    [name],
  );
  return rows[0] ?? null;
}

export async function setProvider(
  name: string,
  next: { enabled: boolean; config?: Record<string, unknown> },
  updatedBy: string | null,
): Promise<void> {
  await pool().query(
    `INSERT INTO auth.providers (name, enabled, config, updated_by, updated_at)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, now())
     ON CONFLICT (name) DO UPDATE
       SET enabled    = EXCLUDED.enabled,
           config     = COALESCE($3::jsonb, auth.providers.config),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [name, next.enabled, next.config ? JSON.stringify(next.config) : null, updatedBy],
  );
}

export async function isProviderEnabled(name: string): Promise<boolean> {
  const p = await getProvider(name);
  return !!p?.enabled;
}

// Email-provider-specific config with sane defaults filled in for fields the
// admin hasn't customised. Some of these are enforced today; others are
// persisted but await follow-up features (email change, OTP, etc.) — the UI
// labels which is which.
export type PasswordRequirements =
  | "none"
  | "lowercase_uppercase"
  | "lowercase_uppercase_digits"
  | "lowercase_uppercase_digits_symbols";

export type EmailProviderConfig = {
  secure_email_change: boolean;
  secure_password_change: boolean;
  require_current_password_on_update: boolean;
  prevent_leaked_passwords: boolean;
  min_password_length: number;
  password_requirements: PasswordRequirements;
  email_otp_expiration_seconds: number;
  email_otp_length: number;
};

export const EMAIL_PROVIDER_DEFAULTS: EmailProviderConfig = {
  secure_email_change: true,
  secure_password_change: true,
  require_current_password_on_update: true,
  prevent_leaked_passwords: false,
  min_password_length: 12,
  password_requirements: "none",
  email_otp_expiration_seconds: 86400,
  email_otp_length: 6,
};

export async function getEmailProviderConfig(): Promise<EmailProviderConfig> {
  const p = await getProvider("email");
  const raw = (p?.config ?? {}) as Partial<EmailProviderConfig>;
  return {
    ...EMAIL_PROVIDER_DEFAULTS,
    ...raw,
  };
}

// Magic-link provider config. smtp_password is stored encrypted
// (lib/encryption.ts) by the admin action and decrypted at send time in
// lib/email.ts — never returned to the browser.
export type MagicLinkProviderConfig = {
  smtp_host: string;
  smtp_port: number;
  // false → STARTTLS upgrade on a plaintext connection (port 587);
  // true → implicit TLS (port 465).
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password: string;
  from_email: string;
  from_name: string;
  // Shown in the email subject/body so users recognise the requesting app.
  app_name: string;
  // Deliberately separate from email_otp_expiration_seconds (24h default) —
  // a sign-in link should live minutes, not a day.
  link_expiration_seconds: number;
  // Refresh-session lifetime for sessions created via magic link. Apps with
  // external users (e.g. subcontractor portals) typically want this shorter
  // than the platform's 30-day default.
  session_ttl_days: number;
  // Per-user request cap (rolling hour). Exceeding it is silently ignored so
  // the response never reveals whether an account exists.
  max_per_hour: number;
};

export const MAGICLINK_DEFAULTS: MagicLinkProviderConfig = {
  smtp_host: "",
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: "",
  smtp_password: "",
  from_email: "",
  from_name: "",
  app_name: "",
  link_expiration_seconds: 900,
  session_ttl_days: 30,
  max_per_hour: 3,
};

export async function getMagicLinkProviderConfig(): Promise<MagicLinkProviderConfig> {
  const p = await getProvider("magiclink");
  const raw = (p?.config ?? {}) as Partial<MagicLinkProviderConfig>;
  return {
    ...MAGICLINK_DEFAULTS,
    ...raw,
  };
}
