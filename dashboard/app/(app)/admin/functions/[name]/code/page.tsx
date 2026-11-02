import { notFound } from "next/navigation";
import { FUNCTION_NAME, getFunction } from "@/lib/functions";
import { CodeEditor } from "./_components/CodeEditor";

export default async function CodePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { name: raw } = await params;
  const sp = await searchParams;
  const name = decodeURIComponent(raw);
  if (!FUNCTION_NAME.test(name)) notFound();
  const fn = await getFunction(name);
  if (!fn) notFound();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
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
      <CodeEditor name={fn.name} initialCode={fn.code} />
    </div>
  );
}
