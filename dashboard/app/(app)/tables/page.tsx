export default async function TablesIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  return (
    <main className="px-6 py-16 text-center">
      {(sp.error || sp.ok) && (
        <div className="mx-auto mb-6 max-w-md">
          {sp.error && (
            <p className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {sp.error}
            </p>
          )}
          {sp.ok && (
            <p className="rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
              {sp.ok}
            </p>
          )}
        </div>
      )}
      <h1 className="text-xl font-semibold">No table selected</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Pick a table from the sidebar to browse its rows.
      </p>
    </main>
  );
}
