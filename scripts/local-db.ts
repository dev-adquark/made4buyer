/**
 * Starts a persistent local PostgreSQL (embedded binaries, no Docker needed), applies all
 * migrations and seeds the taxonomy. Keep it running while you use `npm run dev`.
 *
 *   npm run db:local            # data in .tmp/pgdata, port 54329
 *   npm run db:local -- --fresh # drop and recreate the database
 */
import { startLocalPostgres } from "./support/local-postgres";

async function main() {
  const fresh = process.argv.includes("--fresh");
  const { url, stop } = await startLocalPostgres({ dir: ".tmp/pgdata", port: Number(process.env.LOCAL_PG_PORT ?? 54329), database: "made4buyers", persistent: true, fresh });
  process.env.DATABASE_URL = url;
  const { seedTaxonomy } = await import("../lib/taxonomy/persist");
  await seedTaxonomy();
  console.log(`\nPostgreSQL ready. Migrations applied, taxonomy seeded.\n\n  DATABASE_URL="${url}"\n\nPress Ctrl+C to stop.`);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
