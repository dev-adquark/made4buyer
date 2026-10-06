import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createBrand, crawlBrandNow, dueBrands, importSeedBrands, inCrawlWindow, listBrands, parseBrandForm, readBrandSeed, seedWindow, toggleBrand, updateBrand, validateBrandInput, type BrandSeed } from "@/lib/commerce/brands";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE brands for ordering/validation tests; the real seed is data/commerce/brands.seed.json.
const sample = (slug: string, over: Record<string, unknown> = {}) => ({ name: slug.toUpperCase(), slug, officialDomain: `www.${slug}.example.com`, categories: ["laptops"], ...over });

beforeEach(async () => {
  await resetDb();
});

describe("seed import", () => {
  it("creates every seed brand once and is idempotent", async () => {
    const first = await importSeedBrands();
    expect(first).toMatchObject({ created: 100, filled: 0, unchanged: 0, invalid: [], total: 100 });
    expect(await db.commerceBrand.count()).toBe(100);
    const second = await importSeedBrands();
    expect(second).toMatchObject({ created: 0, filled: 0, unchanged: 100, invalid: [] });
    expect(await db.commerceBrand.count()).toBe(100);
  });

  it("never overwrites admin edits; only fills empty lists", async () => {
    const seed: BrandSeed[] = [
      { name: "Sample Brand", slug: "sample-brand", officialDomain: "www.sample-brand.example.com", market: "US", categories: ["audio"], discoveryUrls: ["https://www.sample-brand.example.com/sitemap.xml"], productUrlPatterns: [], promoUrls: ["https://www.sample-brand.example.com/deals"], notes: "seed note" },
    ];
    await importSeedBrands(seed);
    const b = await db.commerceBrand.findUniqueOrThrow({ where: { slug: "sample-brand" } });
    await db.commerceBrand.update({
      where: { id: b.id },
      data: { name: "Edited Name", enabled: false, priority: 7, maxProductsPerRun: 50, notes: "admin note", discoveryUrls: ["https://www.sample-brand.example.com/custom.xml"], promoUrls: [], categories: [] },
    });
    const r = await importSeedBrands([{ ...seed[0], name: "Seed Rename", productUrlPatterns: ["https://www.sample-brand.example.com/p/*"] }]);
    expect(r).toMatchObject({ created: 0, filled: 1 });
    const after = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ name: "Edited Name", enabled: false, priority: 7, maxProductsPerRun: 50, notes: "admin note" });
    expect(after.discoveryUrls).toEqual(["https://www.sample-brand.example.com/custom.xml"]);
    expect(after.promoUrls).toEqual(["https://www.sample-brand.example.com/deals"]);
    expect(after.categories).toEqual(["audio"]);
    expect(after.productUrlPatterns).toEqual(["https://www.sample-brand.example.com/p/*"]);
  });

  it("does not fill seed URLs onto a brand whose domain an admin changed", async () => {
    const seed = readBrandSeed().filter((s) => s.slug === "apple");
    await importSeedBrands(seed);
    await db.commerceBrand.update({ where: { slug: "apple" }, data: { officialDomain: "www.other.example.com", discoveryUrls: [] } });
    const r = await importSeedBrands(seed);
    expect(r.unchanged).toBe(1);
    expect((await db.commerceBrand.findUniqueOrThrow({ where: { slug: "apple" } })).discoveryUrls).toEqual([]);
  });

  it("reports invalid seed entries instead of importing them", async () => {
    const r = await importSeedBrands([{ ...sample("bad-one"), market: "US", categories: ["not-a-category"], discoveryUrls: [], productUrlPatterns: [], promoUrls: [] }]);
    expect(r.created).toBe(0);
    expect(r.invalid[0]).toMatchObject({ slug: "bad-one" });
  });
});

describe("dueBrands", () => {
  it("returns enabled brands that are due: priority desc, then nextCrawlAt asc with never-scheduled first; skips backoff and disabled", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
    await db.commerceBrand.createMany({
      data: [
        { ...sample("low-null"), priority: 10, nextCrawlAt: null },
        { ...sample("high-old"), priority: 200, nextCrawlAt: h(-48) },
        { ...sample("high-null"), priority: 200, nextCrawlAt: null },
        { ...sample("high-recent"), priority: 200, nextCrawlAt: h(-1) },
        { ...sample("mid-now"), priority: 100, nextCrawlAt: now },
        { ...sample("backoff"), priority: 999, nextCrawlAt: h(6), consecutiveFailures: 3 },
        { ...sample("disabled"), priority: 999, enabled: false, nextCrawlAt: null },
      ],
    });
    const due = await dueBrands(now, 10);
    expect(due.map((b) => b.slug)).toEqual(["high-null", "high-old", "high-recent", "mid-now", "low-null"]);
    expect((await dueBrands(now, 2)).map((b) => b.slug)).toEqual(["high-null", "high-old"]);
    // Once the backoff has passed the brand is due again.
    expect((await dueBrands(h(7), 1)).map((b) => b.slug)).toEqual(["backoff"]);
  });

  it("crawl-now makes a brand due immediately; toggle disables it", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const b = await db.commerceBrand.create({ data: { ...sample("later"), nextCrawlAt: new Date("2026-10-20T00:00:00Z") } });
    expect(await dueBrands(now, 5)).toHaveLength(0);
    await crawlBrandNow(b.id, now);
    expect((await dueBrands(now, 5)).map((x) => x.slug)).toEqual(["later"]);
    await toggleBrand(b.id);
    expect(await dueBrands(now, 5)).toHaveLength(0);
  });
});

describe("validation and admin mutations", () => {
  const ok = (over: Record<string, unknown> = {}) => validateBrandInput({ ...sample("valid"), ...over });

  it("accepts a valid brand and normalizes the domain", () => {
    const v = ok({ officialDomain: "https://WWW.Valid.example.com/some/path", discoveryUrls: "https://www.valid.example.com/sitemap.xml\nhttps://sitemaps.valid.example.com/products.xml\n", productUrlPatterns: "https://www.valid.example.com/products/**" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.officialDomain).toBe("www.valid.example.com");
      expect(v.value.discoveryUrls).toHaveLength(2);
      expect(v.value).toMatchObject({ market: "US", enabled: true, priority: 100, crawlFrequencyHours: 24, maxProductsPerRun: 20 });
    }
  });

  it.each([
    [{ officialDomain: "http://www.valid.example.com" }, /https/],
    [{ officialDomain: "localhost" }, /public|valid/],
    [{ officialDomain: "10.1.2.3" }, /public|valid/],
    [{ discoveryUrls: ["http://www.valid.example.com/sitemap.xml"] }, /https/],
    [{ discoveryUrls: ["https://elsewhere.example.org/sitemap.xml"] }, /must be on/],
    [{ promoUrls: ["https://elsewhere.example.org/deals"] }, /must be on/],
    [{ productUrlPatterns: ["https://*.valid.example.com/products/*"] }, /must start with/],
    [{ productUrlPatterns: ["https://elsewhere.example.org/products/*"] }, /must start with/],
    [{ productUrlPatterns: ["https://www.valid.example.com.evil.example/products/*"] }, /must start with/],
    [{ maxProductsPerRun: 0 }, /Products per run/],
    [{ maxProductsPerRun: 101 }, /Products per run/],
    [{ crawlFrequencyHours: 5 }, /Crawl frequency/],
    [{ crawlFrequencyHours: 721 }, /Crawl frequency/],
    [{ crawlFrequencyHours: "12.5" }, /Crawl frequency/],
    [{ categories: ["nope"] }, /Unknown category/],
    [{ categories: [] }, /at least one category/],
    [{ slug: "Bad Slug" }, /Slug/],
    [{ market: "USA" }, /Market/],
  ])("rejects %o", (over, msg) => {
    // The suite allows loopback hosts for its stub servers; production never does.
    const restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "false" });
    const v = ok(over);
    restore();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(msg);
  });

  it("accepts the limit boundaries", () => {
    expect(ok({ maxProductsPerRun: 1, crawlFrequencyHours: 6 }).ok).toBe(true);
    expect(ok({ maxProductsPerRun: 100, crawlFrequencyHours: 720 }).ok).toBe(true);
  });

  it("parses the admin form (textareas one per line, checkbox) and enforces unique slugs", async () => {
    const form: Record<string, string> = { name: "Form Brand", slug: "form-brand", officialDomain: "www.form-brand.example.com", market: "us", categories: "audio\nlaptops", discoveryUrls: "", productUrlPatterns: "", promoUrls: "", priority: "150", crawlFrequencyHours: "48", maxProductsPerRun: "30", notes: "", enabledPresent: "1" };
    const v = parseBrandForm((n) => form[n] ?? "");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toMatchObject({ market: "US", categories: ["audio", "laptops"], enabled: false, priority: 150 });
    const created = await createBrand(v.value);
    expect(created.ok).toBe(true);
    expect((await createBrand(v.value)).ok).toBe(false);
    expect((await listBrands({ category: "audio", q: "form" })).map((b) => b.slug)).toEqual(["form-brand"]);
    expect(await listBrands({ enabled: true })).toHaveLength(0);
  });

  it("update resets the robots check when the domain changes", async () => {
    const b = await db.commerceBrand.create({ data: { ...sample("moving"), robotsStatus: "ALLOWED", robotsCheckedAt: new Date() } });
    const v = validateBrandInput({ ...sample("moving"), officialDomain: "www.moved.example.com" });
    if (!v.ok) throw new Error(v.error);
    const r = await updateBrand(b.id, v.value);
    expect(r.ok && r.after).toMatchObject({ officialDomain: "www.moved.example.com", robotsStatus: null, robotsCheckedAt: null });
  });
});

describe("crawl windows and staggering", () => {
  it("seed import staggers brands deterministically across the day in 2-hour windows", async () => {
    await importSeedBrands();
    const brands = await db.commerceBrand.findMany({ select: { slug: true, crawlWindowStartHour: true, crawlWindowHours: true } });
    expect(brands.every((b) => b.crawlWindowHours === 2 && b.crawlWindowStartHour !== null && b.crawlWindowStartHour % 2 === 0 && b.crawlWindowStartHour <= 22)).toBe(true);
    for (const b of brands) expect(b.crawlWindowStartHour).toBe(seedWindow(b.slug).crawlWindowStartHour);
    // Spread over (nearly) every window of the day, none holding a large share of the 100 brands.
    const perWindow = new Map<number, number>();
    for (const b of brands) perWindow.set(b.crawlWindowStartHour!, (perWindow.get(b.crawlWindowStartHour!) ?? 0) + 1);
    expect(perWindow.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...perWindow.values())).toBeLessThanOrEqual(20);
  });

  it("assigns a window only when none is set: an admin's window is never overwritten", async () => {
    const seed = readBrandSeed().filter((s) => s.slug === "apple");
    await importSeedBrands(seed);
    await db.commerceBrand.update({ where: { slug: "apple" }, data: { crawlWindowStartHour: 5, crawlWindowHours: 3, timezone: "Europe/London" } });
    await importSeedBrands(seed);
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "apple" } })).toMatchObject({ crawlWindowStartHour: 5, crawlWindowHours: 3, timezone: "Europe/London" });
    // A brand from before windows existed (null start) gets the staggered window on the next import.
    await db.commerceBrand.update({ where: { slug: "apple" }, data: { crawlWindowStartHour: null, crawlWindowHours: 24 } });
    const r = await importSeedBrands(seed);
    expect(r.filled).toBe(1);
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "apple" } })).toMatchObject(seedWindow("apple"));
    // An admin's "any time" (blank start) is stored as the full-day window, so the seed leaves it alone.
    const b = await db.commerceBrand.findUniqueOrThrow({ where: { slug: "apple" } });
    const v = validateBrandInput({ crawlWindowStartHour: "" }, { ...b, notes: b.notes });
    if (!v.ok) throw new Error(v.error);
    await updateBrand(b.id, v.value);
    await importSeedBrands(seed);
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "apple" } })).toMatchObject({ crawlWindowStartHour: 0, crawlWindowHours: 24 });
  });

  it("dueBrands respects the window in the brand's time zone and never starves a missed window", async () => {
    // 2026-10-06 12:00 UTC = 08:00 in New York (EDT), 17:30 in Kolkata.
    const now = new Date("2026-10-06T12:00:00Z");
    const recent = new Date(now.getTime() - 2 * 3_600_000);
    await db.commerceBrand.createMany({
      data: [
        { ...sample("ny-in"), crawlWindowStartHour: 7, crawlWindowHours: 2, timezone: "America/New_York", nextCrawlAt: recent },
        { ...sample("ny-out"), crawlWindowStartHour: 14, crawlWindowHours: 2, timezone: "America/New_York", nextCrawlAt: recent },
        { ...sample("in-in"), crawlWindowStartHour: 16, crawlWindowHours: 2, timezone: "Asia/Kolkata", nextCrawlAt: recent },
        { ...sample("wrap"), crawlWindowStartHour: 23, crawlWindowHours: 10, timezone: "America/New_York", nextCrawlAt: recent },
        { ...sample("any"), crawlWindowStartHour: null, nextCrawlAt: recent },
        // Due for 30 h with a 24 h frequency: its window was missed, so it is crawled anyway.
        { ...sample("starved"), crawlWindowStartHour: 20, crawlWindowHours: 2, timezone: "America/New_York", crawlFrequencyHours: 24, nextCrawlAt: new Date(now.getTime() - 30 * 3_600_000) },
      ],
    });
    const due = (await dueBrands(now, 10)).map((b) => b.slug).sort();
    expect(due).toEqual(["any", "in-in", "ny-in", "starved", "wrap"]);
    expect(inCrawlWindow({ crawlWindowStartHour: 14, crawlWindowHours: 2, timezone: "America/New_York" }, new Date("2026-10-06T18:30:00Z"))).toBe(true);
    // The limit applies after the window filter.
    expect(await dueBrands(now, 2)).toHaveLength(2);
  });

  it("validates time zone, window hours and the official store URL", () => {
    const restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "false" });
    try {
      const v = (over: Record<string, unknown>) => validateBrandInput({ ...sample("valid"), ...over });
      const good = v({ crawlWindowStartHour: "6", crawlWindowHours: "2", timezone: "Asia/Kolkata", officialStoreUrl: "https://store.valid.example.com/shop" });
      expect(good).toMatchObject({ ok: true, value: { crawlWindowStartHour: 6, crawlWindowHours: 2, timezone: "Asia/Kolkata", officialStoreUrl: "https://store.valid.example.com/shop" } });
      expect(v({})).toMatchObject({ ok: true, value: { crawlWindowStartHour: null, crawlWindowHours: 24, timezone: "America/New_York", officialStoreUrl: null } });
      for (const [over, msg] of [
        [{ timezone: "Mars/Olympus" }, /Time zone/],
        [{ timezone: "+05:30" }, /Time zone/],
        [{ crawlWindowStartHour: "24" }, /window start/],
        [{ crawlWindowStartHour: "-1" }, /window start/],
        [{ crawlWindowHours: "0" }, /window length/],
        [{ crawlWindowHours: "25" }, /window length/],
        [{ officialStoreUrl: "http://www.valid.example.com/shop" }, /https/],
        [{ officialStoreUrl: "https://elsewhere.example.org/shop" }, /must be on/],
      ] as const) {
        const r = v(over);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(msg);
      }
    } finally {
      restore();
    }
  });
});
