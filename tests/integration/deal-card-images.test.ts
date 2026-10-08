import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Outside Next: the data cache is a pass-through, revalidation a no-op, no router.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/deals",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { REPRESENTATIVE_CAPTION } from "@/lib/images/provenance";
import { loadDealCardImages, runDealCardImages } from "@/lib/images/deal-card-images";
import { runImageIntegrity } from "@/lib/images/integrity";
import { loadImageSlotCounts } from "@/lib/images/slot-counts";
import { loadOfficialDeals } from "@/lib/public/deals";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const { default: DealsPage } = await import("@/app/deals/page");

/**
 * Deal / price card images (SAMPLE data, local Pexels stub): every live card gets an image by the
 * priority chain, the deal-images job attaches a labelled product-type photo with provenance, and the
 * image-integrity job repairs a broken or mismatched one. Admin → Images counts the same buckets.
 */

const HOUR = 3_600_000;
const SITE = "https://frame.work";
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({
    PEXELS_API_KEY: "test-pexels-key",
    PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`,
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    IMAGE_ENRICHMENT_URL: undefined,
    COMMERCE_COUPON_MAX_AGE_DAYS: undefined,
    PRODUCT_PRICE_MAX_AGE_HOURS: undefined,
    AFFILIATE_PROVIDER: undefined,
    SITE_URL: "https://www.made4buyers.com",
  });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  stub.pexels.broken = false;
  stub.pexels.rateLimited = false;
});

async function seedDrop(name: string, slug: string, opts: { data?: Record<string, unknown>; categories?: string[] } = {}) {
  const brand = (await db.commerceBrand.findUnique({ where: { slug: "framework" } })) ?? (await db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: "frame.work", categories: opts.categories ?? ["laptops"] } }));
  const url = `${SITE}/products/${slug}`;
  const offers = [{ type: "Offer", price: 799, listPrice: 999, listPriceType: "ListPrice", priceCurrency: "USD", availability: "InStock", url }];
  const product = await db.commerceProduct.create({ data: { canonicalUrl: url, name, sku: slug, model: slug, brandId: brand.id, identityStatus: "UNMATCHED", observedAt: new Date(), data: { pageUrl: url, offers, ...(opts.data ?? {}) } } });
  await db.commerceOffer.create({ data: { productId: product.id, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: url, price: 799, listPrice: 999, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK", linkCheckedAt: new Date(Date.now() - HOUR) } });
  return product;
}

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}

describe("deal-images job", () => {
  it("attaches a labelled product-type photo with provenance to a card with no exact photo; idempotent", async () => {
    const p = await seedDrop("Framework Laptop 13", "fw13");
    // Before: the category image (never empty).
    expect((await loadDealCardImages([p.id])).get(p.id)).toMatchObject({ kind: "category", src: "/placeholders/laptops.svg", exact: false });

    const r = await runDealCardImages("test");
    expect(r).toMatchObject({ status: "OK", live: 1, needed: 1, attached: 1 });
    const data = (await db.commerceProduct.findUniqueOrThrow({ where: { id: p.id } })).data as { cardImage: Record<string, unknown> };
    expect(data.cardImage).toMatchObject({ v: 1, kind: "illustrative", source: "pexels", sourceType: "ENRICHMENT_SERVICE", productId: p.id, topicKey: "product-type:laptop", imageType: "illustrative-product-type", basis: "name" });
    expect(data.cardImage.query).toMatch(/laptop/);
    expect(data.cardImage.sourceUrl).toMatch(/^https:\/\/www\.pexels\.com\//);
    expect(String(data.cardImage.alt)).toMatch(/laptop/i);
    for (const k of ["src", "photoId", "observedAt", "confidence", "attribution", "license"]) expect(data.cardImage[k]).toBeTruthy();

    const img = (await loadDealCardImages([p.id])).get(p.id)!;
    expect(img).toMatchObject({ kind: "illustrative", exact: false, caption: REPRESENTATIVE_CAPTION, source: "pexels" });

    // Second run: nothing to do (no new search).
    const again = await runDealCardImages("test");
    expect(again).toMatchObject({ needed: 0, attached: 0, alreadyIllustrative: 1, requests: 0 });
  });

  it("never guesses: a product whose page states no type keeps the category image; a Pexels rate limit stops the batch", async () => {
    const odd = await seedDrop("Zx-9", "zx9", { categories: ["laptops", "accessories"] });
    expect(await runDealCardImages("test")).toMatchObject({ needed: 1, attached: 0, noTopic: 1 });
    expect((await loadDealCardImages([odd.id])).get(odd.id)?.kind).toBe("category");

    await seedDrop("Framework Laptop 16", "fw16");
    stub.pexels.rateLimited = true;
    expect((await runDealCardImages("test")).status).toBe("RATE_LIMITED");
  });

  it("an exact official photo wins over everything: no stock search for it", async () => {
    const brand = await db.commerceBrand.create({ data: { name: "Samsung", slug: "samsung", officialDomain: "samsung.com", categories: ["phones"] } });
    const url = "https://www.samsung.com/us/smartphones/galaxy-s26-ultra/buy/";
    const p = await db.commerceProduct.create({ data: { canonicalUrl: url, name: "Galaxy S26 Ultra", brandId: brand.id, identityStatus: "UNMATCHED", observedAt: new Date(), data: { pageUrl: url, productImages: [{ src: "https://images.samsung.com/us/s26-ultra.jpg", alt: "Galaxy S26 Ultra", source: "json-ld" }] } } });
    await db.commerceOffer.create({ data: { productId: p.id, seller: "Samsung", sellerType: "MANUFACTURER", destinationUrl: url, price: 999, listPrice: 1299, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK" } });
    expect(await runDealCardImages("test")).toMatchObject({ live: 1, exact: 1, needed: 0, requests: 0 });
    expect((await loadDealCardImages([p.id])).get(p.id)).toMatchObject({ kind: "official", exact: true, src: "https://images.samsung.com/us/s26-ultra.jpg", caption: null });
  });
});

describe("image-integrity job: deal cards", () => {
  it("records a broken card photo, falls back at once and repairs it with another labelled photo", async () => {
    const p = await seedDrop("Framework Laptop 13", "fw13");
    await runDealCardImages("test");
    const before = ((await db.commerceProduct.findUniqueOrThrow({ where: { id: p.id } })).data as { cardImage: Record<string, unknown> }).cardImage;
    // The stored photo stops loading.
    const brokenSrc = `${stub.base}/pexels-img/broken.jpeg`;
    const data = (await db.commerceProduct.findUniqueOrThrow({ where: { id: p.id } })).data as Record<string, unknown>;
    await db.commerceProduct.update({ where: { id: p.id }, data: { data: { ...data, cardImage: { ...before, src: brokenSrc } } as Prisma.InputJsonValue } });

    const r = await runImageIntegrity("test", { pauseMs: 0 });
    expect(r.deals).toMatchObject({ live: 1, broken: 1 });
    expect(r.deals?.repair).toMatchObject({ attached: 1 });
    const after = (await db.commerceProduct.findUniqueOrThrow({ where: { id: p.id } })).data as { cardImage: { src: string }; brokenImages: Record<string, string> };
    expect(Object.keys(after.brokenImages)).toEqual([brokenSrc]);
    expect(after.cardImage.src).not.toBe(brokenSrc);
    expect((await loadDealCardImages([p.id])).get(p.id)).toMatchObject({ kind: "illustrative" });

    const counts = await loadImageSlotCounts();
    expect(counts.deals).toMatchObject({ required: 1, pexels: 1, missing: 0, broken: 1, mismatched: 0 });
  });

  it("removes a stored photo chosen for another product (never shown) and repairs the card", async () => {
    const a = await seedDrop("Framework Laptop 13", "fw13");
    await runDealCardImages("test");
    const b = await seedDrop("Framework Laptop 16", "fw16");
    // b's data carries a's photo (copied data): refused at display, removed by the job, replaced by b's own.
    const aCard = ((await db.commerceProduct.findUniqueOrThrow({ where: { id: a.id } })).data as { cardImage: Record<string, unknown> }).cardImage;
    const bData = (await db.commerceProduct.findUniqueOrThrow({ where: { id: b.id } })).data as Record<string, unknown>;
    await db.commerceProduct.update({ where: { id: b.id }, data: { data: { ...bData, cardImage: aCard } as Prisma.InputJsonValue } });
    expect((await loadDealCardImages([b.id])).get(b.id)?.kind).toBe("category");
    expect((await loadImageSlotCounts()).deals.mismatched).toBe(1);

    const r = await runImageIntegrity("test", { pauseMs: 0 });
    expect(r.deals?.mismatched).toBe(1);
    const bCard = ((await db.commerceProduct.findUniqueOrThrow({ where: { id: b.id } })).data as { cardImage: { productId: string } }).cardImage;
    expect(bCard.productId).toBe(b.id);
    expect((await loadImageSlotCounts()).deals).toMatchObject({ mismatched: 0, pexels: 2, categoryFallback: 0 });
  });
});

describe("/deals render: no empty image slot", () => {
  it("every price-drop card has an image; illustrative ones carry the visible label", async () => {
    // A brand with several categories: a product whose page states no type keeps the category image.
    await seedDrop("Zx-9", "zx9", { categories: ["laptops", "accessories"] });
    await seedDrop("Framework Laptop 13", "fw13");
    await runDealCardImages("test");
    const deals = await loadOfficialDeals();
    expect(deals.drops).toHaveLength(2);
    expect(deals.drops.every((d) => d.image && d.image.src)).toBe(true);
    const markup = await html(DealsPage());
    const cards = markup.match(/<article class="deal-card[\s\S]*?<\/article>/g) ?? [];
    expect(cards.length).toBe(2);
    for (const c of cards) {
      expect(c).not.toMatch(/no-media/);
      expect(c).toMatch(/<img[^>]+data-image-kind="(official|retailer|internal|illustrative|category)"/);
    }
    const illus = cards.filter((c) => /data-image-kind="illustrative"/.test(c));
    expect(illus).toHaveLength(1);
    expect(illus[0]).toContain(REPRESENTATIVE_CAPTION);
    // The category-image card is not labelled illustrative (it names the category, shows no product).
    expect(cards.find((c) => /data-image-kind="category"/.test(c))).not.toContain(REPRESENTATIVE_CAPTION);
  });
});
