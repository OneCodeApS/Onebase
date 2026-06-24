import { getAnonKey } from "@/lib/auth-jwt";
import { getSession } from "@/lib/session";
import { ConnectModal } from "./ConnectModal";

// Best-effort hostname for the SSH-tunnel hint, derived from the public API URL
// (e.g. https://api.example.com → example.com). It's only a starting point —
// the actual SSH host may differ — so the modal labels it as adjustable.
function tunnelHostHint(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).hostname;
    return host.replace(/^api\./, "");
  } catch {
    return "your-server";
  }
}

// Top bar shown across the authenticated app. Holds the Connect button, which
// surfaces the project's API URL + anon key for wiring up a client app.
export async function Header() {
  const apiUrl = (process.env.API_PUBLIC_URL ?? "").replace(/\/+$/, "");

  // The anon key is a deterministic JWT derived from PGRST_JWT_SECRET. Minting
  // it can only fail if that secret is missing/short — in which case the rest
  // of the platform is already broken — so degrade to no button rather than
  // taking down every page with a render error.
  let anonKey = "";
  try {
    anonKey = await getAnonKey();
  } catch {
    anonKey = "";
  }

  const canConnect = apiUrl !== "" && anonKey !== "";

  // The direct-database connection details (for Power BI / SQL clients over an
  // SSH tunnel) are admin-only — they describe a privileged access path, so
  // non-admin operators never see this section of the modal.
  const session = await getSession();
  const directDb =
    session.role === "admin"
      ? {
          host: tunnelHostHint(apiUrl),
          database: process.env.POSTGRES_DB || "postgres",
          user: "bi_readonly",
        }
      : null;

  return (
    <header className="flex h-12 shrink-0 items-center justify-end border-b border-neutral-800 bg-neutral-950 px-4">
      {canConnect && (
        <ConnectModal apiUrl={apiUrl} anonKey={anonKey} directDb={directDb} />
      )}
    </header>
  );
}
