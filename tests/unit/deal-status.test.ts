import { describe, expect, it } from "vitest";
import { extractOffersFromJsonLd } from "@/lib/products/page-extract";
import { classifyOffers, computeSaving, couponDealStatus, offerDealStatus, summarizeStatuses, validUntilMs, type DealBrandInput, type DealCouponInput, type DealOfferInput, type DealProductInput } from "@/lib/commerce/deal-status";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const OPTS = { maxAgeMs: 48 * HOUR };

const brand: DealBrandInput = { name: "Framework", officialDomain: "frame.work", officialStoreUrl: null };
const OFFICIAL_URL = "https://frame.work/products/laptop13";
const RETAIL_URL = "https://www.bestbuy.com/site/framework-13/123.p";

const offer = (over: Partial<DealOfferInput> = {}): DealOfferInput => ({
  id: "o1",
  seller: "Framework",
  sellerType: "MANUFACTURER",
  destinationUrl: OFFICIAL_URL,
  affiliateUrl: null,
  affiliateStatus: "NONE",
  price: 799,
  listPrice: 999,
  currency: "USD",
  availability: "InStock",
  observedAt: ago(HOUR),
  status: "FRESH",
  linkStatus: "OK",
  linkCheckedAt: ago(2 * HOUR),
  ...over,
});

const product = (over: Partial<DealProductInput> = {}): DealProductInput => ({
  id: "p1",
  name: "Framework Laptop 13",
  canonicalUrl: OFFICIAL_URL,
  identityStatus: "MATCHED",
  productEntityId: "e1",
  entity: { officialStatus: "VERIFIED", factSummary: null },
  official: null,
  ...over,
});

/** A retailer page for the same product, confirmed by a MATCHED official-domain page. */
const retail = (over: Partial<DealOfferInput> = {}) => offer({ id: "r1", seller: "Best Buy", sellerType: "RETAILER", destinationUrl: RETAIL_URL, price: 849, listPrice: 999, ...over });
const retailProduct = (over: Partial<DealProductInput> = {}) =>
  product({ id: "p2", canonicalUrl: RETAIL_URL, entity: { officialStatus: null, factSummary: null }, official: { url: OFFICIAL_URL, price: 799, listPrice: 999, currency: "USD" }, ...over });

const status = (o: DealOfferInput, p: DealProductInput = product(), b: DealBrandInput = brand) => offerDealStatus(o, p, b, NOW, OPTS);
const codes = (v: { reasons: Array<{ code: string }> }) => v.reasons.map((r) => r.code);

describe("offerDealStatus", () => {
  it("ACTIVE: official-domain page, stated list price above the price, USD, fresh, link OK, in stock", () => {
    const v = status(offer());
    expect(v).toMatchObject({ status: "ACTIVE", reasons: [], officialSite: true, officialStore: true, saving: { amount: 200, percent: 20 }, availabilityLabel: "In stock", validUntil: null });
  });

  it("ACTIVE with unstated availability (no label), PreOrder and LimitedAvailability", () => {
    expect(status(offer({ availability: null }))).toMatchObject({ status: "ACTIVE", availabilityLabel: null });
    expect(status(offer({ availability: "https://schema.org/PreOrder" }))).toMatchObject({ status: "ACTIVE", availabilityLabel: "Pre-order" });
    expect(status(offer({ availability: "LimitedAvailability" }))).toMatchObject({ status: "ACTIVE", availabilityLabel: "Limited availability" });
  });

  it("an official page with a stated identity but no Made4Buyers match is ACTIVE; with no identity it is INVALID", () => {
    expect(status(offer(), product({ identityStatus: "UNMATCHED", productEntityId: null, entity: null, sku: "FRAGAACX01" })).status).toBe("ACTIVE");
    const v = status(offer(), product({ identityStatus: "UNMATCHED", productEntityId: null, entity: null }));
    expect(v.status).toBe("INVALID");
    expect(codes(v)).toContain("NO_IDENTITY");
  });

  it("labels the previous price as the page did, and reads a stated price end from the page data", () => {
    const data = (o: Record<string, unknown>) => ({ offers: [{ type: "Offer", price: 799, listPrice: 999, url: OFFICIAL_URL, ...o }] });
    expect(status(offer(), product({ data: data({ listPriceType: "ListPrice" }) })).listPriceLabel).toBe("Regular price");
    expect(status(offer(), product({ data: data({ listPriceType: "StrikethroughPrice" }) })).listPriceLabel).toBe("Was");
    expect(status(offer(), product()).listPriceLabel).toBe("List price");
    // A stated end still ahead: ACTIVE, carried for display.
    const ahead = status(offer(), product({ data: data({ priceValidUntil: "2026-10-20" }) }));
    expect(ahead).toMatchObject({ status: "ACTIVE", validUntil: "2026-10-20" });
    // Data for a different amount is not this offer's statement.
    expect(status(offer(), product({ data: { offers: [{ price: 899, listPrice: 999, priceValidUntil: "2026-01-01" }] } })).status).toBe("ACTIVE");
  });

  it("EXPIRED: stated promotion end passed (date-only ends at the end of that day)", () => {
    const v = status(offer(), product({ data: { offers: [{ price: 799, listPrice: 999, url: OFFICIAL_URL, priceValidUntil: "2026-10-14" }] } }));
    expect(v.status).toBe("EXPIRED");
    expect(codes(v)).toEqual(["PROMOTION_ENDED"]);
    expect(validUntilMs("2026-10-15")).toBeGreaterThan(NOW);
    expect(status(offer(), product({ data: { offers: [{ price: 799, listPrice: 999, url: OFFICIAL_URL, priceValidUntil: "2026-10-15" }] } })).status).toBe("ACTIVE");
  });

  it("EXPIRED: older than 48 h, or not FRESH", () => {
    const stale = status(offer({ observedAt: ago(49 * HOUR) }));
    expect(stale.status).toBe("EXPIRED");
    expect(codes(stale)).toEqual(["STALE"]);
    expect(status(offer({ observedAt: ago(47 * HOUR) })).status).toBe("ACTIVE");
    expect(codes(status(offer({ status: "STALE" })))).toEqual(["NOT_FRESH"]);
  });

  it("INVALID: non-USD, no/zero price, list ≤ price, unknown site, future observation", () => {
    const gbp = status(offer({ currency: "GBP" }));
    expect(gbp.status).toBe("INVALID");
    expect(codes(gbp)).toEqual(["NOT_USD"]);
    expect(codes(status(offer({ price: 0 })))).toContain("NO_PRICE");
    expect(codes(status(offer({ price: null })))).toContain("NO_PRICE");
    const equal = status(offer({ price: 999, listPrice: 999 }));
    expect(equal.status).toBe("INVALID");
    expect(codes(equal)).toEqual(["LIST_NOT_ABOVE_PRICE"]);
    expect(status(offer({ price: 999, listPrice: 899 })).status).toBe("INVALID");
    const lookalike = status(offer({ destinationUrl: "https://framework-outlet.shop/p/13" }));
    expect(lookalike.status).toBe("INVALID");
    expect(codes(lookalike)).toContain("UNKNOWN_SELLER_DOMAIN");
    expect(lookalike.officialSite).toBe(false);
    expect(codes(status(offer({ observedAt: new Date(NOW + 3 * HOUR) })))).toContain("FUTURE_OBSERVATION");
    expect(codes(status(offer({ destinationUrl: "http://127.0.0.1/p" })))).toContain("BAD_URL");
  });

  it("BROKEN: link check BROKEN / OFF_SITE / UNREACHABLE (wins over every other problem); BLOCKED and UNCHECKED stay displayable", () => {
    for (const linkStatus of ["BROKEN", "OFF_SITE", "UNREACHABLE"]) {
      const v = status(offer({ linkStatus, currency: "GBP", observedAt: ago(72 * HOUR) }));
      expect(v.status).toBe("BROKEN");
      expect(codes(v)).toEqual(expect.arrayContaining(["LINK_BROKEN", "NOT_USD", "STALE"]));
    }
    expect(status(offer({ linkStatus: "BLOCKED" })).status).toBe("ACTIVE");
    expect(status(offer({ linkStatus: "UNCHECKED", linkCheckedAt: null })).status).toBe("ACTIVE");
  });

  it("VERIFIED (not a drop): no stated list price, out of stock / sold out / discontinued, unclear availability", () => {
    const noList = status(offer({ listPrice: null }));
    expect(noList).toMatchObject({ status: "VERIFIED", saving: null });
    expect(codes(noList)).toEqual(["NO_LIST_PRICE"]);
    for (const availability of ["OutOfStock", "https://schema.org/SoldOut", "Discontinued"]) {
      const v = status(offer({ availability }));
      expect(v.status).toBe("VERIFIED");
      expect(codes(v)).toEqual(["OUT_OF_STOCK"]);
    }
    expect(codes(status(offer({ availability: "InStoreOnly" })))).toEqual(["AVAILABILITY_UNCLEAR"]);
  });

  it("retailer: ACTIVE when the product is confirmed on the official site (its price may differ from the official price)", () => {
    const v = status(retail(), retailProduct());
    expect(v).toMatchObject({ status: "ACTIVE", officialSite: false, officialStore: false, officialConfirmed: true, saving: { amount: 150, percent: 15 } });
    // Confirmed by the product's official verification alone.
    expect(status(retail(), retailProduct({ official: null, entity: { officialStatus: "VERIFIED", factSummary: null } })).status).toBe("ACTIVE");
  });

  it("UNVERIFIED: a retailer page whose product has no official-site confirmation", () => {
    const v = status(retail(), retailProduct({ official: null, entity: { officialStatus: "NOT_FOUND", factSummary: null } }));
    expect(v.status).toBe("UNVERIFIED");
    expect(codes(v)).toEqual(["NO_OFFICIAL_CONFIRMATION"]);
    const unmatched = status(retail(), retailProduct({ identityStatus: "UNMATCHED", productEntityId: null, entity: null, official: null, sku: "FRA-13" }));
    expect(unmatched.status).toBe("UNVERIFIED");
    // A "MANUFACTURER" seller off the official domain is not official.
    expect(status(offer({ destinationUrl: RETAIL_URL }), retailProduct({ official: null, entity: null })).officialStore).toBe(false);
  });

  it("CONFLICTING: official verification MISMATCH, conflicting price facts, or a retailer 'regular price' above the official one", () => {
    const mismatch = status(offer(), product({ entity: { officialStatus: "MISMATCH", factSummary: null } }));
    expect(mismatch.status).toBe("CONFLICTING");
    expect(codes(mismatch)).toEqual(["OFFICIAL_MISMATCH"]);

    const facts = status(offer(), product({ entity: { officialStatus: "VERIFIED", factSummary: { fields: { price: { status: "CONFLICTING", value: null, source: null, note: "sources disagree" } } } } }));
    expect(facts.status).toBe("CONFLICTING");
    expect(codes(facts)).toEqual(["PRICE_FACT_CONFLICTING"]);

    const inflated = status(retail({ price: 899, listPrice: 1199 }), retailProduct());
    expect(inflated.status).toBe("CONFLICTING");
    expect(codes(inflated)).toEqual(["LIST_PRICE_CONTRADICTS_OFFICIAL"]);
    expect(inflated.reasons[0].message).toContain("$1199.00");

    // The official regular price can also come from the official site's own price fact.
    const fromFact = status(retail({ price: 899, listPrice: 1199 }), retailProduct({ official: null, entity: { officialStatus: "VERIFIED", factSummary: { fields: { price: { status: "VERIFIED", value: 999, unit: "USD", source: "MANUFACTURER" } } } } }));
    expect(fromFact.status).toBe("CONFLICTING");
    // Within a 1 % rounding tolerance it agrees.
    expect(status(retail({ price: 899, listPrice: 1005 }), retailProduct()).status).toBe("ACTIVE");
  });
});

describe("computeSaving", () => {
  it("floors the amount to the cent and the percent to a whole number", () => {
    expect(computeSaving(79.99, 99.99)).toEqual({ amount: 20, percent: 20 });
    expect(computeSaving(66.67, 100)).toEqual({ amount: 33.33, percent: 33 });
    expect(computeSaving(100, 100)).toBeNull();
    expect(computeSaving(100, 90)).toBeNull();
  });
});

describe("classifyOffers", () => {
  it("lists a deal once: tracking variants of one page and a second offer of the same seller domain become VERIFIED / DUPLICATE", () => {
    const items = [
      { offer: offer({ id: "a", observedAt: ago(3 * HOUR) }), product: product(), brand },
      { offer: offer({ id: "b", destinationUrl: `${OFFICIAL_URL}?utm_source=mail#buy` }), product: product(), brand },
      { offer: offer({ id: "c", destinationUrl: "https://frame.work/products/laptop13-bundle", price: 899 }), product: product(), brand },
      { offer: retail(), product: retailProduct(), brand },
    ];
    const out = classifyOffers(items, NOW, OPTS);
    const byId = Object.fromEntries(out.map((x) => [x.offer.id, x.verdict]));
    // a and b are the same page and the same saving: the more recent observation (b) is listed.
    expect(byId.b.status).toBe("ACTIVE");
    expect(byId.a.status).toBe("VERIFIED");
    expect(codes(byId.a)).toEqual(["DUPLICATE"]);
    expect(byId.c.status).toBe("VERIFIED"); // same product, same seller domain
    expect(byId.r1.status).toBe("ACTIVE"); // a different seller domain
  });
});

describe("couponDealStatus", () => {
  const coupon = (over: Partial<DealCouponInput> = {}): DealCouponInput => ({ code: "SAVE10", status: "VERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: ago(DAY), sourceUrl: "https://frame.work/promotions", brand, ...over });
  const c = (over: Partial<DealCouponInput> = {}) => couponDealStatus(coupon(over), NOW, { maxAgeDays: 7 });

  it("ACTIVE only for VERIFIED, started, unexpired and re-seen within the max age, on the official domain", () => {
    expect(c()).toEqual({ status: "ACTIVE", reasons: [] });
    expect(c({ startsAt: ago(DAY), expiresAt: new Date(NOW + DAY) }).status).toBe("ACTIVE");
  });

  it("EXPIRED: stored EXPIRED, stated expiry passed, or not re-seen within the max age", () => {
    expect(c({ status: "EXPIRED" }).status).toBe("EXPIRED");
    expect(codes(c({ expiresAt: ago(HOUR) }))).toEqual(["COUPON_EXPIRED"]);
    expect(codes(c({ lastVerifiedAt: ago(8 * DAY) }))).toEqual(["COUPON_NOT_RESEEN"]);
    expect(codes(c({ lastVerifiedAt: null }))).toEqual(["COUPON_NOT_RESEEN"]);
  });

  it("INVALID, CONFLICTING, UNVERIFIED, and VERIFIED-but-not-started", () => {
    expect(c({ status: "INVALID" }).status).toBe("INVALID");
    expect(c({ code: " " }).status).toBe("INVALID");
    expect(c({ status: "CONFLICTING" }).status).toBe("CONFLICTING");
    expect(c({ status: "UNVERIFIED" }).status).toBe("UNVERIFIED");
    expect(c({ status: "UNKNOWN" }).status).toBe("UNVERIFIED");
    const thirdParty = c({ sourceUrl: "https://coupons.example.com/framework" });
    expect(thirdParty.status).toBe("UNVERIFIED");
    expect(codes(thirdParty)).toEqual(["COUPON_NOT_FIRST_PARTY"]);
    const future = c({ startsAt: new Date(NOW + 2 * DAY) });
    expect(future.status).toBe("VERIFIED");
    expect(codes(future)).toEqual(["COUPON_NOT_STARTED"]);
  });
});

describe("summarizeStatuses", () => {
  it("counts every status and the reasons that decided it", () => {
    const s = summarizeStatuses([status(offer()), status(offer({ linkStatus: "BROKEN", currency: "GBP" })), status(offer({ observedAt: ago(72 * HOUR) })), status(offer({ observedAt: ago(90 * HOUR) }))]);
    expect(s.total).toBe(4);
    expect(s.byStatus).toEqual({ ACTIVE: 1, VERIFIED: 0, EXPIRED: 2, INVALID: 0, BROKEN: 1, CONFLICTING: 0, UNVERIFIED: 0 });
    expect(s.topReasons.EXPIRED).toEqual([{ code: "STALE", count: 2 }]);
    // NOT_USD is listed on the row but it is not what made it BROKEN.
    expect(s.topReasons.BROKEN).toEqual([{ code: "LINK_BROKEN", count: 1 }]);
  });
});

describe("page extraction feeds the deal labels (stated values only)", () => {
  const ld = (offers: unknown) => [{ "@context": "https://schema.org", "@type": "Product", name: "Framework Laptop 13", brand: { "@type": "Brand", name: "Framework" }, offers }];
  const spec = (priceType: string) => [{ "@type": "UnitPriceSpecification", priceType, price: 999, priceCurrency: "USD" }];

  it("records how the list price was marked and a stated price end", () => {
    const [a] = extractOffersFromJsonLd(ld({ "@type": "Offer", price: "799", priceCurrency: "USD", priceValidUntil: "2026-10-31", priceSpecification: spec("https://schema.org/ListPrice") }), OFFICIAL_URL);
    expect(a).toMatchObject({ price: 799, listPrice: 999, listPriceType: "ListPrice", priceValidUntil: "2026-10-31" });
    const [b] = extractOffersFromJsonLd(ld({ "@type": "Offer", price: "799", priceCurrency: "USD", priceSpecification: [...spec("StrikethroughPrice"), { "@type": "UnitPriceSpecification", price: 799, validThrough: "2026-11-01T08:00:00Z" }] }), OFFICIAL_URL);
    expect(b).toMatchObject({ listPriceType: "StrikethroughPrice", priceValidUntil: "2026-11-01T08:00:00Z" });
  });

  it("never invents an end date or a list price type", () => {
    const [a] = extractOffersFromJsonLd(ld({ "@type": "Offer", price: "799", priceCurrency: "USD", priceValidUntil: "soon" }), OFFICIAL_URL);
    expect(a.priceValidUntil).toBeUndefined();
    expect(a.listPriceType).toBeUndefined();
    const [b] = extractOffersFromJsonLd(ld({ "@type": "Offer", price: "799", priceCurrency: "USD", priceSpecification: spec("https://schema.org/MSRP") }), OFFICIAL_URL);
    expect(b.listPrice).toBeUndefined();
    expect(b.listPriceType).toBeUndefined();
  });
});

describe("not-new items (found live: Logitech outlet refurbs listed against the new price)", () => {
  it("a refurbished / renewed / open-box item is never an ACTIVE price drop", () => {
    for (const name of ["Refurbished PRO X 60", "REFURBISHED YETI GX", "Open-Box Laptop 13", "Pre-owned Camera", "Renewed Phone"]) {
      const v = status(offer(), product({ name }));
      expect(v.status).not.toBe("ACTIVE");
      expect(codes(v)).toContain("NOT_NEW_CONDITION");
    }
    const byUrl = status(offer({ destinationUrl: "https://www.example-brand.com/shop/p/pro-x-superlight-wireless-mouse-refurb" }), product({ name: "PRO X SUPERLIGHT" }));
    expect(codes(byUrl)).toContain("NOT_NEW_CONDITION");
  });
  it("words that merely contain the letters are not flagged", () => {
    expect(codes(status(offer(), product({ name: "Boxed Open-Ear Headphones" })))).not.toContain("NOT_NEW_CONDITION");
    expect(codes(status(offer(), product({ name: "Furbish Lamp" })))).not.toContain("NOT_NEW_CONDITION");
  });
});
