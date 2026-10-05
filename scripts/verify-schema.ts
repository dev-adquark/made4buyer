/**
 * Fails (exit 1) unless the database has every table, column and enum value this build needs.
 * Production builds run it right after `prisma migrate deploy`, so code that needs schema the
 * database lacks can never go live. Read-only; prints names only, never connection details.
 */
import { PrismaClient } from "@prisma/client";
import { checkSchema } from "../lib/ops/schema-check";

const db = new PrismaClient();
checkSchema(db)
  .then((r) => {
    if (r.ok) {
      console.log("schema check: OK (database matches this build)");
      return;
    }
    console.error("schema check FAILED: the database is missing what this build needs");
    for (const [label, list] of [["tables", r.missingTables], ["columns", r.missingColumns], ["enum values", r.missingEnumValues]] as const) if (list.length) console.error(`  missing ${label}: ${list.join(", ")}`);
    process.exitCode = 1;
  })
  .catch((e) => {
    console.error(`schema check FAILED: could not query the database (${e instanceof Error ? e.message.split("\n")[0] : "error"})`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
