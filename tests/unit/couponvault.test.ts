import { describe, expect, it } from "vitest";
import { couponVaultSlug, couponVaultUrlFor, parseCouponVaultSitemap } from "@/lib/commerce/couponvault";
import { isCouponVaultCoupon, trustedFeedLabel, trustedFeedMaxAgeDays } from "@/lib/commerce/deal-status";

const SAMPLE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://couponvault.net</loc></url>
<url><loc>https://couponvault.net/stores</loc></url>
<url><loc>https://couponvault.net/software/figma-com</loc></url>
<url><loc>https://couponvault.net/home/eufy-com</loc></url>
<url><loc>https://couponvault.net/electronics/eufy-com</loc></url>
<url><loc>https://couponvault.net/pets/vetsupply-com-au</loc></url>
</urlset>`;

describe("couponVaultSlug", () => {
  it("replaces every dot with a dash and strips www/scheme", () => {
    expect(couponVaultSlug("figma.com")).toBe("figma-com");
    expect(couponVaultSlug("www.Figma.com")).toBe("figma-com");
    expect(couponVaultSlug("https://vetsupply.com.au/")).toBe("vetsupply-com-au");
  });
});

describe("parseCouponVaultSitemap", () => {
  it("maps each listed store's domain slug to its page, keeping the first category seen", () => {
    const map = parseCouponVaultSitemap(SAMPLE_SITEMAP);
    expect(map.get("figma-com")).toBe("https://couponvault.net/software/figma-com");
    expect(map.get("eufy-com")).toBe("https://couponvault.net/home/eufy-com"); // first occurrence, not /electronics/
    expect(map.get("vetsupply-com-au")).toBe("https://couponvault.net/pets/vetsupply-com-au");
    expect(map.has("stores")).toBe(false); // not a /{category}/{domain} store page
  });
});

describe("couponVaultUrlFor", () => {
  it("finds the first of several domain candidates CouponVault lists", () => {
    const map = parseCouponVaultSitemap(SAMPLE_SITEMAP);
    expect(couponVaultUrlFor(map, ["other.example", "figma.com"])).toBe("https://couponvault.net/software/figma-com");
    expect(couponVaultUrlFor(map, ["not-listed.example"])).toBeNull();
  });
});

describe("tier-5 trust generalization (deal-status.ts)", () => {
  it("recognizes a CouponVault source URL and labels it distinctly from Feedico", () => {
    const url = "https://couponvault.net/software/figma-com";
    expect(isCouponVaultCoupon(url)).toBe(true);
    expect(trustedFeedLabel(url)).toBe("CouponVault");
    expect(trustedFeedMaxAgeDays(url)).toBe(10);
    expect(trustedFeedLabel("https://api.feedico.io/api/v1/catalog/coupons?merchant=figma.com")).toBe("Feedico");
  });
});
