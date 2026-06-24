// Flash banner for the redirect-based settings forms (?ok= / ?error=).
// Shared across the settings sub-pages.
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <>
      {error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {ok && (
        <p className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {ok}
        </p>
      )}
    </>
  );
}
