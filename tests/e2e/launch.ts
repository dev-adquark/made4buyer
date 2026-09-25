/**
 * Boots the E2E environment: embedded PostgreSQL (migrated from zero), the SAMPLE stub
 * server, and `next start` with test credentials. Loopback verification is enabled only
 * through the explicit test flag.
 */
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { migrate, startLocalPostgres } from "../../scripts/support/local-postgres";
import { startStubServer } from "../../scripts/support/stub-server";

async function main() {
  const port = Number(process.env.E2E_PORT ?? 3100);
  // CI provides an empty Postgres via E2E_DATABASE_URL; locally an embedded server is started.
  let pg: { url: string; stop: () => Promise<void> };
  if (process.env.E2E_DATABASE_URL) {
    migrate(process.env.E2E_DATABASE_URL);
    pg = { url: process.env.E2E_DATABASE_URL, stop: async () => undefined };
  } else {
    rmSync(".tmp/pg-e2e", { recursive: true, force: true });
    pg = await startLocalPostgres({ dir: ".tmp/pg-e2e", port: 56432, database: "made4buyers_e2e", fresh: true });
  }
  // Each run starts from an empty ISR cache so pages cached by an earlier run (possibly
  // against a different database) can't leak into this one. The route template dir stays.
  const isr = ".next/server/app/review";
  try {
    for (const f of readdirSync(isr)) if (f !== "[slug]") rmSync(`${isr}/${f}`, { recursive: true, force: true });
  } catch {
    /* no build output yet */
  }
  const stub = await startStubServer({ port: 4011, sovrnKey: "e2e-sovrn" });
  const env = {
    ...process.env,
    NODE_ENV: "production" as const,
    PORT: String(port),
    DATABASE_URL: pg.url,
    NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
    CONTENT_API_URL: `${stub.base}/content`,
    CONTENT_API_SOURCE_NAME: "sample-fixture",
    SOVRN_API_URL: `${stub.base}/sovrn`,
    SOVRN_API_KEY: "e2e-sovrn",
    ADMIN_EMAIL: "admin@e2e.test",
    ADMIN_PASSWORD: "e2e-password-123456",
    ADMIN_SESSION_SECRET: "e2e-session-secret-with-at-least-32-characters",
    CRON_SECRET: "e2e-cron-secret",
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    ANALYTICS_MIN_IMPRESSIONS: "1",
    LOG_SILENT: "1",
  };
  const next = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", String(port)], { env, stdio: "inherit" });
  const shutdown = async () => {
    next.kill("SIGTERM");
    await stub.close();
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  next.on("exit", async (code) => {
    await stub.close().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
