import Link from "next/link";
import { Card } from "../../_components/Card";
import { listRealtimeStatus } from "@/lib/realtime";
import { RealtimeTableList } from "./_components/RealtimeTableList";

export default async function RealtimePage() {
  const tables = await listRealtimeStatus();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">Realtime</h1>
        <Link
          href="/admin/realtime/logs"
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          View logs →
        </Link>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Enable per-table row-change streams over{" "}
        <span className="font-mono">/realtime?schema=&lt;s&gt;&amp;table=&lt;t&gt;</span>{" "}
        as Server-Sent Events. Subscribers need a valid access token from{" "}
        <span className="font-mono">/auth/v1</span>.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-neutral-500">
        <li>
          <span className="rounded border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 text-xs text-sky-200">
            Basic
          </span>{" "}
          broadcasts every change to all subscribers — RLS is <em>not</em> applied.
        </li>
        <li>
          <span className="rounded border border-emerald-900/60 bg-emerald-950/40 px-1.5 py-0.5 text-xs text-emerald-200">
            Authorized
          </span>{" "}
          filters each event per-subscriber by the table&apos;s RLS SELECT policy
          (requires RLS enabled on the table). When it delivers nothing, the{" "}
          <Link href="/admin/realtime/logs" className="underline hover:text-neutral-300">
            logs
          </Link>{" "}
          show why.
        </li>
      </ul>

      <Card className="mt-6" padded>
        <RealtimeTableList tables={tables} />
      </Card>
    </main>
  );
}
