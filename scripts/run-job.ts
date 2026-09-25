/** Runs a scheduled job from the CLI with the same code path and lock as cron: `npm run job -- <name>`. */
import "./support/load-env";
import { isJobName, JOBS, runJob } from "@/lib/jobs/registry";
import { db } from "@/lib/db";

async function main() {
  const name = process.argv[2] ?? "";
  if (!isJobName(name)) {
    console.error(`Usage: npm run job -- <${Object.keys(JOBS).join("|")}>`);
    process.exit(2);
  }
  const result = await runJob(name, "cli");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
