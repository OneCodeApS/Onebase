import { notFound } from "next/navigation";
import { Card } from "../../../../_components/Card";
import { ConfirmDeleteForm } from "../../../../_components/ConfirmDeleteForm";
import { FUNCTION_NAME, getFunction } from "@/lib/functions";
import { removeFunction, saveOverview } from "../../actions";
import { getSession } from "@/lib/session";

export default async function OverviewPage({
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
  const session = await getSession();
  const isAdmin = session.role === "admin";

  const updated =
    fn.updated_at instanceof Date ? fn.updated_at : new Date(fn.updated_at);
  const created =
    fn.created_at instanceof Date ? fn.created_at : new Date(fn.created_at);

  return (
    <div className="space-y-6">
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

      {isAdmin ? (
      <Card padded>
        <h2 className="text-lg font-medium">Settings</h2>
        <form action={saveOverview} className="mt-4 space-y-4">
          <input type="hidden" name="name" value={fn.name} />

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={fn.enabled}
              className="mt-1 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-200">
                Enabled
              </span>
              <span className="block text-xs text-neutral-500">
                When off, /functions/v1/{fn.name} returns 404.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="verify_jwt"
              defaultChecked={fn.verify_jwt}
              className="mt-1 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-200">
                Verify JWT
              </span>
              <span className="block text-xs text-neutral-500">
                Require a valid JWT in{" "}
                <span className="font-mono">Authorization: Bearer …</span>{" "}
                (or <span className="font-mono">?token=</span>). Tokens are
                verified with the shared <span className="font-mono">PGRST_JWT_SECRET</span>
                {" "}— anything that authenticates against PostgREST works here.
                Cron-triggered runs always bypass this check.
              </span>
              {!fn.verify_jwt && (
                <span className="mt-1 block rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1 text-xs text-amber-300">
                  This function is currently public — anyone can invoke it.
                </span>
              )}
            </span>
          </label>

          <div>
            <label
              htmlFor="ov-min-role"
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Minimum role
            </label>
            <select
              id="ov-min-role"
              name="min_role"
              defaultValue={fn.min_role}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            >
              <option value="anon">anon — any signed key (incl. the public anon key)</option>
              <option value="authenticated">authenticated — a signed-in end user</option>
              <option value="service_role">service_role — server-side only</option>
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              When Verify JWT is on, the caller&apos;s token role must meet this.
              Default <span className="font-mono">authenticated</span> means the
              public anon key alone won&apos;t reach the function. Ignored when
              Verify JWT is off.
            </p>
          </div>

          <div>
            <label
              htmlFor="ov-description"
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Description
            </label>
            <input
              id="ov-description"
              type="text"
              name="description"
              defaultValue={fn.description ?? ""}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="ov-timeout"
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Timeout (ms)
            </label>
            <input
              id="ov-timeout"
              type="number"
              name="timeout_ms"
              min={100}
              max={60000}
              defaultValue={fn.timeout_ms}
              className="mt-1 w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Max wall-clock time per invocation. 100ms – 60s.
            </p>
          </div>

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
      ) : (
      <Card padded>
        <h2 className="text-lg font-medium">Settings</h2>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-neutral-500">Enabled</dt>
          <dd className="font-mono text-neutral-200">{fn.enabled ? "yes" : "no"}</dd>
          <dt className="text-neutral-500">Verify JWT</dt>
          <dd className="font-mono text-neutral-200">{fn.verify_jwt ? "yes" : "no"}</dd>
          <dt className="text-neutral-500">Min role</dt>
          <dd className="font-mono text-neutral-200">{fn.min_role}</dd>
          <dt className="text-neutral-500">Description</dt>
          <dd className="text-neutral-300">{fn.description || "—"}</dd>
          <dt className="text-neutral-500">Timeout</dt>
          <dd className="font-mono text-neutral-200">{fn.timeout_ms}ms</dd>
        </dl>
      </Card>
      )}

      <Card padded>
        <h2 className="text-lg font-medium">Metadata</h2>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-neutral-500">URL</dt>
          <dd className="font-mono text-neutral-200">/functions/v1/{fn.name}</dd>
          <dt className="text-neutral-500">Created</dt>
          <dd className="font-mono text-neutral-300">
            {created.toISOString().slice(0, 19).replace("T", " ")}
          </dd>
          <dt className="text-neutral-500">Updated</dt>
          <dd className="font-mono text-neutral-300">
            {updated.toISOString().slice(0, 19).replace("T", " ")}
          </dd>
        </dl>
      </Card>

      {isAdmin && (
      <Card padded>
        <h2 className="text-lg font-medium text-red-300">Danger zone</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Deletes the function record. Doesn't affect anything else in the DB.
        </p>
        <div className="mt-4">
          <ConfirmDeleteForm
            action={removeFunction}
            triggerLabel="Delete function"
            triggerClassName="rounded border border-red-900/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40"
            title="Delete function?"
            confirmLabel="Delete function"
            message={
              <>
                Permanently delete{" "}
                <span className="font-mono text-neutral-100">{fn.name}</span>?
                Any cron jobs that invoke it will start failing on their next run.
                This cannot be undone.
              </>
            }
          >
            <input type="hidden" name="name" value={fn.name} />
          </ConfirmDeleteForm>
        </div>
      </Card>
      )}
    </div>
  );
}
