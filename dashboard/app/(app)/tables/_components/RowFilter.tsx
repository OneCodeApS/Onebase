"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Single-column row filter for the Data tab. Builds a fresh URL (dropping any
// after/before cursor so the result starts at the first page) and navigates;
// the server component re-renders with the filter applied. Kept deliberately
// simple — one column, contains/equals — and only shown for keyset-paged tables
// (those with a single-column PK), since the server filter rides on that query.
const DEFAULT_SCHEMA = "public";

export function RowFilter({
  name,
  schema,
  columns,
  current,
}: {
  name: string;
  schema: string;
  columns: { column_name: string }[];
  current: { col: string; op: string; val: string } | null;
}) {
  const router = useRouter();
  const [col, setCol] = useState(current?.col ?? columns[0]?.column_name ?? "");
  const [op, setOp] = useState(current?.op ?? "contains");
  const [val, setVal] = useState(current?.val ?? "");

  const base = `/tables/${encodeURIComponent(name)}`;

  function navigate(withFilter: boolean) {
    const p = new URLSearchParams();
    if (schema !== DEFAULT_SCHEMA) p.set("schema", schema);
    if (withFilter && col && val !== "") {
      p.set("fcol", col);
      p.set("fop", op);
      p.set("fval", val);
    }
    const qs = p.toString();
    router.push(qs ? `${base}?${qs}` : base);
  }

  const inputCls =
    "rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-neutral-500";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        navigate(true);
      }}
      className="mt-4 flex flex-wrap items-center gap-2"
    >
      <select
        value={col}
        onChange={(e) => setCol(e.target.value)}
        className={`${inputCls} font-mono`}
        aria-label="Filter column"
      >
        {columns.map((c) => (
          <option key={c.column_name} value={c.column_name}>
            {c.column_name}
          </option>
        ))}
      </select>
      <select
        value={op}
        onChange={(e) => setOp(e.target.value)}
        className={inputCls}
        aria-label="Filter operator"
      >
        <option value="contains">contains</option>
        <option value="eq">equals</option>
      </select>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="value"
        className={`${inputCls} min-w-40 flex-1`}
        aria-label="Filter value"
      />
      <button
        type="submit"
        className="rounded bg-neutral-200 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-white"
      >
        Filter
      </button>
      {current && (
        <button
          type="button"
          onClick={() => {
            setVal("");
            navigate(false);
          }}
          className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Clear
        </button>
      )}
    </form>
  );
}
