import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const { CouponsView, COUPONS_PER_PAGE } = await import("@/app/coupons/coupons-view");
const { default: DealsPage } = await import("@/app/deals/page");

/**
 * /coupons (60 per page) and the /deals preview, prerendered from SAMPLE rows: Feedico codes of
 * merchants without a registry brand, plus codes that must never be listed (non-US, expired, future).
 */
const FEED = "https://api.feedico.io/api/v1/catalog/coupons";
let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ FEEDICO_API_BASE_URL: undefined, COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}
const count = (markup: string, re: RegExp) => (markup.match(re) ?? []).length;

async function seedFeed(n: number) {
  const now = Date.now();
  await db.commerceCoupon.createMany({
    data: Array.from({ length: n }, (_, i) => ({ brandId: null, merchant: `Shop ${i}`, code: `CODE${1000 + i}`, discount: "10% off", sourceUrl: `${FEED}?merchant=shop${i}.com`, merchantUrl: `https://shop${i}.com`, status: "UNVERIFIED", observedAt: new Date(now - i * 60_000) })),
  });
  const extra = (code: string, over: Record<string, unknown>) => db.commerceCoupon.create({ data: { brandId: null, merchant: "Extra", code, discount: "5% off", sourceUrl: `${FEED}?merchant=extra.com`, merchantUrl: "https://extra.com", status: "UNVERIFIED", observedAt: new Date(now), ...over } });
  await extra("UKSAVE60", { merchant: "Extra UK", merchantUrl: "https://uk.extra.com", sourceUrl: `${FEED}?merchant=uk.extra.com` });
  await extra("ENDED5", { expiresAt: new Date(now - 60_000) });
  await extra("LATER5", { startsAt: new Date(now + 86_400_000) });
  await extra("GOOD5", {});
}

describe("/coupons: every current US coupon, 60 per page", () => {
  it("lists 60 per page, newest first, with working merchant links, Via Feedico labels and pagination", async () => {
    await seedFeed(130);
    const p1 = await html(CouponsView({ state: { page: 1, noindex: false } }));
    expect(COUPONS_PER_PAGE).toBe(60);
    expect(count(p1, /class="coupon-card"/g)).toBe(60);
    expect(p1).toContain("131 current US coupons");
    expect(p1).toContain("Page 1 of 3");
    expect(p1).toContain('href="/coupons?page=2"');
    expect(p1).not.toContain("Previous page");
    expect(count(p1, />Via Feedico</g)).toBe(60);
    expect(p1).toContain('href="https://extra.com/"'); // GOOD5, newest
    // Never listed: another country's storefront, an expired code, a code that has not started.
    const p3 = await html(CouponsView({ state: { page: 3, noindex: true } }));
    expect(count(p3, /class="coupon-card"/g)).toBe(11);
    expect(p3).toContain("Page 3 of 3");
    expect(p3).toContain('href="/coupons?page=2"');
    expect(p3).not.toContain("Next page");
    const all = p1 + (await html(CouponsView({ state: { page: 2, noindex: true } }))) + p3;
    for (const hidden of ["UKSAVE60", "ENDED5", "LATER5"]) expect(all).not.toContain(hidden);
    expect(count(all, /class="coupon-card"/g)).toBe(131);
  });

  it("an empty page says so plainly", async () => {
    const p = await html(CouponsView({ state: { page: 1, noindex: false } }));
    expect(p).toContain("No current coupon right now.");
  });
});

describe("/deals: the newest coupons only, with a link to all of them", () => {
  it("shows 24 coupons and links to /coupons", async () => {
    await seedFeed(40);
    const d = await html(DealsPage());
    const section = d.slice(d.indexOf('<section id="coupons"'), d.indexOf("<section", d.indexOf('<section id="coupons"') + 10));
    expect(count(section, /class="coupon-card"/g)).toBe(24);
    expect(section).toContain('href="/coupons"');
    expect(section).toContain("See all 41 coupons");
  });
});
