import { describe, expect, it } from "vitest";
import seed from "@/data/commerce/brands.seed.json";
import { onBrandDomain, readBrandSeed, validateBrandInput } from "@/lib/commerce/brands";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

describe("data/commerce/brands.seed.json", () => {
  const brands = readBrandSeed(seed);

  it("has exactly 100 brands with unique slugs and domains", () => {
    expect(brands).toHaveLength(100);
    expect(new Set(brands.map((b) => b.slug)).size).toBe(100);
    expect(new Set(brands.map((b) => b.officialDomain.toLowerCase())).size).toBe(100);
  });

  it("uses only Made4Buyers category slugs and the US market", () => {
    for (const b of brands) {
      expect(b.categories.length, b.slug).toBeGreaterThan(0);
      for (const c of b.categories) expect(CATEGORY_BY_SLUG.has(c), `${b.slug}: ${c}`).toBe(true);
      expect(b.market).toBe("US");
    }
  });

  it("every entry passes admin validation; URLs are https on the brand's own domain", () => {
    for (const b of brands) {
      const v = validateBrandInput(b);
      expect(v.ok ? "ok" : v.error, b.slug).toBe("ok");
      for (const u of [...b.discoveryUrls, ...b.promoUrls]) {
        const url = new URL(u);
        expect(url.protocol, u).toBe("https:");
        expect(onBrandDomain(url, b.officialDomain), u).toBe(true);
      }
      expect(b.discoveryUrls.length).toBeLessThanOrEqual(10);
    }
  });

  it("states no ownership or headquarters", () => {
    for (const b of seed as Array<Record<string, unknown>>) {
      expect(Object.keys(b).sort()).toEqual(["categories", "discoveryUrls", "market", "name", "notes", "officialDomain", "productUrlPatterns", "promoUrls", "slug"]);
      expect(String(b.notes)).not.toMatch(/headquarter|owned by|based in|subsidiary/i);
    }
  });
});
