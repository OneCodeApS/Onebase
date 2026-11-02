import Link from "next/link";
import { notFound } from "next/navigation";
import { FUNCTION_NAME, getFunction } from "@/lib/functions";
import { FunctionTabs } from "./_components/FunctionTabs";
import { getSession } from "@/lib/session";

export default async function FunctionDetailLayout({
  params,
  children,
}: {
  params: Promise<{ name: string }>;
  children: React.ReactNode;
}) {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  if (!FUNCTION_NAME.test(name)) notFound();
  const fn = await getFunction(name);
  if (!fn) notFound();
  const session = await getSession();
  const isAdmin = session.role === "admin";

  return (
    <main className="flex min-h-full flex-col px-6 py-10">
      <Link
        href="/admin/functions"
        className="text-sm text-neutral-400 hover:text-neutral-100"
      >
        ← Edge functions
      </Link>
      <div className="mt-3 flex items-baseline gap-3">
        <h1 className="font-mono text-2xl font-semibold">{name}</h1>
        {fn.enabled ? (
          <span className="rounded border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-xs text-emerald-300">
            enabled
          </span>
        ) : (
          <span className="rounded border border-neutral-700 bg-neutral-800/40 px-2 py-0.5 text-xs text-neutral-400">
            disabled
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        {fn.description || "No description"}
      </p>

      <div className="mt-6">
        <FunctionTabs name={name} isAdmin={isAdmin} />
      </div>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">{children}</div>
    </main>
  );
}
