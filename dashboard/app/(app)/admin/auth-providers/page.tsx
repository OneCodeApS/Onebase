import { getAuthSettings, listProviders } from "@/lib/auth-settings";
import { authRedirectBase } from "@/lib/auth-oauth-microsoft";
import { Card } from "../../_components/Card";
import { updateAuthSettings } from "./actions";
import { ProvidersTable } from "./_components/ProvidersTable";
import type { ProviderRow } from "./_components/ProviderConfigPanel";

type ProviderDescriptor = {
  name: string;
  label: string;
  description: string;
};

const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    name: "email",
    label: "Email / password",
    description: "Sign-up + sign-in via email address and a password.",
  },
  {
    name: "microsoft",
    label: "Microsoft (Entra ID)",
    description: "OAuth 2.0 / OIDC sign-in using a Microsoft account.",
  },
];

function descriptorFor(name: string): ProviderDescriptor {
  return (
    PROVIDER_DESCRIPTORS.find((d) => d.name === name) ?? {
      name,
      label: name,
      description: "",
    }
  );
}

export default async function AuthProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const [settings, providers] = await Promise.all([
    getAuthSettings(),
    listProviders(),
  ]);

  const base = authRedirectBase();
  const rows: ProviderRow[] = providers.map((p) => ({
    name: p.name,
    enabled: p.enabled,
    config: p.config,
    label: descriptorFor(p.name).label,
    description: descriptorFor(p.name).description,
    redirectUri:
      p.name === "microsoft" && base
        ? `${base}/auth/v1/microsoft/callback`
        : null,
  }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Auth providers</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Controls how end users sign in to your applications. Changes take
        effect immediately for the next request.
      </p>

      {sp.error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {sp.error}
        </p>
      )}
      {sp.ok && (
        <p className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {sp.ok}
        </p>
      )}

      {/* Section 1: global flags */}
      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">Global</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Affects every provider.
        </p>

        <form action={updateAuthSettings} className="mt-4 space-y-4">
          <ToggleRow
            name="allow_signups"
            defaultChecked={settings.allow_signups}
            label="Allow new signups"
            description="When off, /auth/v1/signup returns 403. Existing users can still sign in."
          />
          <ToggleRow
            name="confirm_email"
            defaultChecked={settings.confirm_email}
            label="Require email confirmation"
            description="Persisted but not yet enforced — SMTP delivery isn't wired."
          />

          <div className="flex justify-end border-t border-neutral-800 pt-4">
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
            >
              Save
            </button>
          </div>
        </form>
      </Card>

      {/* Section 2: providers — click a row to configure */}
      <div className="mt-6">
        <h2 className="text-lg font-medium">Providers</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Click a row to open its configuration. More than one provider can be
          enabled at a time.
        </p>

        <Card className="mt-3 overflow-x-auto">
          <ProvidersTable providers={rows} />
        </Card>
      </div>
    </main>
  );
}

function ToggleRow({
  name,
  defaultChecked,
  label,
  description,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  description: string;
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
        <span className="block text-sm font-medium text-neutral-200">{label}</span>
        <span className="block text-xs text-neutral-500">{description}</span>
      </span>
    </label>
  );
}
