import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The page runs outside Next here: the data cache is a pass-through and there is no router.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/deals",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { db } from "@/lib/db";
import { FORBIDDEN_PUBLIC_TOKENS, NO_VERIFIED_OFFER } from "@/lib/public/display";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const { default: DealsPage, generateMetadata } = await import("@/app/deals/page");

/**
 * /deals markup, prerendered like tests/integration/public-integrity.test.ts: the three sections
 * ("Verified price drops", "Latest coupons", "Recently verified") with their jump links and
 * counts, the filter form and the data-* attributes it filters on, and each card's content — and
 * nothing that is not public (an 8-day-old code, a stale or broken offer).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined, AFFILIATE_PROVIDER: undefined, SITE_URL: "https://www.made4buyers.com" });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  // React's text-boundary comments ("<!-- -->") carry no content.
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}

function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The markup of one <section id="…"> (up to the next top-level section). */
function section(markup: string, id: string): string {
  const start = markup.indexOf(`<section id="${id}"`);
  if (start < 0) return "";
  const end = markup.indexOf("<section", start + 10);
  return markup.slice(start, end < 0 ? undefined : end);
}

const SITE = "https://frame.work";

async function seedBrand() {
  return db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: "frame.work", categories: ["laptops"] } });
}

async function product(brandId: string, slug: string, name: string, sku: string, stated: { price: number; listPrice?: number }) {
  const url = `${SITE}/products/${slug}`;
  const offers = [{ type: "Offer", price: stated.price, ...(stated.listPrice ? { listPrice: stated.listPrice, listPriceType: "ListPrice" } : {}), priceCurrency: "USD", availability: "InStock", url }];
  return db.commerceProduct.create({ data: { canonicalUrl: url, name, sku, model: sku, brandId, identityStatus: "UNMATCHED", observedAt: new Date(), data: { pageUrl: url, offers } } });
}

const offer = (productId: string, url: string, over: Record<string, unknown>) =>
  db.commerceOffer.create({ data: { productId, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: url, price: 999, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK", linkCheckedAt: new Date(Date.now() - HOUR), ...over } });

const coupon = (brandId: string, over: Record<string, unknown>) =>
  db.commerceCoupon.create({ data: { brandId, merchant: "Framework", code: "SAVE10", discount: "10% off laptops", sourceUrl: `${SITE}/promotions`, status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(Date.now() - HOUR), ...over } });

/** One price drop, one current price (no stated previous price), one public code — and the rows that must stay hidden. */
async function seedAll() {
  const brand = await seedBrand();
  const drop = await product(brand.id, "laptop12", "Framework Laptop 12", "FRA-L12", { price: 799, listPrice: 999 });
  await offer(drop.id, drop.canonicalUrl, { price: 799, listPrice: 999 });
  const current = await product(brand.id, "laptop16", "Framework Laptop 16", "FRA-L16", { price: 1399 });
  await offer(current.id, current.canonicalUrl, { price: 1399, listPrice: null });
  const stale = await product(brand.id, "desktop", "Framework Desktop", "FRA-DT", { price: 1099, listPrice: 1299 });
  await offer(stale.id, stale.canonicalUrl, { price: 1099, listPrice: 1299, observedAt: new Date(Date.now() - 72 * HOUR) });
  const broken = await product(brand.id, "laptop13", "Framework Laptop 13", "FRA-L13", { price: 899, listPrice: 1049 });
  await offer(broken.id, broken.canonicalUrl, { price: 899, listPrice: 1049, linkStatus: "BROKEN" });
  await coupon(brand.id, { code: "SAVE10", discount: "10% off laptops", eligibility: "New customers only", expiresAt: new Date(Date.now() + 10 * DAY) });
  await coupon(brand.id, { code: "OLDCODE8", discount: "30% off everything", sourceUrl: `${SITE}/old-promo`, lastVerifiedAt: new Date(Date.now() - 8 * DAY), observedAt: new Date(Date.now() - 8 * DAY) });
  return { brand };
}

describe("/deals: three sections and the filters", () => {
  it("renders Verified price drops, Latest coupons and Recently verified, each with its item", async () => {
    await seedAll();
    const markup = await html(DealsPage());
    const text = visibleText(markup);

    // Section headings (each section is labelled by its heading) and the jump links with counts.
    expect(markup).toMatch(/<section id="drops"[^>]*aria-labelledby="drops-title"/);
    expect(markup).toMatch(/<h2 id="drops-title"[^>]*>Verified price drops<\/h2>/);
    expect(markup).toMatch(/<section id="coupons"[^>]*aria-labelledby="codes-title"/);
    expect(markup).toMatch(/<h2 id="codes-title"[^>]*>Latest coupons<\/h2>/);
    expect(markup).toMatch(/<section id="recent"[^>]*aria-labelledby="prices-title"/);
    expect(markup).toMatch(/<h2 id="prices-title"[^>]*>Recently verified<\/h2>/);
    expect(text).toContain("Price drops (1)");
    expect(text).toContain("Coupons (1)");
    expect(text).toContain("Recently verified (1)");
    expect(markup).toContain('href="#drops"');
    expect(markup).toContain('href="#coupons"');
    expect(markup).toContain('href="#recent"');
    expect(text).toContain("verified there within the last 7 days (marked Verified)");

    // Price drop: stated prices, the saving worked out from them, View deal straight to the page.
    const drops = visibleText(section(markup, "drops"));
    expect(drops).toContain("Framework Laptop 12");
    expect(drops).toContain("Current price $799.00");
    expect(drops).toMatch(/Regular price \$999\.00/);
    expect(drops).toContain("You save $200.00 (20%)");
    expect(drops).toContain("View deal");
    expect(section(markup, "drops")).toContain(`href="${SITE}/products/laptop12"`);
    expect(drops).not.toContain("Framework Laptop 16");

    // Coupon: brand, offer as stated, the code with Copy code, Verified <relative>, terms and expiry (stated), View offer.
    const codesHtml = section(markup, "coupons");
    const codes = visibleText(codesHtml);
    expect(codes).toContain("Framework");
    expect(codes).toContain("10% off laptops");
    expect(codesHtml).toMatch(/<code id="code-[^"]+">SAVE10<\/code>/);
    expect(codes).toContain("Copy code");
    expect(codes).toMatch(/✓ Verified 1 hour ago/);
    expect(codes).toContain("Terms New customers only");
    expect(codes).toMatch(/Expires [A-Z][a-z]{2} \d{1,2}, \d{4} \(as stated\)/);
    expect(codes).toContain("View offer");
    expect(codesHtml).toContain(`href="${SITE}/promotions"`);
    expect(codesHtml).toMatch(/rel="nofollow noopener"/);

    // Recently verified: a current price, never presented as a saving.
    const recent = visibleText(section(markup, "recent"));
    expect(recent).toContain("Framework Laptop 16");
    expect(recent).toContain("Current price $1,399.00");
    expect(recent).toContain("No previous price stated: not a discount.");
    expect(recent).not.toContain("You save");
    expect(recent).toContain("View price");

    // Hidden: the 8-day-old code, the stale and the broken offers; no placeholder tokens; no empty state.
    for (const hidden of ["OLDCODE8", "30% off everything", "Framework Desktop", "Framework Laptop 13"]) expect(text).not.toContain(hidden);
    expect(text.match(FORBIDDEN_PUBLIC_TOKENS)?.[0]).toBeUndefined();
    expect(text).not.toContain(NO_VERIFIED_OFFER);

    // Only the price drop carries Offer markup.
    expect(markup.match(/"@type":"Offer"/g)?.length).toBe(1);
  });

  it("renders the filter form with the options the data supports and the data-* attributes it filters on", async () => {
    await seedAll();
    const markup = await html(DealsPage());
    expect(markup).toMatch(/<form[^>]*role="search"[^>]*aria-label="Filter and sort deals"/);
    for (const [id, label] of [
      ["deal-category", "Category"],
      ["deal-brand", "Brand"],
      ["deal-seller", "Seller"],
      ["deal-discount", "Discount"],
      ["deal-verified", "Verified on"],
      ["deal-sort", "Sort"],
    ]) {
      expect(markup, id).toContain(`<label for="${id}">${label}</label>`);
      expect(markup, id).toMatch(new RegExp(`<select id="${id}"`));
    }
    expect(markup).toMatch(/<input id="deal-min"[^>]*type="number"/);
    expect(markup).toMatch(/<input id="deal-max"[^>]*type="number"/);
    expect(markup).toContain("<legend>Price (USD)</legend>");
    // Options from the data, with counts: all three items are Framework laptops on frame.work.
    expect(markup).toContain('<option value="laptops">Laptops (3)</option>');
    expect(markup).toContain('<option value="framework">Framework (3)</option>');
    expect(markup).toContain('<option value="frame.work">Framework (official) (3)</option>');
    expect(markup).toMatch(/role="status"[^>]*aria-live="polite"/);

    // Filter attributes on each item.
    const item = (id: string) => section(markup, id).match(/<li [^>]*data-deal=""[^>]*>/)?.[0] ?? "";
    expect(item("drops")).toContain('data-categories="laptops"');
    expect(item("drops")).toContain('data-brand="framework"');
    expect(item("drops")).toContain('data-seller="frame.work"');
    expect(item("drops")).toContain('data-kind="official"');
    expect(item("drops")).toContain('data-saving-pct="20"');
    expect(item("drops")).toContain('data-saving="200"');
    expect(item("drops")).toContain('data-price="799"');
    expect(item("drops")).toMatch(/data-checked="\d{13}"/);
    expect(item("coupons")).toContain('data-saving-pct="10"');
    expect(item("coupons")).toContain('data-price=""');
    expect(item("recent")).toContain('data-price="1399"');
    expect(item("recent")).toContain('data-saving-pct=""');
    // Each section has its (hidden) "nothing matches these filters" note for the client filter.
    expect(markup.match(/data-deal-empty=""[^>]*hidden/g)?.length).toBe(3);
  });

  it("only a public code: the coupon section lists it; price drops say none; still indexable", async () => {
    const brand = await seedBrand();
    await coupon(brand.id, {});
    const markup = await html(DealsPage());
    const text = visibleText(markup);
    expect(text).toContain("Coupons (1)");
    expect(text).toContain("Price drops (0)");
    expect(text).toContain("No verified price drop right now.");
    expect(text).toContain("No other recently checked price right now.");
    expect(visibleText(section(markup, "coupons"))).toContain("SAVE10");
    expect((await generateMetadata()).robots).toBeUndefined();
  });

  it("only an 8-day-old code: the empty state, no sections, no filters, noindex", async () => {
    const brand = await seedBrand();
    await coupon(brand.id, { lastVerifiedAt: new Date(Date.now() - 8 * DAY), observedAt: new Date(Date.now() - 8 * DAY) });
    const markup = await html(DealsPage());
    const text = visibleText(markup);
    expect(text).toContain(NO_VERIFIED_OFFER);
    expect(text).not.toContain("SAVE10");
    expect(markup).not.toContain('id="coupons"');
    expect(markup).not.toContain('id="drops"');
    expect(markup).not.toContain("Filter and sort deals");
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });
});
