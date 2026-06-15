import { pool } from "../db";
import { listEnums, SAFE_IDENT } from "../db-introspect";

// Generates a Supabase-style Database type from live introspection, so a
// TypeScript client gets Row/Insert/Update types per table without a build
// step or codegen dependency.

type ColumnRow = {
  table_schema: string;
  table_name: string;
  table_type: "BASE TABLE" | "VIEW";
  column_name: string;
  data_type: string;
  udt_schema: string;
  udt_name: string;
  nullable: boolean;
  has_default: boolean;
  is_identity: boolean;
};

// information_schema/PostgREST-relevant scalar mappings; anything unknown
// falls back to `unknown` rather than guessing.
const SCALAR: Record<string, string> = {
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  oid: "number",
  bool: "boolean",
  json: "Json",
  jsonb: "Json",
  text: "string",
  varchar: "string",
  bpchar: "string",
  citext: "string",
  uuid: "string",
  date: "string",
  time: "string",
  timetz: "string",
  timestamp: "string",
  timestamptz: "string",
  interval: "string",
  inet: "string",
  cidr: "string",
  macaddr: "string",
  bytea: "string",
  money: "string",
  bit: "string",
  varbit: "string",
  tsvector: "string",
  xml: "string",
};

function tsType(udtName: string, enums: Map<string, string[]>): string {
  if (udtName.startsWith("_")) {
    return `${tsType(udtName.slice(1), enums)}[]`;
  }
  const enumValues = enums.get(udtName);
  if (enumValues) {
    return enumValues.map((v) => JSON.stringify(v)).join(" | ");
  }
  return SCALAR[udtName] ?? "unknown";
}

export async function generateTypescriptTypes(schemas: string[]): Promise<string> {
  const valid = schemas.filter((s) => SAFE_IDENT.test(s));
  if (valid.length === 0) throw new Error("No valid schemas requested");

  const { rows } = await pool().query<ColumnRow>(
    `SELECT c.table_schema, c.table_name, t.table_type,
            c.column_name, c.data_type, c.udt_schema, c.udt_name,
            c.is_nullable = 'YES' AS nullable,
            c.column_default IS NOT NULL AS has_default,
            c.is_identity = 'YES' AS is_identity
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = ANY($1)
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
    [valid],
  );

  const enums = new Map<string, string[]>();
  for (const schema of valid) {
    for (const e of await listEnums(schema)) enums.set(e.name, e.values);
  }

  // schema → table → columns, split tables vs views.
  type TableCols = Map<string, ColumnRow[]>;
  const bySchema = new Map<string, { tables: TableCols; views: TableCols }>();
  for (const r of rows) {
    let s = bySchema.get(r.table_schema);
    if (!s) {
      s = { tables: new Map(), views: new Map() };
      bySchema.set(r.table_schema, s);
    }
    const bucket = r.table_type === "VIEW" ? s.views : s.tables;
    let cols = bucket.get(r.table_name);
    if (!cols) {
      cols = [];
      bucket.set(r.table_name, cols);
    }
    cols.push(r);
  }

  const lines: string[] = [
    "export type Json =",
    "  | string",
    "  | number",
    "  | boolean",
    "  | null",
    "  | { [key: string]: Json | undefined }",
    "  | Json[]",
    "",
    "export type Database = {",
  ];

  const ind = (n: number) => "  ".repeat(n);
  const quote = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : JSON.stringify(s));

  for (const [schema, { tables, views }] of [...bySchema.entries()].sort()) {
    lines.push(`${ind(1)}${quote(schema)}: {`);

    lines.push(`${ind(2)}Tables: {`);
    for (const [table, cols] of [...tables.entries()].sort()) {
      lines.push(`${ind(3)}${quote(table)}: {`);
      lines.push(`${ind(4)}Row: {`);
      for (const c of cols) {
        const t = tsType(c.udt_name, enums);
        lines.push(`${ind(5)}${quote(c.column_name)}: ${t}${c.nullable ? " | null" : ""}`);
      }
      lines.push(`${ind(4)}}`);
      lines.push(`${ind(4)}Insert: {`);
      for (const c of cols) {
        const t = tsType(c.udt_name, enums);
        const optional = c.nullable || c.has_default || c.is_identity;
        lines.push(
          `${ind(5)}${quote(c.column_name)}${optional ? "?" : ""}: ${t}${c.nullable ? " | null" : ""}`,
        );
      }
      lines.push(`${ind(4)}}`);
      lines.push(`${ind(4)}Update: {`);
      for (const c of cols) {
        const t = tsType(c.udt_name, enums);
        lines.push(`${ind(5)}${quote(c.column_name)}?: ${t}${c.nullable ? " | null" : ""}`);
      }
      lines.push(`${ind(4)}}`);
      lines.push(`${ind(3)}}`);
    }
    lines.push(`${ind(2)}}`);

    lines.push(`${ind(2)}Views: {`);
    for (const [view, cols] of [...views.entries()].sort()) {
      lines.push(`${ind(3)}${quote(view)}: {`);
      lines.push(`${ind(4)}Row: {`);
      for (const c of cols) {
        const t = tsType(c.udt_name, enums);
        lines.push(`${ind(5)}${quote(c.column_name)}: ${t}${c.nullable ? " | null" : ""}`);
      }
      lines.push(`${ind(4)}}`);
      lines.push(`${ind(3)}}`);
    }
    lines.push(`${ind(2)}}`);

    lines.push(`${ind(2)}Enums: {`);
    for (const schemaEnum of await listEnums(schema)) {
      lines.push(
        `${ind(3)}${quote(schemaEnum.name)}: ${schemaEnum.values.map((v) => JSON.stringify(v)).join(" | ")}`,
      );
    }
    lines.push(`${ind(2)}}`);

    lines.push(`${ind(1)}}`);
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}
