/**
 * Read-only go-live preflight (see lib/ops/live-check.ts).
 *   npm run live:check
 *   npm run live:check -- --product "Pixel 10" --brand Google
 * Exit code 1 when any configured integration fails.
 */
import "./support/load-env";
import { db } from "@/lib/db";
import { runLiveCheck } from "@/lib/ops/live-check";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

runLiveCheck({ product: arg("product"), brand: arg("brand") })
  .then(async (report) => {
    await db.$disconnect().catch(() => undefined);
    for (const r of report.results) console.log(`${r.status.padEnd(22)} ${r.integration}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("live-check crashed:", (error as Error).message);
    process.exit(1);
  });
