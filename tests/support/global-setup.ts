import type { TestProject } from "vitest/node";
import { migrate, startLocalPostgres } from "../../scripts/support/local-postgres";

/**
 * Integration tests run against a real PostgreSQL: TEST_DATABASE_URL when provided (CI
 * service container), otherwise an embedded PostgreSQL started for the run. Migrations are
 * applied from prisma/migrations, so this also proves a fresh database migrates from zero.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;
  if (url) {
    migrate(url);
  } else {
    const port = 55000 + Math.floor(Math.random() * 2000);
    const pg = await startLocalPostgres({ dir: `.tmp/pg-test-${port}`, port, database: "made4buyers_test", persistent: false, fresh: true });
    url = pg.url;
    stop = pg.stop;
  }
  project.provide("databaseUrl", url);
  return async () => {
    if (stop) await stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
