import nodemailer from "nodemailer";
import {
  getMagicLinkProviderConfig,
  type MagicLinkProviderConfig,
} from "./auth-settings";
import { decrypt } from "./encryption";

// SMTP email sending for the magic-link auth provider. There is no global
// platform mailer — config lives in auth.providers.magiclink (set via the
// Auth Providers admin page) and the transport is built per send so admin
// changes take effect on the next request, mirroring how the Microsoft
// provider reads its config per call (lib/auth-oauth-microsoft.ts).

export class EmailNotConfiguredError extends Error {}

// The admin action stores smtp_password encrypted (v1:… AES-256-GCM blob).
// Tolerate a plaintext value too — e.g. a config row written by hand on an
// install without FUNCTION_ENV_KEY — rather than failing every send.
function smtpPassword(cfg: MagicLinkProviderConfig): string {
  if (!cfg.smtp_password) return "";
  try {
    return decrypt(cfg.smtp_password);
  } catch {
    return cfg.smtp_password;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendMagicLinkEmail(input: {
  to: string;
  link: string;
  expiresMinutes: number;
}): Promise<void> {
  const cfg = await getMagicLinkProviderConfig();
  if (!cfg.smtp_host || !cfg.from_email) {
    throw new EmailNotConfiguredError(
      "Magic link provider not configured (smtp_host and from_email required)",
    );
  }

  // Per-send transport, no pool: route handlers are short-lived and volume is
  // low; a pool would hold idle sockets with no close hook. Tight timeouts so
  // a dead SMTP host fails the send fast instead of hanging the request.
  const transport = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: cfg.smtp_secure,
    auth: cfg.smtp_user
      ? { user: cfg.smtp_user, pass: smtpPassword(cfg) }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  const appName = cfg.app_name || "your application";
  const subject = `Sign in to ${appName}`;
  const expiry = `This link expires in ${input.expiresMinutes} minutes and can be used once.`;
  const ignore = "If you didn't request this, you can safely ignore this email.";

  // Plain content, both parts, no images / remote assets / tracking.
  const text = [
    `Sign in to ${appName} by opening this link:`,
    "",
    input.link,
    "",
    expiry,
    ignore,
  ].join("\n");

  const html = [
    `<p>Sign in to <strong>${escapeHtml(appName)}</strong> by clicking the link below:</p>`,
    `<p><a href="${escapeHtml(input.link)}">Sign in to ${escapeHtml(appName)}</a></p>`,
    `<p>${escapeHtml(expiry)}<br>${escapeHtml(ignore)}</p>`,
  ].join("\n");

  await transport.sendMail({
    from: cfg.from_name
      ? { name: cfg.from_name, address: cfg.from_email }
      : cfg.from_email,
    to: input.to,
    subject,
    text,
    html,
  });
}
