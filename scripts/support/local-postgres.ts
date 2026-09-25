import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

/**
 * Starts a real PostgreSQL server (embedded-postgres binaries) for local development and
 * integration tests, then applies the Prisma migrations with `prisma migrate deploy`.
 */
export async function startLocalPostgres(opts: { dir: string; port: number; database: string; persistent?: boolean; fresh?: boolean }) {
  const pg = new EmbeddedPostgres({ databaseDir: opts.dir, user: "postgres", password: "postgres", port: opts.port, persistent: opts.persistent ?? false, onLog: () => undefined, onError: () => undefined });
  const initialised = existsSync(path.join(opts.dir, "PG_VERSION"));
  if (!initialised) await pg.initialise();
  try {
    await pg.start();
  } catch (error) {
    // embedded-postgres rejects with `undefined` when the port is taken; say so.
    throw new Error(`PostgreSQL failed to start on port ${opts.port}${error ? `: ${String(error)}` : " (is the port already in use? set LOCAL_PG_PORT)"}`);
  }
  const url = `postgresql://postgres:postgres@127.0.0.1:${opts.port}/${opts.database}`;
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [opts.database]);
  if (opts.fresh && exists.rowCount) await client.query(`DROP DATABASE "${opts.database}" WITH (FORCE)`);
  if (!exists.rowCount || opts.fresh) await client.query(`CREATE DATABASE "${opts.database}"`);
  await client.end();
  migrate(url);
  return { url, stop: () => pg.stop() };
}

export function migrate(url: string) {
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
