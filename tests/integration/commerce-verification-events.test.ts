import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { classifyOfferStatuses, dealStatusCounts } from "@/lib/commerce/classify";
import { markExpiredCoupons, recordDisappearances, upsertCoupons, type NormalizedCoupon } from "@/lib/commerce/coupons";
import { runLinkValidation } from "@/lib/commerce/link-check";
import { runOfficialVerify } from "@/lib/commerce/official";
import {
  latestVerifications,
  pruneVerificationEvents,
  recordIdentityDecision,
  recordPriceChange,
  recordPriceRejected,
  recordVerification,
  smallDetails,
} from "@/lib/commerce/verification-events";
import { JOBS } from "@/lib/jobs/registry";
import { loadOfficialDeals } from "@/lib/public/deals";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Verification history (commerce_verification_events) and the persisted deal status
 * (CommerceOffer.dealStatus). All data here is SAMPLE data.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let server: http.Server;
let base = "";
let restore: () => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/robots.txt") return void (res.writeHead(200, { "Content-Type": "text/plain" }), res.end("User-agent: *\nAllow: /\n"));
    if (url.pathname === "/site/ok") return void (res.writeHead(200), res.end());
    return void (res.writeHead(404), res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  restore = withEnv({ PRODUCT_PRICE_MAX_AGE_HOURS: undefined, COMMERCE_LINK_CHECK_DELAY_MS: "0", COMMERCE_COUPON_MAX_AGE_DAYS: undefined, AFFILIATE_PROVIDER: undefined });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(() => resetDb());

const events = (kind: string, entityId?: string) => db.commerceVerificationEvent.findMany({ where: { kind, ...(entityId ? { entityId } : {}) }, orderBy: [{ checkedAt: "asc" }, { id: "asc" }] });

describe("recordVerification", () => {
  it("writes batched events with bounded details, lists the latest first, and never throws", async () => {
    const t0 = new Date(Date.now() - HOUR);
    const n = await recordVerification([
      { entityType: "offer", entityId: "o1", kind: "LINK", result: "OK", sourceUrl: "https://www.acme-audio.com/p", details: { httpStatus: 200, note: "x".repeat(1000) }, checkedAt: t0 },
      { entityType: "offer", entityId: "o1", kind: "LINK", result: "BROKEN", reason: "HTTP 404" },
    ]);
    expect(n).toBe(2);
    const latest = await latestVerifications("offer", "o1", 10);
    expect(latest.map((e) => e.result)).toEqual(["BROKEN", "OK"]);
    expect((latest[1].details as { note: string }).note.length).toBeLessThanOrEqual(301);

    // Large nested details stay small.
    const big = smallDetails({ list: Array.from({ length: 100 }, (_, i) => ({ i, s: "y".repeat(400) })), deep: { a: { b: { c: { d: 1 } } } } });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(2100);

    // A failed write is logged, not thrown.
    const spy = vi.spyOn(db.commerceVerificationEvent, "createMany").mockRejectedValueOnce(new Error("db down"));
    await expect(recordVerification([{ entityType: "offer", entityId: "o2", kind: "LINK", result: "OK" }])).resolves.toBe(0);
    spy.mockRestore();
  });

  it("identity decisions are recorded every time; price events only for a change or a rejection", async () => {
    await recordIdentityDecision({ commerceProductId: "cp1", result: "MATCHED", basis: "GTIN", reason: "exact GTIN", productEntityId: "e1", sourceUrl: "https://www.acme-audio.com/p" });
    await recordIdentityDecision({ commerceProductId: "cp1", result: "MATCHED", basis: "GTIN", reason: "exact GTIN", productEntityId: "e1" });
    expect(await events("IDENTITY", "cp1")).toHaveLength(2);

    const snap = { price: 80, listPrice: 100, currency: "USD" };
    expect(await recordPriceChange({ offerId: "of1", before: null, after: snap })).toBe(true); // CREATED
    expect(await recordPriceChange({ offerId: "of1", before: snap, after: { ...snap } })).toBe(false); // unchanged: no event
    expect(await recordPriceChange({ offerId: "of1", before: snap, after: { ...snap, listPrice: 120 } })).toBe(true); // list price changed
    await recordPriceRejected({ commerceProductId: "cp1", sourceUrl: "https://www.acme-audio.com/en-gb/p", price: 70, currency: "GBP", reason: "currency GBP is not USD for a US-market brand" });
    const price = await events("PRICE");
    expect(price.map((e) => [e.entityType, e.entityId, e.result])).toEqual([
      ["offer", "of1", "CREATED"],
      ["offer", "of1", "CHANGED"],
      ["product", "cp1", "REJECTED"],
    ]);
    expect(price[1].reason).toBe("list price 100 → 120");
  });
});

describe("events for every check kind (including unchanged checks)", () => {
  it("LINK: one event per destination check with the HTTP status and final URL, changed or not", async () => {
    const p = await db.commerceProduct.create({ data: { canonicalUrl: `${base}/site/ok`, name: "Sample", observedAt: new Date() } });
    const mk = (u: string) => db.commerceOffer.create({ data: { productId: p.id, seller: "Sample", sellerType: "MANUFACTURER", destinationUrl: `${base}${u}`, price: 10, currency: "USD", observedAt: new Date() } });
    const ok = await mk("/site/ok");
    const gone = await mk("/site/gone");
    const t0 = new Date();
    const r1 = await runLinkValidation("test", t0);
    expect(r1).toMatchObject({ checked: 2, dealStatus: { checked: 2, changed: 2 } });
    await runLinkValidation("test", new Date(t0.getTime() + 25 * HOUR)); // re-check: nothing changes
    const okEvents = await events("LINK", ok.id);
    expect(okEvents.map((e) => e.result)).toEqual(["OK", "OK"]);
    expect(okEvents[0]).toMatchObject({ entityType: "offer", sourceUrl: `${base}/site/ok`, details: expect.objectContaining({ httpStatus: 200, finalUrl: `${base}/site/ok`, changed: true }) });
    expect(okEvents[1].details).toMatchObject({ changed: false, previous: "OK" });
    const goneEvents = await events("LINK", gone.id);
    expect(goneEvents.map((e) => e.result)).toEqual(["BROKEN", "BROKEN"]);
    expect(goneEvents[0].details).toMatchObject({ httpStatus: 404 });
    // The checked offers were classified (link validation ends with the persisted deal status).
    expect((await db.commerceOffer.findUniqueOrThrow({ where: { id: gone.id } })).dealStatus).toBe("BROKEN");
  });

  it("OFFICIAL: every VERIFIED / NOT_FOUND decision is recorded, also when unchanged; changed products' offers are re-classified", async () => {
    const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "acme-audio.com", categories: [] } });
    await db.commerceRun.create({ data: { purpose: "PRODUCT", actorId: "apify/web-scraper", trigger: "test", status: "COLLECTED", brandId: brand.id, collectedAt: new Date() } });
    const found = await db.productEntity.create({ data: { slug: "acme-one", name: "Acme One", matchKey: "acme one", brand: "Acme" } });
    const missing = await db.productEntity.create({ data: { slug: "acme-two", name: "Acme Two", matchKey: "acme two", brand: "Acme" } });
    const cp = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.acme-audio.com/products/one", name: "Acme One", identityStatus: "MATCHED", productEntityId: found.id, observedAt: new Date() } });
    const offer = await db.commerceOffer.create({ data: { productId: cp.id, seller: "Acme", sellerType: "MANUFACTURER", destinationUrl: "https://www.acme-audio.com/products/one", price: 80, listPrice: 100, currency: "USD", availability: "InStock", observedAt: new Date(), linkStatus: "OK" } });

    await runOfficialVerify("test");
    await runOfficialVerify("test");
    const f = await events("OFFICIAL", found.id);
    expect(f.map((e) => e.result)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(f.map((e) => (e.details as { changed: boolean }).changed)).toEqual([true, false]);
    expect(f[0]).toMatchObject({ entityType: "product", sourceUrl: "https://www.acme-audio.com/products/one" });
    expect((await events("OFFICIAL", missing.id)).map((e) => e.result)).toEqual(["NOT_FOUND", "NOT_FOUND"]);
    expect((await db.commerceOffer.findUniqueOrThrow({ where: { id: offer.id } })).dealStatus).toBe("ACTIVE");
  });

  it("COUPON: every verification at collect (observed, missing, expired), with evidence", async () => {
    const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "acme-audio.com", categories: [] } });
    const c: NormalizedCoupon = { merchant: "Acme", code: "SAVE10", title: null, description: null, discount: "10% off", discountType: "PERCENT", startsAt: null, expiresAt: null, eligibility: null, restrictions: null, sourceUrl: "https://www.acme-audio.com/promotions", merchantUrl: null, firstParty: true, evidence: "MARKED", sufficient: true, conflict: null };
    const t0 = new Date(Date.now() - 2 * DAY);
    await upsertCoupons({ brandId: brand.id, coupons: [c, { ...c, code: "OLD5", expiresAt: new Date(Date.now() + DAY) }], observedAt: t0, now: t0 });
    await upsertCoupons({ brandId: brand.id, coupons: [c], observedAt: new Date(t0.getTime() + HOUR), now: new Date(t0.getTime() + HOUR) }); // unchanged re-observation
    const save10 = await db.commerceCoupon.findFirstOrThrow({ where: { code: "SAVE10" } });
    const ev = await events("COUPON", save10.id);
    expect(ev.map((e) => e.result)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(ev[0].reason).toMatch(/^Published on https:\/\/www\.acme-audio\.com\/promotions/);
    expect(ev[1].details).toMatchObject({ code: "SAVE10", previous: "VERIFIED", changed: false, check: "OBSERVED" });

    // Not on the page in a later crawl: a check, recorded even though it is the first miss.
    await recordDisappearances({ merchant: "Acme", sourceUrl: c.sourceUrl, presentCodes: ["SAVE10"] });
    const old5 = await db.commerceCoupon.findFirstOrThrow({ where: { code: "OLD5" } });
    expect((await events("COUPON", old5.id)).map((e) => (e.details as { check: string }).check)).toEqual(["OBSERVED", "MISSING"]);
    // Its stated expiry passes.
    await markExpiredCoupons(new Date(Date.now() + 2 * DAY));
    const last = (await events("COUPON", old5.id)).at(-1)!;
    expect(last).toMatchObject({ result: "EXPIRED", details: expect.objectContaining({ check: "EXPIRY", changed: true }) });
  });
});

describe("pruneVerificationEvents", () => {
  it("deletes events older than the window but keeps the latest per entity + kind, and nothing else", async () => {
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const ev = (entityId: string, kind: "LINK" | "OFFICIAL", days: number, result = "OK") => ({ entityType: "offer" as const, entityId, kind, result, checkedAt: at(days) });
    await recordVerification([
      ev("x", "LINK", 100), ev("x", "LINK", 95), ev("x", "LINK", 10), // old ones go, the recent one stays
      ev("y", "LINK", 200), ev("y", "LINK", 150, "BROKEN"), // both old: the latest (150 d) is kept
      ev("y", "OFFICIAL", 120), // the only one of its kind: kept
      ev("z", "LINK", 91), ev("z", "LINK", 91), // same instant: one kept
    ]);
    await db.auditLog.create({ data: { actor: "system", action: "LINK_VALIDATED", entityType: "commerce_offer", entityId: "x", createdAt: at(400) } });

    const r = await pruneVerificationEvents(90, now);
    expect(r.deleted).toBe(4);
    const left = await db.commerceVerificationEvent.findMany({ orderBy: [{ entityId: "asc" }, { kind: "asc" }] });
    expect(left.map((e) => `${e.entityId}:${e.kind}:${Math.round((now.getTime() - e.checkedAt.getTime()) / DAY)}:${e.result}`)).toEqual(["x:LINK:10:OK", "y:LINK:150:BROKEN", "y:OFFICIAL:120:OK", "z:LINK:91:OK"]);
    expect(await db.auditLog.count()).toBe(1);
    // Idempotent.
    expect((await pruneVerificationEvents(90, now)).deleted).toBe(0);
  });

  it("runs as part of the cache-cleanup job", async () => {
    await recordVerification([
      { entityType: "coupon", entityId: "c", kind: "COUPON", result: "VERIFIED", checkedAt: new Date(Date.now() - 200 * DAY) },
      { entityType: "coupon", entityId: "c", kind: "COUPON", result: "VERIFIED", checkedAt: new Date(Date.now() - DAY) },
    ]);
    const r = (await JOBS["cleanup-cache"].run("test")) as { verificationEventsPruned: number };
    expect(r.verificationEventsPruned).toBe(1);
    expect(await db.commerceVerificationEvent.count()).toBe(1);
  });
});

// ── Persisted deal status ───────────────────────────────────────────────────

/** A known set: 3 ACTIVE (official, retailer confirmed, standalone official page) and one of each other status. */
async function seedDeals(now: number) {
  const ago = (ms: number) => new Date(now - ms);
  const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "acme-audio.com", categories: ["audio"] } });
  const entity = await db.productEntity.create({ data: { slug: "acme-one", name: "Acme One", matchKey: "acme one", brand: "Acme", officialStatus: "VERIFIED" } });
  const official = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.acme-audio.com/products/one", name: "Acme One", identityStatus: "MATCHED", productEntityId: entity.id, observedAt: ago(HOUR) } });
  const retail = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.bestbuy.com/site/acme-one/1.p", name: "Acme One", identityStatus: "MATCHED", productEntityId: entity.id, observedAt: ago(HOUR) } });
  const unconfirmed = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.bestbuy.com/site/acme-two/2.p", name: "Acme Two", identityStatus: "UNMATCHED", sku: "ACME-TWO", observedAt: ago(HOUR) } });
  const standalone = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.acme-audio.com/products/three", name: "Acme Three", identityStatus: "UNMATCHED", sku: "ACME-THREE", observedAt: ago(HOUR) } });
  const o = (productId: string, data: Record<string, unknown>) =>
    db.commerceOffer.create({ data: { productId, seller: "Acme", sellerType: "MANUFACTURER", destinationUrl: "https://www.acme-audio.com/products/one", price: 80, listPrice: 100, currency: "USD", availability: "InStock", observedAt: ago(HOUR), linkStatus: "OK", ...data } });
  return {
    active: await o(official.id, {}),
    duplicate: await o(official.id, { destinationUrl: "https://www.acme-audio.com/products/one?utm_source=mail", observedAt: ago(3 * HOUR) }),
    retailer: await o(retail.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/acme-one/1.p", price: 85 }),
    standalone: await o(standalone.id, { destinationUrl: "https://www.acme-audio.com/products/three", price: 150, listPrice: 200 }),
    unverified: await o(unconfirmed.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/acme-two/2.p", price: 50, listPrice: 70 }),
    broken: await o(official.id, { destinationUrl: "https://www.acme-audio.com/products/one-b", linkStatus: "BROKEN" }),
    stale: await o(official.id, { destinationUrl: "https://www.acme-audio.com/products/one-c", observedAt: ago(72 * HOUR) }),
    invalid: await o(official.id, { destinationUrl: "https://www.acme-audio.com/en-gb/products/one", currency: "GBP" }),
    noList: await o(official.id, { destinationUrl: "https://www.acme-audio.com/products/one-d", listPrice: null }),
  };
}

const persisted = async () => Object.fromEntries((await db.commerceOffer.findMany({ select: { id: true, dealStatus: true } })).map((r) => [r.id, r.dealStatus]));

describe("classifyOfferStatuses (persisted deal status)", () => {
  it("persists the /deals decision, writes only changes, records events and audits transitions into/out of ACTIVE", async () => {
    const now = Date.now();
    const s = await seedDeals(now);

    // Classifying ONE offer still resolves duplicates against the /deals candidate set (the
    // candidates — fresh, USD, priced, with a list price, link not hidden — are persisted alongside).
    const one = await classifyOfferStatuses({ offerIds: [s.duplicate.id], now });
    expect(one).toMatchObject({ checked: 1, context: 4, changed: 5, activated: 3 });
    const dup = await db.commerceOffer.findUniqueOrThrow({ where: { id: s.duplicate.id } });
    expect(dup.dealStatus).toBe("VERIFIED");
    expect(dup.dealStatusReasons).toEqual([expect.objectContaining({ code: "DUPLICATE" })]);
    expect((await db.commerceOffer.findMany({ where: { dealStatus: null }, select: { id: true } })).map((r) => r.id).sort()).toEqual([s.broken.id, s.stale.id, s.invalid.id, s.noList.id].sort());

    const r1 = await classifyOfferStatuses({ now });
    expect(r1).toMatchObject({ checked: 9, context: 0, changed: 4, activated: 0, deactivated: 0 });
    expect(await persisted()).toEqual({
      [s.active.id]: "ACTIVE",
      [s.duplicate.id]: "VERIFIED",
      [s.retailer.id]: "ACTIVE",
      [s.standalone.id]: "ACTIVE",
      [s.unverified.id]: "UNVERIFIED",
      [s.broken.id]: "BROKEN",
      [s.stale.id]: "EXPIRED",
      [s.invalid.id]: "INVALID",
      [s.noList.id]: "VERIFIED",
    });
    expect(await db.commerceVerificationEvent.count({ where: { kind: "DEAL_STATUS" } })).toBe(9);
    expect(await db.auditLog.count({ where: { action: "DEAL_ACTIVATED" } })).toBe(3);
    const stale = await db.commerceOffer.findUniqueOrThrow({ where: { id: s.stale.id } });
    expect(stale.dealStatusAt?.getTime()).toBe(now);
    expect(stale.dealStatusReasons).toEqual([expect.objectContaining({ code: "STALE", message: expect.stringMatching(/observed 72 h ago/) })]);

    // Re-run an hour later: the stale offer's message changes ("73 h ago") but not its status or codes → no write, no event.
    const r2 = await classifyOfferStatuses({ now: now + HOUR });
    expect(r2).toMatchObject({ checked: 9, changed: 0 });
    expect(await db.commerceVerificationEvent.count({ where: { kind: "DEAL_STATUS" } })).toBe(9);
    expect((await db.commerceOffer.findUniqueOrThrow({ where: { id: s.stale.id } })).dealStatusAt?.getTime()).toBe(now);

    // The listed official offer's link breaks: it leaves ACTIVE and its duplicate takes its place.
    await db.commerceOffer.update({ where: { id: s.active.id }, data: { linkStatus: "BROKEN" } });
    const r3 = await classifyOfferStatuses({ now });
    expect(r3).toMatchObject({ checked: 9, changed: 2, activated: 1, deactivated: 1 });
    const out = await db.auditLog.findFirstOrThrow({ where: { action: "DEAL_DEACTIVATED" } });
    expect(out).toMatchObject({ entityType: "commerce_offer", entityId: s.active.id, before: { dealStatus: "ACTIVE" }, after: { dealStatus: "BROKEN" } });
    expect(await db.auditLog.findFirst({ where: { action: "DEAL_ACTIVATED", entityId: s.duplicate.id } })).not.toBeNull();
    const last = (await latestVerifications("offer", s.active.id, 1, "DEAL_STATUS"))[0];
    expect(last).toMatchObject({ result: "BROKEN", details: { from: "ACTIVE", to: "BROKEN", codes: ["LINK_BROKEN"] } });

    // Counts come from the persisted column.
    expect(await dealStatusCounts()).toEqual({ total: 9, unclassified: 0, other: 0, byStatus: { ACTIVE: 3, VERIFIED: 1, EXPIRED: 1, INVALID: 1, BROKEN: 2, CONFLICTING: 0, UNVERIFIED: 1 } });
  });

  it("persisted ACTIVE ids are exactly the price drops /deals shows", async () => {
    const now = Date.now();
    const s = await seedDeals(now);
    const activeIds = async () => (await db.commerceOffer.findMany({ where: { dealStatus: "ACTIVE" }, select: { id: true } })).map((r) => r.id).sort();
    const shownIds = async () => (await loadOfficialDeals(now)).drops.map((d) => d.id).sort();

    await classifyOfferStatuses({ now });
    expect(await activeIds()).toEqual([s.active.id, s.retailer.id, s.standalone.id].sort());
    expect(await activeIds()).toEqual(await shownIds());

    // After changes, classifying only the touched offers keeps them in agreement.
    await db.commerceOffer.update({ where: { id: s.retailer.id }, data: { linkStatus: "OFF_SITE" } });
    await db.commerceOffer.update({ where: { id: s.noList.id }, data: { listPrice: 120 } }); // now a drop (on a different page)
    await classifyOfferStatuses({ offerIds: [s.retailer.id, s.noList.id], now });
    expect(await activeIds()).toEqual(await shownIds());
    expect(await activeIds()).toContain(s.noList.id);
    expect(await activeIds()).not.toContain(s.retailer.id);

    // The official page's link breaks (only that offer is asked for): still in agreement. The
    // tracking-parameter copy stays a duplicate of the bigger saving now listed for that product.
    await db.commerceOffer.update({ where: { id: s.active.id }, data: { linkStatus: "BROKEN" } });
    await classifyOfferStatuses({ offerIds: [s.active.id], now });
    expect(await activeIds()).toEqual(await shownIds());
    expect(await activeIds()).toEqual([s.noList.id, s.standalone.id].sort());
  });

  it("classifies the offers of given product entities", async () => {
    const now = Date.now();
    const s = await seedDeals(now);
    const entity = await db.productEntity.findFirstOrThrow();
    const r = await classifyOfferStatuses({ productEntityIds: [entity.id], now });
    // official (7 offers) + retailer (1) are matched to the entity; the standalone and unconfirmed
    // pages are not, but are drop candidates (context for duplicate resolution).
    expect(r).toMatchObject({ checked: 7, context: 2 });
    expect((await db.commerceOffer.findUniqueOrThrow({ where: { id: s.standalone.id } })).dealStatus).toBe("ACTIVE");
    expect(await classifyOfferStatuses({ offerIds: [], now })).toMatchObject({ checked: 0 });
  });
});
