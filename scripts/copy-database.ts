/**
 * Copies every Made4Buyers table from one PostgreSQL database to another (e.g. Neon →
 * Supabase) after the target has been migrated with `prisma migrate deploy`.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:copy            # dry run: counts only
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:copy -- --apply
 *
 * - Tables are copied in foreign-key dependency order, in one transaction on the target.
 * - Rows round-trip through row_to_json / json_populate_recordset, so enums, arrays, JSON
 *   and timestamps keep their exact types and values; primary keys are preserved.
 * - Refuses to write into a target table that already has rows (no silent merging).
 * - `_prisma_migrations` is not copied: the target's own migration history is authoritative.
 * - Prints a per-table Source / Target / Difference / Status comparison and exits 1 on mismatch.
 * Connection strings are never printed.
 */
import pg from "pg";

const BATCH = 500;

function client(url: string | undefined, name: string) {
  if (!url) throw new Error(`${name} is not set`);
  const u = new URL(url);
  u.searchParams.delete("pgbouncer");
  u.searchParams.delete("connection_limit");
  u.searchParams.delete("channel_binding");
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (!local) u.searchParams.set("sslmode", "no-verify");
  return new pg.Client({ connectionString: u.toString(), ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
}

async function tables(c: pg.Client): Promise<string[]> {
  const r = await c.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename");
  return r.rows.map((x) => x.tablename);
}

async function dependencyOrder(c: pg.Client, names: string[]): Promise<string[]> {
  const fk = await c.query<{ child: string; parent: string }>(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  const deps = new Map(names.map((n) => [n, new Set<string>()]));
  for (const { child, parent } of fk.rows) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  const out: string[] = [];
  const visit = (n: string, seen = new Set<string>()) => {
    if (out.includes(n)) return;
    if (seen.has(n)) throw new Error(`Foreign-key cycle at ${n}`);
    seen.add(n);
    for (const p of deps.get(n) ?? []) visit(p, seen);
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

async function primaryKey(c: pg.Client, t: string): Promise<string> {
  const r = await c.query<{ col: string }>(
    `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    [`public."${t}"`],
  );
  if (!r.rowCount) throw new Error(`Table ${t} has no primary key; cannot page deterministically`);
  return r.rows.map((x) => `x."${x.col}"`).join(", ");
}

async function count(c: pg.Client, t: string) {
  return Number((await c.query(`SELECT count(*)::bigint AS n FROM public."${t}"`)).rows[0].n);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const source = client(process.env.SOURCE_DATABASE_URL, "SOURCE_DATABASE_URL");
  const target = client(process.env.TARGET_DATABASE_URL, "TARGET_DATABASE_URL");
  await source.connect();
  await target.connect();
  try {
    const srcTables = await tables(source);
    const tgtTables = new Set(await tables(target));
    const missing = srcTables.filter((t) => !tgtTables.has(t));
    if (missing.length) throw new Error(`Target is missing tables (run prisma migrate deploy first): ${missing.join(", ")}`);
    const order = await dependencyOrder(source, srcTables);

    if (apply) {
      const nonEmpty: string[] = [];
      for (const t of order) if ((await count(target, t)) > 0) nonEmpty.push(t);
      if (nonEmpty.length) throw new Error(`Target tables already contain rows, refusing to merge: ${nonEmpty.join(", ")}`);
      await target.query("BEGIN");
      try {
        for (const t of order) {
          const pk = await primaryKey(source, t);
          let offset = 0;
          for (;;) {
            // Stable paging by primary key.
            const rows = await source.query(`SELECT row_to_json(x) AS r FROM public."${t}" x ORDER BY ${pk} LIMIT ${BATCH} OFFSET ${offset}`);
            if (!rows.rowCount) break;
            await target.query(`INSERT INTO public."${t}" SELECT * FROM json_populate_recordset(NULL::public."${t}", $1::json)`, [JSON.stringify(rows.rows.map((x) => x.r))]);
            offset += rows.rowCount;
            if (rows.rowCount < BATCH) break;
          }
        }
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK");
        throw error;
      }
    }

    const report: Array<{ table: string; source: number; target: number; difference: number; status: string }> = [];
    for (const t of order) {
      const s = await count(source, t);
      const d = await count(target, t);
      report.push({ table: t, source: s, target: d, difference: d - s, status: !apply ? "DRY_RUN" : s === d ? "OK" : "MISMATCH" });
    }
    console.table(report);
    const bad = report.filter((r) => r.status === "MISMATCH");
    console.log(apply ? (bad.length ? `MISMATCH in ${bad.length} table(s)` : `All ${report.length} tables match`) : "Dry run only — re-run with --apply to copy.");
    if (bad.length) process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
