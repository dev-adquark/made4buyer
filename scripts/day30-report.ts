/** Generates the Day-30 report (JSON + HTML) from the database in DATABASE_URL and writes it to reports/generated/. */
import "./support/load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { db } from "@/lib/db";
import { generateDay30Report } from "@/lib/reports/day30";

async function main() {
  const { id, report, html } = await generateDay30Report({ actor: "cli" });
  mkdirSync("reports/generated", { recursive: true });
  const base = `reports/generated/day30-${report.generatedAt.slice(0, 10)}`;
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${base}.html`, html);
  console.log(`Day-30 report ${id} written to ${base}.json and ${base}.html`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
