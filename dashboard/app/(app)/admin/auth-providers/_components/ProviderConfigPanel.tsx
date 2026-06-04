"use client";

import { useEffect, useRef, useState } from "react";
import { updateProvider } from "../actions";

export type ProviderRow = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  // Derived on the server from AUTH_REDIRECT_BASE_URL — shown in the panel
  // so the admin can paste it into the Azure app registration's redirect URIs.
  redirectUri: string | null;
};

function ToggleField({
  name,
  defaultChecked,
  label,
  description,
  pending = false,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  description: string;
  pending?: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-1 h-4 w-4 accent-neutral-300"
      />
      <span>
        <span className="block text-sm font-medium text-neutral-200">
          {label}
          {pending && (
            <span className="ml-2 rounded border border-amber-900/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-amber-400">
              not enforced
            </span>
          )}
        </span>
        <span className="block text-xs text-neutral-500">{description}</span>
      </span>
    </label>
  );
}

function ReadOnlyCopyField({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail in insecure contexts; silently no-op.
    }
  }
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-300"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {help && <p className="mt-1 text-xs text-neutral-500">{help}</p>}
    </div>
  );
}

export function ProviderConfigPanel({
  provider,
  onClose,
}: {
  provider: ProviderRow;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Click outside the panel closes it. We exclude clicks on table rows so
  // selecting a different row doesn't immediately re-close the new panel.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const t = e.target as HTMLElement;
        if (t.closest("[data-provider-row]")) return;
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const cfg = provider.config ?? {};
  const hasSecret = Boolean((cfg as { client_secret?: string }).client_secret);

  return (
    <aside
      ref={panelRef}
      className="fixed right-0 top-0 z-40 flex h-screen w-[920px] max-w-full flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/40"
    >
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold text-neutral-100">{provider.label}</div>
          <div className="mt-0.5 font-mono text-xs text-neutral-500">{provider.name}</div>
          <p className="mt-2 text-xs text-neutral-400">{provider.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          ✕
        </button>
      </div>

      <form action={updateProvider} className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <input type="hidden" name="name" value={provider.name} />

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={provider.enabled}
              className="mt-1 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-200">
                Enabled
              </span>
              <span className="block text-xs text-neutral-500">
                When off, this provider's /auth/v1/* endpoints return 403.
              </span>
            </span>
          </label>

          {provider.name === "microsoft" && (
            <div className="mt-5 space-y-4 border-t border-neutral-800 pt-5">
              <div>
                <label
                  htmlFor="ms-client-id"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Client ID
                </label>
                <input
                  id="ms-client-id"
                  type="text"
                  name="client_id"
                  defaultValue={String(cfg.client_id ?? "")}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Azure portal → App registrations → your app → Overview →{" "}
                  <span className="font-mono">Application (client) ID</span>.
                </p>
              </div>
              <div>
                <label
                  htmlFor="ms-client-secret"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Client Secret (value)
                </label>
                <input
                  id="ms-client-secret"
                  type="password"
                  name="client_secret"
                  autoComplete="new-password"
                  placeholder={hasSecret ? "•••••• (saved, leave blank to keep)" : "Paste secret value"}
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Azure portal → Certificates &amp; secrets → New client secret
                  → copy the <strong>Value</strong> (not the secret ID).
                  Leave blank to keep the current value.
                </p>
              </div>
              <div>
                <label
                  htmlFor="ms-tenant"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Azure tenant
                </label>
                <input
                  id="ms-tenant"
                  type="text"
                  name="tenant"
                  defaultValue={String(cfg.tenant ?? "common")}
                  placeholder="common / consumers / organizations / <tenant-id>"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Tenant ID (GUID), domain (e.g.{" "}
                  <span className="font-mono">contoso.onmicrosoft.com</span>),
                  or one of <span className="font-mono">common</span> /{" "}
                  <span className="font-mono">organizations</span> /{" "}
                  <span className="font-mono">consumers</span>.
                </p>
              </div>

              {/* Read-only fields the admin pastes into Azure */}
              <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900/40 p-3">
                <div className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                  Register these in Azure
                </div>

                <ReadOnlyCopyField
                  label="Redirect URI (callback URL)"
                  value={provider.redirectUri ?? "(set API_PUBLIC_URL env var)"}
                  help="Azure portal → Authentication → Web → Redirect URIs. Must match exactly."
                />

                <ReadOnlyCopyField
                  label="Authority URL"
                  value={`https://login.microsoftonline.com/${
                    String(cfg.tenant ?? "common") || "common"
                  }/v2.0`}
                  help="Reference only — derived from the tenant above."
                />
              </div>
            </div>
          )}

          {provider.name === "email" && (
            <div className="mt-5 space-y-5 border-t border-neutral-800 pt-5">
              <ToggleField
                name="secure_email_change"
                defaultChecked={Boolean(cfg.secure_email_change ?? true)}
                label="Secure email change"
                description="Confirm on both the old and new email address. Not yet enforced — needs an email-change endpoint."
                pending
              />
              <ToggleField
                name="secure_password_change"
                defaultChecked={Boolean(cfg.secure_password_change ?? true)}
                label="Secure password change"
                description="Require a recent login (within 24h) to change password without re-auth. Not yet enforced — needs a password-change endpoint."
                pending
              />
              <ToggleField
                name="require_current_password_on_update"
                defaultChecked={Boolean(cfg.require_current_password_on_update ?? true)}
                label="Require current password when updating"
                description="User must supply their existing password when changing it. Not yet enforced — needs a password-change endpoint."
                pending
              />
              <ToggleField
                name="prevent_leaked_passwords"
                defaultChecked={Boolean(cfg.prevent_leaked_passwords ?? false)}
                label="Prevent use of leaked passwords"
                description="Checks new passwords against HaveIBeenPwned via k-anonymity (only the SHA-1 prefix leaves the server)."
              />

              <div>
                <label
                  htmlFor="email-min-pw"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Minimum password length
                </label>
                <input
                  id="email-min-pw"
                  type="number"
                  name="min_password_length"
                  min={6}
                  max={256}
                  defaultValue={Number(cfg.min_password_length ?? 12)}
                  className="mt-1 w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Passwords shorter than this are rejected at sign-up. Minimum 6,
                  but 8+ is recommended.
                </p>
              </div>

              <div>
                <label
                  htmlFor="email-pw-req"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Password requirements
                </label>
                <select
                  id="email-pw-req"
                  name="password_requirements"
                  defaultValue={String(cfg.password_requirements ?? "none")}
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
                >
                  <option value="none">No required characters (default)</option>
                  <option value="lowercase_uppercase">
                    Lowercase + uppercase
                  </option>
                  <option value="lowercase_uppercase_digits">
                    Lowercase + uppercase + digits
                  </option>
                  <option value="lowercase_uppercase_digits_symbols">
                    Lowercase + uppercase + digits + symbols
                  </option>
                </select>
                <p className="mt-1 text-xs text-neutral-500">
                  Passwords missing any required class are rejected as weak.
                </p>
              </div>

              <div>
                <label
                  htmlFor="email-otp-exp"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Email OTP expiration (seconds){" "}
                  <span className="text-amber-400/80">· not enforced</span>
                </label>
                <input
                  id="email-otp-exp"
                  type="number"
                  name="email_otp_expiration_seconds"
                  min={60}
                  max={30 * 24 * 3600}
                  defaultValue={Number(cfg.email_otp_expiration_seconds ?? 86400)}
                  className="mt-1 w-40 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  How long an OTP / magic link stays valid. Stored now; takes
                  effect when SMTP + OTP issuing endpoint land.
                </p>
              </div>

              <div>
                <label
                  htmlFor="email-otp-len"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Email OTP length{" "}
                  <span className="text-amber-400/80">· not enforced</span>
                </label>
                <input
                  id="email-otp-len"
                  type="number"
                  name="email_otp_length"
                  min={4}
                  max={12}
                  defaultValue={Number(cfg.email_otp_length ?? 6)}
                  className="mt-1 w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Digit count in the emailed code. Stored now; takes effect
                  alongside the OTP feature.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
          >
            Save
          </button>
        </div>
      </form>
    </aside>
  );
}
