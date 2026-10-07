/**
 * Affiliate provider check. Prints configuration (env var NAMES only) and, for each --url given,
 * whether the configured provider wraps it: status + the generated link's host only.
 *
 *   AFFILIATE_PROVIDER=amazon AMAZON_ASSOCIATES_TAG=... npx tsx scripts/verify-affiliate.ts --url https://www.amazon.com/dp/<ASIN>
 *   AFFILIATE_PROVIDER=skimlinks ... npx tsx scripts/verify-affiliate.ts --url https://www.bestbuy.com/site/...
 *
 * Use real product URLs you have; the script never invents one. Skimlinks/Impact calls use the
 * credentials from the environment. Exit 0 = provider active and every URL got an answer.
 */
import "./support/load-env";
import { affiliateConfigIssues, getAffiliateProvider, safeWrap, selectedProviderNames } from "@/lib/affiliate/provider";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const line = (k: string, v: unknown) => console.log(`${k.padEnd(22)} ${v}`);
  const provider = getAffiliateProvider();
  const issues = affiliateConfigIssues();
  line("AFFILIATE_PROVIDER", selectedProviderNames().join(","));
  line("active", provider.active ? `yes (${provider.name})` : "no: links stay plain");
  if (issues.unknown.length) line("unknown providers", issues.unknown.join(", "));
  if (issues.missingEnv.length) line("missing/invalid env", issues.missingEnv.join(", "));
  if (!provider.active) return 2;
  const urls = argv.flatMap((a, i) => (argv[i - 1] === "--url" ? [a] : []));
  let failed = false;
  for (const url of urls) {
    const r = await safeWrap(provider, url);
    if (r.status === "AFFILIATED") line(`url ${urls.indexOf(url) + 1}`, `AFFILIATED via ${r.provider} → ${new URL(r.affiliateUrl).host}`);
    else {
      line(`url ${urls.indexOf(url) + 1}`, `${r.status}: ${r.reason}`);
      failed ||= r.status === "UNAVAILABLE";
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("verify-affiliate.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-affiliate failed:", (error as Error).message.slice(0, 200));
      process.exit(1);
    });
}
