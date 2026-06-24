import { getSetting } from "@/lib/settings";
import { Card } from "../../../_components/Card";
import { Flash } from "../_components/Flash";
import { updateApiMaxRows } from "../actions";

export default async function ApiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const apiMaxRows = await getSetting<number>("api_max_rows");

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mt-4 text-2xl font-semibold">API</h1>
      <Flash ok={sp.ok} error={sp.error} />

      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">Max rows per request</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The most rows a single REST request to{" "}
          <span className="font-mono text-neutral-300">/rest/v1</span> can return.
          Clients page through larger result sets with{" "}
          <span className="font-mono text-neutral-300">limit</span>/
          <span className="font-mono text-neutral-300">offset</span> or a{" "}
          <span className="font-mono text-neutral-300">Range</span> header. Leave
          empty to use the server default.
        </p>
        <p className="mt-1 text-xs text-amber-300/80">
          Takes effect after the API restarts:{" "}
          <span className="font-mono">docker compose restart postgrest</span>.
          Live reload is disabled behind PgBouncer, so the new value isn&apos;t
          applied until then.
        </p>

        <form action={updateApiMaxRows} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="number"
            name="max_rows"
            min={1}
            step={1}
            defaultValue={apiMaxRows ?? ""}
            placeholder="1000 (default)"
            className="w-40 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm"
          />
          <span className="self-center text-sm text-neutral-400">rows</span>
          <div className="flex-1" />
          <button
            type="submit"
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Save
          </button>
        </form>
      </Card>
    </main>
  );
}
