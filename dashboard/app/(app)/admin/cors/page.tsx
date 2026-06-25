import { getSetting } from "@/lib/settings";
import { ORIGINS_SETTING_KEY, envAllowedOrigins } from "@/lib/cors";
import { Card } from "../../_components/Card";
import { addOrigin, removeOrigin } from "./actions";

export default async function CorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const stored = await getSetting<string[]>(ORIGINS_SETTING_KEY);
  const usingDb = Array.isArray(stored);
  const origins = usingDb ? stored : envAllowedOrigins();
  const hasWildcard = origins.includes("*");

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mt-4 text-2xl font-semibold">CORS origins</h1>

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

      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">Allowed browser origins</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Browser apps served from these origins may read responses from the
          public API. Applies to{" "}
          <span className="font-mono text-neutral-300">/auth/v1/*</span>,{" "}
          <span className="font-mono text-neutral-300">/realtime</span>,{" "}
          <span className="font-mono text-neutral-300">/functions/v1/*</span>, and the
          storage URL-issuance endpoints (
          <span className="font-mono text-neutral-300">/storage/v1/object/sign</span>,{" "}
          <span className="font-mono text-neutral-300">sign-batch</span>,{" "}
          <span className="font-mono text-neutral-300">upload</span>). Non-browser
          clients (curl, server-to-server) ignore CORS and keep working regardless.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {usingDb ? (
            <>Managed here and stored in the database.</>
          ) : (
            <>
              Currently inherited from the{" "}
              <span className="font-mono">AUTH_ALLOWED_ORIGINS</span> env var.
              Saving any change below moves management into the database (the
              current env values are kept as the starting point).
            </>
          )}
        </p>

        {hasWildcard && (
          <p className="mt-3 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            <span className="font-mono">*</span> allows <strong>any</strong>{" "}
            origin to read API responses. These APIs are bearer-token only (no
            cookies are ever sent), but for production you should remove{" "}
            <span className="font-mono">*</span> and list explicit origins.
          </p>
        )}

        <form action={addOrigin} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            name="origin"
            required
            placeholder="https://app.example.com"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm"
          />
          <button
            type="submit"
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Add origin
          </button>
        </form>
        <p className="mt-1 text-xs text-neutral-500">
          Exact origin: <span className="font-mono">scheme://host[:port]</span>,
          no path or trailing slash. Use <span className="font-mono">*</span> to
          allow any origin.
        </p>

        <ul className="mt-4 divide-y divide-neutral-800 border-t border-neutral-800">
          {origins.length === 0 ? (
            <li className="py-3 text-sm text-neutral-500">
              No origins allowed — browser apps from other origins are blocked
              from reading responses. Non-browser clients still work.
            </li>
          ) : (
            origins.map((o) => (
              <li
                key={o}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="font-mono text-sm text-neutral-200">
                  {o === "*" ? "* (any origin)" : o}
                </span>
                <form action={removeOrigin} className="inline">
                  <input type="hidden" name="origin" value={o} />
                  <button
                    type="submit"
                    className="text-xs text-neutral-400 underline hover:text-red-300"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))
          )}
        </ul>
      </Card>

      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">What this does not cover</h2>
        <p className="mt-1 text-sm text-neutral-500">
          PostgREST (<span className="font-mono">/rest/v1</span>,{" "}
          <span className="font-mono">/rpc/v1</span>) handles its own CORS, and
          actual file downloads/uploads go straight to MinIO — neither is
          governed by this list.
        </p>
      </Card>
    </main>
  );
}
