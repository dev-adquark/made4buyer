import { connection } from "next/server";

/**
 * Pages without a dynamic segment (the home page) are prerendered at build time, which needs the
 * database. A build without DATABASE_URL (local checks, CI) renders those routes on request
 * instead of failing; production builds have the database and ship them prerendered as ISR.
 * Never triggers at runtime, so an ISR regeneration can never flip a page to dynamic.
 */
export async function prerenderNeedsDatabase() {
  if (process.env.NEXT_PHASE === "phase-production-build" && !process.env.DATABASE_URL) await connection();
}
