/**
 * Vercel build entry (`vercel-build`). Production deploy order, enforced:
 *   1. prisma migrate deploy  (pending migrations; all are additive and idempotent)
 *   2. verify-schema          (every table/column/enum value this build needs exists)
 *   3. the normal build
 * Any failure stops the build, so the previous deployment keeps serving. Preview builds never
 * touch the database schema.
 */
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
if (process.env.VERCEL_ENV === "production") {
  console.log("production build: applying migrations, then verifying the schema before building");
  run("npx prisma migrate deploy");
  run("npx tsx scripts/verify-schema.ts");
} else {
  console.log(`${process.env.VERCEL_ENV ?? "local"} build: schema untouched`);
}
run("npm run build");
