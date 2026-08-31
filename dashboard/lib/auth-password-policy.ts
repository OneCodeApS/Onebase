import crypto from "node:crypto";
import type { EmailProviderConfig, PasswordRequirements } from "./auth-settings";

// The email provider's password rules, in one place. Sign-up and password
// update both go through checkPasswordPolicy() so the two can never drift —
// before this module they would have, because the rules lived inline in
// signup/route.ts and a second endpoint had to copy them.

export function meetsRequirements(
  password: string,
  req: PasswordRequirements,
): boolean {
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  switch (req) {
    case "none":
      return true;
    case "lowercase_uppercase":
      return hasLower && hasUpper;
    case "lowercase_uppercase_digits":
      return hasLower && hasUpper && hasDigit;
    case "lowercase_uppercase_digits_symbols":
      return hasLower && hasUpper && hasDigit && hasSymbol;
  }
}

// HaveIBeenPwned k-anonymity: hash with SHA-1, send the first 5 chars to the
// public API, receive ~500 suffixes; check ours against the list. The full
// password never leaves this server.
export async function isPwned(password: string): Promise<boolean> {
  try {
    const hash = crypto
      .createHash("sha1")
      .update(password)
      .digest("hex")
      .toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "User-Agent": "onecodebase-auth" },
    });
    if (!res.ok) return false; // fail open on API issues
    const text = await res.text();
    for (const line of text.split("\n")) {
      const [s] = line.split(":");
      if (s.trim().toUpperCase() === suffix) return true;
    }
    return false;
  } catch {
    return false; // fail open on network issues
  }
}

/** The 400 body to return when a password is rejected. */
export type PasswordRejection = {
  error: string;
  detail: string;
  required?: PasswordRequirements;
};

/**
 * Apply the configured policy to a candidate password. Resolves to `null` when
 * it is acceptable, otherwise to the body the caller should return with a 400.
 */
export async function checkPasswordPolicy(
  password: string,
  cfg: EmailProviderConfig,
): Promise<PasswordRejection | null> {
  if (password.length < cfg.min_password_length) {
    return {
      error: "password_too_short",
      detail: `Password must be at least ${cfg.min_password_length} characters`,
    };
  }
  if (!meetsRequirements(password, cfg.password_requirements)) {
    return {
      error: "password_too_weak",
      detail: "Password does not meet the required mix of character classes",
      required: cfg.password_requirements,
    };
  }
  if (cfg.prevent_leaked_passwords && (await isPwned(password))) {
    return {
      error: "password_pwned",
      detail:
        "This password has appeared in a known data breach. Pick a different one.",
    };
  }
  return null;
}
