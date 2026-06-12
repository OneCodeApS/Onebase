import { getAnonKey } from "@/lib/auth-jwt";
import { ConnectModal } from "./ConnectModal";

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

  return (
    <header className="flex h-12 shrink-0 items-center justify-end border-b border-neutral-800 bg-neutral-950 px-4">
      {canConnect && <ConnectModal apiUrl={apiUrl} anonKey={anonKey} />}
    </header>
  );
}
