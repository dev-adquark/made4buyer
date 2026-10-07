/**
 * Google Search Console check with the configured service account. Prints statuses and counts
 * only (never the key, never the service-account email's private key).
 *
 *   GSC_SITE_URL=https://made4buyers.vercel.app/ GSC_SERVICE_ACCOUNT_JSON='{...}' npx tsx scripts/verify-gsc.ts
 *   ... --submit-sitemap     also submits /sitemap.xml (needs FULL permission on the property)
 *
 * Steps: token → sites.get (permission level) → sitemaps.list → 28-day clicks/impressions →
 * one URL inspection of the home page. Exit 0 = all OK, 2 = not configured, 1 = a failure.
 */
import "./support/load-env";
import { config } from "@/lib/config";
import { checkGscAccess, gscConfigured, gscSiteBase, inspectUrl, listSitemaps, querySearchConsole, sitemapUrl, submitSitemap } from "@/lib/gsc";

const line = (k: string, v: unknown) => console.log(`${k.padEnd(22)} ${v}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!gscConfigured()) {
    line("status", "BLOCKED_BY_ENVIRONMENT");
    line("missing env", [!config.gsc.siteUrl() && "GSC_SITE_URL", !config.gsc.serviceAccountJson() && "GSC_SERVICE_ACCOUNT_JSON"].filter(Boolean).join(", "));
    return 2;
  }
  let failed = false;
  const access = await checkGscAccess();
  if (access.ok) line("property access", `ok (${access.siteUrl}, permission ${access.permissionLevel})`);
  else {
    line("property access", `FAIL: ${access.reason}`);
    return 1;
  }
  const sm = sitemapUrl();
  try {
    const maps = await listSitemaps();
    const mine = maps.find((m) => m.path === sm);
    line("sitemaps listed", maps.length);
    line("site sitemap", mine ? `submitted ${mine.lastSubmitted ?? "?"}, indexed ${mine.indexed ?? "?"} of ${mine.submitted ?? "?"}, errors ${mine.errors ?? 0}` : `${sm} not submitted yet`);
  } catch (e) {
    line("sitemaps", `FAIL: ${msg(e)}`);
    failed = true;
  }
  if (argv.includes("--submit-sitemap")) {
    const r = await submitSitemap(sm).catch((e) => ({ ok: false as const, httpStatus: 0, reason: msg(e) }));
    line("sitemap submit", r.ok ? `ok (${sm})` : `FAIL: ${r.reason}`);
    failed ||= !r.ok;
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  try {
    const q = await querySearchConsole(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    line("search analytics", `ok ${q.startDate}..${q.endDate}: ${Math.round(q.clicks)} clicks, ${Math.round(q.impressions)} impressions, ${q.rows.length} day rows`);
  } catch (e) {
    line("search analytics", `FAIL: ${msg(e)}`);
    failed = true;
  }
  try {
    const home = `${gscSiteBase()}/`;
    const r = await inspectUrl(home);
    line("url inspection", `ok (home page: ${r.verdict}${r.coverageState ? `, ${r.coverageState}` : ""})`);
  } catch (e) {
    line("url inspection", `FAIL: ${msg(e)}`);
    failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("verify-gsc.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-gsc failed:", msg(error));
      process.exit(1);
    });
}
