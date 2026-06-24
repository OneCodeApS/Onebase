import { Card } from "../../../_components/Card";
import { RotateBiPassword } from "../_components/RotateBiPassword";

export default function DatabaseSettingsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mt-4 text-2xl font-semibold">Database</h1>

      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">Direct access (Power BI / SQL clients)</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The read-only{" "}
          <span className="font-mono text-neutral-300">bi_readonly</span> login is
          for external tools (Power BI, Excel, DBeaver) connecting to the database
          over an SSH tunnel — its connection details are in the{" "}
          <span className="text-neutral-300">Connect</span> dialog (top bar).
          Rotate the password here if it leaks; this also sets it the first time
          without editing <span className="font-mono text-neutral-300">.env</span>.
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          A new strong password is generated and shown once. It takes effect
          immediately, with no restart. The role must exist first (migration{" "}
          <span className="font-mono">0030</span>).
        </p>
        <RotateBiPassword />
      </Card>
    </main>
  );
}
