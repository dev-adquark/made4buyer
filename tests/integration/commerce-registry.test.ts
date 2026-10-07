import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrand, importSeedBrands, normalizeCurrency, parseBrandForm, slugFromName, trackingParam, updateBrand, validateBrandInput, type BrandSeed } from "@/lib/commerce/brands";
import { db } from "@/lib/db";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Source registry validation (lib/commerce/brands.ts): deal URLs, product URLs and currency, and the
 * SSRF rules every registry URL obeys — https only, a public host on the brand's own official domain
 * (or a subdomain), no IP literal, no localhost / internal name, no port, no tracking parameters.
 */

const D = "www.acme-audio.com";
const base = (over: Record<string, unknown> = {}) => ({ name: "Acme Audio", slug: "acme-audio", officialDomain: D, categories: ["audio"], ...over });

let restore: () => void;
beforeEach(async () => {
  await resetDb();
  // The suite normally allows loopback hosts for its stub servers; production never does.
  restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "false" });
});
afterEach(() => restore());

describe("deal URLs, product URLs and currency", () => {
  it("accepts https URLs on the official domain and its subdomains, one per line, deduplicated; currency defaults to USD", () => {
    const v = validateBrandInput(
      base({
        dealUrls: "https://www.acme-audio.com/sale\nhttps://shop.acme-audio.com/deals?category=headphones\n\nhttps://www.acme-audio.com/sale\n",
        productUrls: ["https://www.acme-audio.com/products/a1", "https://acme-audio.com/products/a2"],
      }),
    );
    expect(v.ok ? "ok" : v.error).toBe("ok");
    if (!v.ok) return;
    expect(v.value.dealUrls).toEqual(["https://www.acme-audio.com/sale", "https://shop.acme-audio.com/deals?category=headphones"]);
    expect(v.value.productUrls).toHaveLength(2);
    expect(v.value.currency).toBe("USD");
  });

  it("normalizes and validates the ISO 4217 currency", () => {
    expect(validateBrandInput(base({ currency: "eur" }))).toMatchObject({ ok: true, value: { currency: "EUR" } });
    expect(normalizeCurrency("")).toEqual({ ok: true, value: "USD" });
    for (const bad of ["US", "DOLLARS", "$", "U5D", "XYZ"]) {
      const v = validateBrandInput(base({ currency: bad }));
      expect(v.ok, bad).toBe(false);
      if (!v.ok) expect(v.error).toMatch(/Currency/);
    }
  });

  it("allows at most 50 deal URLs and 50 product URLs", () => {
    const urls = (n: number, path: string) => Array.from({ length: n }, (_, i) => `https://www.acme-audio.com/${path}/${i}`);
    expect(validateBrandInput(base({ dealUrls: urls(50, "sale"), productUrls: urls(50, "p") })).ok).toBe(true);
    const deals = validateBrandInput(base({ dealUrls: urls(51, "sale") }));
    expect(deals.ok ? "ok" : deals.error).toMatch(/Deal URLs: at most 50/);
    const products = validateBrandInput(base({ productUrls: urls(51, "p") }));
    expect(products.ok ? "ok" : products.error).toMatch(/Product URLs: at most 50/);
  });

  it.each([
    ["http (not https)", { dealUrls: ["http://www.acme-audio.com/sale"] }, /https/],
    ["another domain", { dealUrls: ["https://www.bestbuy.com/acme"] }, /must be on www\.acme-audio\.com/],
    ["a look-alike domain", { productUrls: ["https://www.acme-audio.com.evil.example/p/1"] }, /must be on/],
    ["a suffix-only look-alike", { productUrls: ["https://notacme-audio.com/p/1"] }, /must be on/],
    ["a public IPv4 host", { dealUrls: ["https://93.184.216.34/sale"] }, /public|IP address|must be on/],
    ["a private IPv4 host", { dealUrls: ["https://10.0.0.5/sale"] }, /public/],
    ["the metadata IP", { productUrls: ["https://169.254.169.254/latest/meta-data"] }, /public/],
    ["an IPv6 host", { productUrls: ["https://[::1]/p"] }, /public/],
    ["a decimal IP host", { productUrls: ["https://2130706433/p"] }, /public/],
    ["localhost", { dealUrls: ["https://localhost/sale"] }, /public/],
    ["an internal name", { dealUrls: ["https://acme-audio.internal/sale"] }, /public|must be on/],
    ["a non-standard port", { dealUrls: ["https://www.acme-audio.com:8443/sale"] }, /port/],
    ["port 8080", { productUrls: ["https://www.acme-audio.com:8080/p/1"] }, /port|https/],
    ["credentials in the URL", { productUrls: ["https://user:pass@www.acme-audio.com/p/1"] }, /public/],
    ["a javascript: URL", { productUrls: ["javascript:alert(1)"] }, /https/],
    ["utm tracking", { dealUrls: ["https://www.acme-audio.com/sale?utm_source=newsletter"] }, /tracking parameters \(utm_source\)/],
    ["a click id", { productUrls: ["https://www.acme-audio.com/p/1?gclid=abc"] }, /tracking parameters \(gclid\)/],
    ["an affiliate click id", { dealUrls: ["https://www.acme-audio.com/sale?irclickid=x1"] }, /tracking parameters/],
    ["tracking on promo URLs too", { promoUrls: ["https://www.acme-audio.com/offers?fbclid=1"] }, /Promo URLs must not carry tracking/],
    ["tracking on discovery URLs too", { discoveryUrls: ["https://www.acme-audio.com/sitemap.xml?utm_medium=x"] }, /Discovery URLs must not carry tracking/],
    ["an IP official store URL", { officialStoreUrl: "https://10.1.1.1/shop" }, /public/],
    ["a tracked official store URL", { officialStoreUrl: "https://www.acme-audio.com/shop?utm_campaign=x" }, /tracking/],
    ["a product pattern off the domain", { productUrlPatterns: ["https://*.acme-audio.com/products/*"] }, /must start with/],
  ])("rejects %s", (_label, over, msg) => {
    const v = validateBrandInput(base(over));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(msg);
  });

  it("keeps legitimate query strings that are not tracking parameters", () => {
    const u = new URL("https://www.acme-audio.com/deals?category=audio&sort=price&page=2");
    expect(trackingParam(u)).toBeNull();
    expect(trackingParam(new URL("https://www.acme-audio.com/deals?UTM_Source=x"))).toBe("UTM_Source");
  });
});

describe("official domain: a public host name (syntactic and public-suffix checks, no network)", () => {
  it.each([
    ["an IP address", "93.184.216.34"],
    ["a private IP", "192.168.1.10"],
    ["localhost", "localhost"],
    ["a reserved .test TLD", "shop.acme.test"],
    ["a reserved .local name", "acme.local"],
    ["an .internal name", "shop.acme.internal"],
    ["a single label", "intranet"],
    ["a bare public suffix", "co.uk"],
    ["a hosting public suffix", "github.io"],
    ["a port", "www.acme-audio.com:8443"],
    ["http", "http://www.acme-audio.com"],
  ])("rejects %s", (_label, officialDomain) => {
    const v = validateBrandInput(base({ officialDomain }));
    expect(v.ok, officialDomain).toBe(false);
  });

  it("accepts registrable names, including below a multi-label suffix", () => {
    for (const d of ["acme-audio.com", "www.acme-audio.co.uk", "shop.acme.github.io", "https://www.acme-audio.com/"]) {
      expect(validateBrandInput(base({ officialDomain: d, dealUrls: [] })).ok, d).toBe(true);
    }
  });
});

describe("admin form and persistence", () => {
  it("parses the registry form (textareas, currency) and stores the new fields", async () => {
    const form: Record<string, string> = {
      name: "Acme Audio",
      slug: "",
      officialDomain: D,
      categories: "audio",
      currency: "usd",
      dealUrls: "https://www.acme-audio.com/sale\r\nhttps://www.acme-audio.com/outlet",
      productUrls: "https://www.acme-audio.com/products/a1",
      enabledPresent: "1",
    };
    // The "Add brand" route derives a blank slug from the name.
    const v = parseBrandForm((n) => (n === "slug" && !form.slug ? slugFromName(form.name) : (form[n] ?? "")));
    expect(v.ok ? "ok" : v.error).toBe("ok");
    if (!v.ok) return;
    expect(v.value).toMatchObject({ slug: "acme-audio", currency: "USD", enabled: false, dealUrls: ["https://www.acme-audio.com/sale", "https://www.acme-audio.com/outlet"], productUrls: ["https://www.acme-audio.com/products/a1"] });
    const created = await createBrand(v.value);
    expect(created.ok).toBe(true);
    const stored = await db.commerceBrand.findUniqueOrThrow({ where: { slug: "acme-audio" } });
    expect(stored).toMatchObject({ currency: "USD", dealUrls: ["https://www.acme-audio.com/sale", "https://www.acme-audio.com/outlet"], productUrls: ["https://www.acme-audio.com/products/a1"] });

    // An edit keeps the lists unless the form changes them, and re-validates them against the (new) domain.
    const edit = validateBrandInput({ officialDomain: "www.acme-sound.com" }, stored);
    expect(edit.ok ? "ok" : edit.error).toMatch(/must be on www\.acme-sound\.com/);
    const ok = validateBrandInput({ currency: "CAD" }, stored);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const r = await updateBrand(stored.id, ok.value);
      expect(r.ok && r.after.currency).toBe("CAD");
      expect(r.ok && r.after.dealUrls).toHaveLength(2);
    }
  });

  it("slugFromName produces a valid slug", () => {
    expect(slugFromName("Bang & Olufsen")).toBe("bang-olufsen");
    expect(slugFromName("Café Électrique™")).toBe("cafe-electrique");
    expect(slugFromName("!!!")).toBe("");
  });

  it("seed import carries deal URLs, product URLs and currency; invalid ones are reported, never stored", async () => {
    const seed: BrandSeed[] = [
      { name: "Acme Audio", slug: "acme-audio", officialDomain: D, market: "US", categories: ["audio"], discoveryUrls: [], productUrlPatterns: [], promoUrls: [], dealUrls: ["https://www.acme-audio.com/sale"], productUrls: ["https://www.acme-audio.com/products/a1"], currency: "USD", notes: null },
      { name: "Tracked", slug: "tracked", officialDomain: "www.tracked-brand.com", market: "US", categories: ["audio"], discoveryUrls: [], productUrlPatterns: [], promoUrls: [], dealUrls: ["https://www.tracked-brand.com/sale?utm_source=x"], notes: null },
    ];
    const r = await importSeedBrands(seed);
    expect(r.created).toBe(1);
    expect(r.invalid).toEqual([{ slug: "tracked", error: expect.stringMatching(/tracking/) }]);
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "acme-audio" } })).toMatchObject({ dealUrls: ["https://www.acme-audio.com/sale"], productUrls: ["https://www.acme-audio.com/products/a1"], currency: "USD" });
    expect(await db.commerceBrand.findUnique({ where: { slug: "tracked" } })).toBeNull();

    // Re-import fills an emptied list, never replaces an admin's list.
    const b = await db.commerceBrand.findUniqueOrThrow({ where: { slug: "acme-audio" } });
    await db.commerceBrand.update({ where: { id: b.id }, data: { dealUrls: [], productUrls: ["https://www.acme-audio.com/products/admin-choice"] } });
    await importSeedBrands(seed.slice(0, 1));
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "acme-audio" } })).toMatchObject({ dealUrls: ["https://www.acme-audio.com/sale"], productUrls: ["https://www.acme-audio.com/products/admin-choice"] });
  });
});
