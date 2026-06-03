import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { login } from "./actions";
import { SubmitButton } from "./_components/SubmitButton";

type SearchParams = Promise<{ next?: string; error?: string }>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getSession();
  if (session.userId) {
    redirect("/");
  }

  const { next, error } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-base font-semibold tracking-tight text-neutral-100">
            Onebase
          </div>
          <div className="mt-1 text-xs text-neutral-500">Admin dashboard</div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-6 shadow-2xl shadow-black/40 backdrop-blur">
          <h1 className="text-lg font-semibold text-neutral-100">Sign in</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Welcome back. Enter your credentials to continue.
          </p>

          <form action={login} className="mt-6 space-y-4">
            <input type="hidden" name="next" value={next ?? "/"} />

            <label className="block">
              <span className="text-xs font-medium text-neutral-300">Email</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="username"
                placeholder="you@company.com"
                className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-neutral-400 focus:ring-2 focus:ring-neutral-700/50"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-neutral-300">Password</span>
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-neutral-400 focus:ring-2 focus:ring-neutral-700/50"
              />
            </label>

            {error ? (
              <p className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-400">
                {error}
              </p>
            ) : null}

            <SubmitButton />
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-neutral-600">
          Authorized personnel only
        </p>
      </div>
    </main>
  );
}
