import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Outside Next: the data cache is a pass-through (so officialDeals() re-applies its time rules to fresh data) and there is no router.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { GET as getDeals } from "@/app/api/commerce/deals/route";
import VerifiedCoupons from "@/components/verified-coupons";
import { verifiedCouponsFor, verifiedCouponsForBrands } from "@/lib/commerce/coupons";
import { db } from "@/lib/db";
import { loadOfficialDeals, officialDeals } from "@/lib/public/deals";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * The 7-day coupon window end to end, on every public path that reads coupons: a VERIFIED code last
 * seen on the brand's own page 2 days ago is shown; the same kind of code last seen 8 days ago is
 * not — via officialDeals() (/deals, homepage rails, search), the review-page VerifiedCoupons
 * component, and GET /api/commerce/deals.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRESH = "FRESH2DAY";
const OLD = "OLD8DAY";
let restore: () => void;

beforeAll(() => {
  restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: undefined, SITE_URL: "https://www.made4buyers.com" });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function html(el: ReactElement | Promise<ReactElement | null> | null): Promise<string> {
  const node = await el;
  if (!node) return "";
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}

const text = (markup: string) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function seed(now = Date.now()) {
  const brand = await db.commerceBrand.create({ data: { name: "Breville", slug: "breville", officialDomain: "breville.com", categories: ["kitchen-appliances"], promoUrls: ["https://www.breville.com/us/en/offers.html"] } });
  const coupon = (code: string, lastVerifiedAt: Date, over: Record<string, unknown> = {}) =>
    db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Breville", code, discount: `${code === FRESH ? 15 : 20}% off espresso machines`, sourceUrl: `https://www.breville.com/us/en/offers.html?c=${code}`, status: "VERIFIED", observedAt: lastVerifiedAt, lastVerifiedAt, ...over } });
  const fresh = await coupon(FRESH, new Date(now - 2 * DAY));
  const old = await coupon(OLD, new Date(now - 8 * DAY));
  return { brand, fresh, old };
}

describe("coupon window: 2 days old is shown, 8 days old is hidden", () => {
  it("officialDeals() lists only the 2-day-old code", async () => {
    await seed();
    const deals = await officialDeals();
    expect(deals.codes.map((c) => c.code)).toEqual([FRESH]);
    expect(deals.codes[0]).toMatchObject({ brandName: "Breville", brandSlug: "breville", discount: "15% off espresso machines", verifiedVia: "Official brand site", useUrl: `https://www.breville.com/us/en/offers.html?c=${FRESH}` });
    // The uncached loader agrees.
    expect((await loadOfficialDeals()).codes.map((c) => c.code)).toEqual([FRESH]);
  });

  it("officialDeals() re-applies the window to cached data: the 2-day-old code leaves it 5 days later", async () => {
    const now = Date.now();
    await seed(now);
    expect((await officialDeals(now + 5 * DAY - 60_000)).codes.map((c) => c.code)).toEqual([FRESH]);
    expect((await officialDeals(now + 5 * DAY + 60_000)).codes).toEqual([]);
  });

  it("verifiedCouponsFor / verifiedCouponsForBrands (review pages, /deals) return only the 2-day-old code", async () => {
    const { brand } = await seed();
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code)).toEqual([FRESH]);
    expect((await verifiedCouponsFor({ merchant: "Breville" })).map((c) => c.code)).toEqual([FRESH]);
    expect(((await verifiedCouponsForBrands([brand.id])).get(brand.id) ?? []).map((c) => c.code)).toEqual([FRESH]);
  });

  it("the rendered VerifiedCoupons component shows the 2-day-old code and not the 8-day-old one", async () => {
    const { brand } = await seed();
    const markup = await html(VerifiedCoupons({ brandId: brand.id }));
    const t = text(markup);
    expect(t).toContain(FRESH);
    expect(t).not.toContain(OLD);
    expect(t).toContain("15% off espresso machines");
    expect(t).not.toContain("20% off espresso machines");
    expect(t).toMatch(/Verified 2 days ago/);
    expect(t).toContain("Copy code");
    expect(t).toContain("View offer");
    expect(markup).toContain(`href="https://www.breville.com/us/en/offers.html?c=${FRESH}"`);
    expect(markup.match(/<code\b/g)?.length).toBe(1);
  });

  it("VerifiedCoupons renders nothing when the only code is 8 days old", async () => {
    const { brand, fresh } = await seed();
    await db.commerceCoupon.delete({ where: { id: fresh.id } });
    expect(await VerifiedCoupons({ brandId: brand.id })).toBeNull();
  });

  it("GET /api/commerce/deals returns only the 2-day-old code", async () => {
    await seed();
    const res = await getDeals(new Request("http://localhost/api/commerce/deals", { headers: { "x-forwarded-for": "198.51.100.40" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoCodes: Array<{ code: string; lastVerifiedAt: string }> };
    expect(body.promoCodes.map((c) => c.code)).toEqual([FRESH]);
    expect(Date.now() - Date.parse(body.promoCodes[0].lastVerifiedAt)).toBeLessThanOrEqual(7 * DAY);
    expect(JSON.stringify(body)).not.toContain(OLD);
  });

  it("COMMERCE_COUPON_MAX_AGE_DAYS=10 widens every path consistently (both codes listed)", async () => {
    const { brand } = await seed();
    const r = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "10" });
    try {
      expect((await officialDeals()).codes.map((c) => c.code).sort()).toEqual([FRESH, OLD].sort());
      expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code).sort()).toEqual([FRESH, OLD].sort());
      const body = (await (await getDeals(new Request("http://localhost/api/commerce/deals", { headers: { "x-forwarded-for": "198.51.100.41" } }))).json()) as { promoCodes: Array<{ code: string }> };
      expect(body.promoCodes.map((c) => c.code).sort()).toEqual([FRESH, OLD].sort());
    } finally {
      r();
    }
  });
});
