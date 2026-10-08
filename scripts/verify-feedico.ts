/**
 * Feedico coupon feed check. ONE catalogue request (page 1, pageSize 5); prints only the HTTP result,
 * the total coded-coupon count, the providers and the field names of the first row, never the key.
 *
 *   npx tsx scripts/verify-feedico.ts
 *
 * FEEDICO_API_KEY is read from the environment (or .env.local/.env). The request counts against the
 * Feedico monthly quota (1 of 1,000 on the Free plan). Exit 0 = the key works and the response matches
 * the contract lib/commerce/feedico.ts expects.
 */
import "./support/load-env";
import { fetchFeedicoCoupons, feedicoConfigured } from "@/lib/commerce/feedico";

export async function main(): Promise<number> {
  if (!feedicoConfigured()) {
    console.log("FEEDICO_API_KEY        MISSING (set it in Vercel → Production, or .env.local for this check)");
    return 1;
  }
  const res = await fetchFeedicoCoupons({ page: 1, pageSize: 5 });
  if (!res.ok) {
    console.log(`catalogue request      FAIL ${res.error.kind}${res.error.status ? ` (HTTP ${res.error.status})` : ""}: ${res.error.message}`);
    return 1;
  }
  const first = res.page.coupons[0];
  console.log(`catalogue request      ok (HTTP 200)`);
  console.log(`coded coupons          ${res.page.recordCount}`);
  console.log(`rows on this page      ${res.page.coupons.length}`);
  console.log(`providers on page      ${[...new Set(res.page.coupons.map((c) => c.provider ?? "unknown"))].join(", ") || "none"}`);
  console.log(`row fields             ${first ? Object.entries(first).filter(([, v]) => v !== null).map(([k]) => k).join(", ") : "no rows"}`);
  return 0;
}

if (process.argv[1]?.endsWith("verify-feedico.ts")) main().then((code) => process.exit(code));
