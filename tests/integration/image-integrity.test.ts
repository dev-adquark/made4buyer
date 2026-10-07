import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { loadImageCounts } from "@/lib/images/admin-stats";
import { INTEGRITY_STATE_KEY, NOT_EXACT_REASON, recheckImageAsset, runImageIntegrity } from "@/lib/images/integrity";
import { isJobName } from "@/lib/jobs/registry";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { resetDb } from "../support/db";

// A local image host whose answers each test sets per path (never a real network call).
type Answer = { status: number; type?: string };
const answers = new Map<string, Answer>();
const hits: Array<{ method: string; path: string; ua: string }> = [];
let server: http.Server;
let base = "";
let altBase = ""; // the same server under another host name (a second "host" for the 429 rule)

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits.push({ method: req.method ?? "", path, ua: String(req.headers["user-agent"] ?? "") });
    const a = answers.get(path) ?? { status: 200, type: "image/png" };
    res.writeHead(a.status, { "content-type": a.type ?? "image/png", "content-length": "1" });
    res.end(req.method === "HEAD" ? undefined : "x");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  altBase = `http://localhost:${port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  await resetDb();
  answers.clear();
  hits.length = 0;
});

let n = 0;
async function page(over: { url?: string; sourceType?: "CONTENT_API" | "WIKIMEDIA_COMMONS" | "PLACEHOLDER"; productName?: string; brand?: string; status?: "PUBLISHED" | "QUEUED"; failureReason?: string; enrichmentStatus?: "ENRICHED" | "FAILED" } = {}) {
  n++;
  const review = await db.normalizedReview.create({
    data: { source: "test", sourceId: `s${n}`, dedupeKey: `d${n}`, canonicalTitle: `Thing ${n} review`, slug: `thing-${n}-review`, productName: over.productName ?? `Thing ${n}`, brand: over.brand ?? "Acme", summary: "s", body: "b", categorySlug: "phones", status: over.status ?? "PUBLISHED", publishedAt: new Date() },
  });
  const placeholder = over.sourceType === "PLACEHOLDER";
  const asset = await db.imageAsset.create({
    data: {
      normalizedReviewId: review.id,
      sourceType: over.sourceType ?? "CONTENT_API",
      sourceUrl: placeholder ? "/placeholders/phones.svg" : (over.url ?? `${base}/img/${n}.png`),
      licenseState: placeholder ? "OWNED_PLACEHOLDER" : "VERIFIED",
      enrichmentStatus: over.enrichmentStatus ?? (placeholder ? "FALLBACK" : "ENRICHED"),
      failureReason: over.failureReason,
      isFallback: placeholder,
      imageType: placeholder ? "neutral-category" : over.sourceType === "WIKIMEDIA_COMMONS" ? "commons-product" : "source-product",
      subject: placeholder ? null : "PRODUCT",
      matchConfidence: placeholder ? null : 0.8,
    },
  });
  return { review, asset };
}

const fast = { pauseMs: 0 };
const day = (d: number) => new Date(Date.UTC(2026, 9, 7 + d, 4, 25));
const asset = (id: string) => db.imageAsset.findUniqueOrThrow({ where: { id } });

describe("image-integrity job", () => {
  it("is registered as a scheduled job", () => {
    expect(isJobName("image-integrity")).toBe(true);
  });

  it("broken → FAILED with a reason, the page falls back to the category image at once; audited; nothing deleted", async () => {
    const good = await page();
    const broken = await page({ url: `${base}/gone.png` });
    answers.set("/gone.png", { status: 404 });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r).toMatchObject({ checked: 2, ok: 1, failed: 1 });
    const b = await asset(broken.asset.id);
    expect(b.enrichmentStatus).toBe("FAILED");
    expect(b.failureReason).toMatch(/^image-integrity: HTTP 404/);
    expect((await asset(good.asset.id)).enrichmentStatus).toBe("ENRICHED");
    const model = await buildPageRenderModel(broken.review.id);
    expect(model.image?.url).toBe("/placeholders/phones.svg");
    const audits = await db.auditLog.findMany({ where: { entityType: "image_asset" } });
    expect(audits.map((a) => [a.action, a.entityId])).toEqual([["image.integrity.failed", broken.asset.id]]);
    expect(await db.imageAsset.count()).toBe(2);
    // A polite bot: identifies itself.
    expect(hits.every((h) => h.ua.startsWith("Made4BuyersBot/"))).toBe(true);
    // Placeholders are never requested.
    await page({ sourceType: "PLACEHOLDER" });
    hits.length = 0;
    await runImageIntegrity("test", { ...fast, now: day(1) });
    expect(hits.some((h) => h.path.includes("placeholders"))).toBe(false);
  });

  it("falls back to a 1-byte GET when HEAD is refused", async () => {
    const p = await page({ url: `${base}/nohead.png` });
    const srv = server.listeners("request")[0] as http.RequestListener;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (req.url === "/nohead.png" && req.method === "HEAD") {
        hits.push({ method: "HEAD", path: "/nohead.png", ua: "" });
        res.writeHead(405).end();
        return;
      }
      if (req.url === "/nohead.png") expect(req.headers.range).toBe("bytes=0-0");
      srv(req, res);
    });
    try {
      const r = await runImageIntegrity("test", { ...fast, now: day(0) });
      expect(r.ok).toBe(1);
      expect(hits.map((h) => h.method)).toEqual(["HEAD", "GET"]);
      expect((await asset(p.asset.id)).enrichmentStatus).toBe("ENRICHED");
    } finally {
      server.removeAllListeners("request");
      server.on("request", srv);
    }
  });

  it("transient: FAILED only on the second consecutive run; an OK in between resets it", async () => {
    const p = await page({ url: `${base}/flaky.png` });
    answers.set("/flaky.png", { status: 503 });
    let r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r.transient).toBe(1);
    expect((await asset(p.asset.id)).enrichmentStatus).toBe("ENRICHED");
    // Checked < 20 h ago: skipped.
    r = await runImageIntegrity("test", { ...fast, now: new Date(day(0).getTime() + 3_600_000) });
    expect(r).toMatchObject({ checked: 0, skippedRecent: 1 });
    // OK once: the count resets.
    answers.delete("/flaky.png");
    await runImageIntegrity("test", { ...fast, now: day(1) });
    answers.set("/flaky.png", { status: 503 });
    await runImageIntegrity("test", { ...fast, now: day(2) });
    expect((await asset(p.asset.id)).enrichmentStatus).toBe("ENRICHED");
    // Second consecutive failure: FAILED.
    r = await runImageIntegrity("test", { ...fast, now: day(3) });
    expect(r.failed).toBe(1);
    const a = await asset(p.asset.id);
    expect(a.enrichmentStatus).toBe("FAILED");
    expect(a.failureReason).toMatch(/HTTP 503 \(unreachable on 2 consecutive checks\)/);
  });

  it("429: the rest of that host is skipped for the run (and checked next run); other hosts continue", async () => {
    const a1 = await page({ url: `${base}/r1.png` });
    const a2 = await page({ url: `${base}/r2.png` });
    const other = await page({ url: `${altBase}/o.png` });
    answers.set("/r1.png", { status: 429 });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r.rateLimitedHosts).toEqual(["127.0.0.1"]);
    expect(r.skippedRateLimited).toBe(2);
    expect(r.ok).toBe(1);
    expect(hits.filter((h) => h.path === "/r2.png")).toHaveLength(0);
    for (const x of [a1, a2, other]) expect((await asset(x.asset.id)).enrichmentStatus).toBe("ENRICHED");
    // Not marked checked: both are due again on the next run, even within 20 h.
    answers.delete("/r1.png");
    const next = await runImageIntegrity("test", { ...fast, now: new Date(day(0).getTime() + 60_000) });
    expect(next).toMatchObject({ checked: 2, ok: 2, skippedRecent: 1 });
  });

  it("a recovered URL is restored; images failed for other reasons are never touched", async () => {
    const p = await page({ url: `${base}/back.png` });
    answers.set("/back.png", { status: 410 });
    await runImageIntegrity("test", { ...fast, now: day(0) });
    expect((await asset(p.asset.id)).enrichmentStatus).toBe("FAILED");
    answers.delete("/back.png");
    const r = await runImageIntegrity("test", { ...fast, now: day(1) });
    expect(r.restored).toBe(1);
    const a = await asset(p.asset.id);
    expect(a).toMatchObject({ enrichmentStatus: "ENRICHED", failureReason: null });
    expect((await buildPageRenderModel(p.review.id)).image?.url).toBe(`${base}/back.png`);
    expect((await db.auditLog.findMany({ where: { entityId: p.asset.id }, orderBy: { createdAt: "asc" } })).map((x) => x.action)).toEqual(["image.integrity.failed", "image.integrity.restored"]);

    const other = await page({ enrichmentStatus: "FAILED", failureReason: "Content API image unusable: HTTP 404" });
    await runImageIntegrity("test", { ...fast, now: day(2) });
    expect((await asset(other.asset.id)).failureReason).toBe("Content API image unusable: HTTP 404");
    expect(hits.some((h) => h.path === `/img/${n}.png`)).toBe(false);
  });

  it("caps the run at IMAGE_INTEGRITY_PER_RUN and checks never-checked images first", async () => {
    for (let i = 0; i < 3; i++) await page();
    const r = await runImageIntegrity("test", { ...fast, limit: 2, now: day(0) });
    expect(r).toMatchObject({ candidates: 3, checked: 2, remaining: 1 });
    const r2 = await runImageIntegrity("test", { ...fast, limit: 2, now: new Date(day(0).getTime() + 60_000) });
    expect(r2).toMatchObject({ checked: 1, skippedRecent: 2 });
    const state = await db.automationSetting.findUniqueOrThrow({ where: { key: INTEGRITY_STATE_KEY } });
    expect(Object.keys(JSON.parse(state.value).assets)).toHaveLength(3);
  });

  it("a Commons group shot is FAILED as not the exact product (no request needed) and never restored by a URL check", async () => {
    const url = "https://upload.wikimedia.org/wikipedia/commons/e/e5/SAMSUNG_Galaxy_Z_Fold_8_Ultra%2C_SAMSUNG_Galaxy_Z_Fold_8_%26_SAMSUNG_Galaxy_Z_Flip_8.jpg";
    const p = await page({ url, sourceType: "WIKIMEDIA_COMMONS", productName: "Galaxy Z Fold 8 Ultra", brand: "Samsung" });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r.notExact).toBe(1);
    const a = await asset(p.asset.id);
    expect(a.enrichmentStatus).toBe("FAILED");
    expect(a.failureReason?.startsWith(NOT_EXACT_REASON)).toBe(true);
    expect(hits).toHaveLength(0);
    const again = await runImageIntegrity("test", { ...fast, now: day(1) });
    expect(again.restored).toBe(0);
    expect((await asset(p.asset.id)).enrichmentStatus).toBe("FAILED");
  });

  it("a Commons photo found by its file title that does not name this exact product is FAILED; a file without a readable Commons title gets only the URL check", async () => {
    const url = "https://upload.wikimedia.org/wikipedia/commons/4/4b/Google_Pixel_Fold_in_Shibuya_Stream_11.jpg";
    const byTitle = await page({ url, sourceType: "WIKIMEDIA_COMMONS", productName: "Pixel 11", brand: "Google" });
    const ok = await page({ url: `${base}/img/IMG_0001.jpg`, sourceType: "WIKIMEDIA_COMMONS", productName: "Pixel 11", brand: "Google" });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r.notExact).toBe(1);
    expect((await asset(byTitle.asset.id)).failureReason).toMatch(/does not name this exact product/);
    // Not an upload.wikimedia.org URL: no title to judge, only the URL check applies.
    expect((await asset(ok.asset.id)).enrichmentStatus).toBe("ENRICHED");
  });

  it("a Commons photo identity-matched through a Wikidata image fact is not judged by its file title (only group shots are rejected)", async () => {
    // The file is served by the local stub (no real network); its Commons title comes from the file page.
    const url = `${base}/img/IMG_20250101_phone.jpg`;
    const filePage = "https://commons.wikimedia.org/wiki/File:IMG_20250101_phone.jpg";
    const p = await page({ url, sourceType: "WIKIMEDIA_COMMONS", productName: "Pixel 11", brand: "Google" });
    await db.imageAsset.update({ where: { id: p.asset.id }, data: { sourcePageUrl: filePage } });
    const entity = await db.productEntity.create({ data: { slug: "pixel-11", name: "Pixel 11", matchKey: "google pixel 11" } });
    await db.productFact.create({ data: { productEntityId: entity.id, field: "image", value: url, unit: "CC BY-SA 4.0", source: "WIKIDATA", sourceName: "Wikimedia Commons", sourceKey: filePage, sourceUrl: filePage, observedAt: new Date(), matchBasis: "wikidata:gtin" } });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r).toMatchObject({ notExact: 0, ok: 1 });
    expect((await asset(p.asset.id)).enrichmentStatus).toBe("ENRICHED");
  });

  it("admin re-check runs now (inside the 20 h window), audited as the admin; placeholders are not checkable", async () => {
    const p = await page({ url: `${base}/admin.png` });
    await runImageIntegrity("test", { ...fast, now: day(0) });
    answers.set("/admin.png", { status: 404 });
    const r = await recheckImageAsset(p.asset.id, { actor: "admin@example.com" }, new Date(day(0).getTime() + 60_000));
    expect(r.outcome).toBe("failed");
    expect((await db.auditLog.findFirstOrThrow({ where: { entityId: p.asset.id } })).actor).toBe("admin@example.com");
    const ph = await page({ sourceType: "PLACEHOLDER" });
    expect((await recheckImageAsset(ph.asset.id, { actor: "admin@example.com" })).outcome).toBe("not-checkable");
  });

  it("backfills data.productImages for older commerce products from their stored raw record", async () => {
    const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "www.acme.com" } });
    const runRow = await db.commerceRun.create({ data: { brandId: brand.id, purpose: "PRODUCT", actorId: "test-actor", trigger: "test", status: "SUCCEEDED" } });
    const pageUrl = "https://www.acme.com/p/widget";
    const raw = await db.commerceRawRecord.create({ data: { runId: runRow.id, url: pageUrl, purpose: "PRODUCT", contentHash: "h", payload: { url: pageUrl, jsonLd: [{ "@type": "Product", name: "Widget", image: "https://www.acme.com/widget.jpg" }] } } });
    const old = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: pageUrl, name: "Widget", observedAt: new Date(), lastRawId: raw.id, data: { product: { name: "Widget" } } } });
    const done = await db.commerceProduct.create({ data: { brandId: brand.id, canonicalUrl: "https://www.acme.com/p/other", name: "Other", observedAt: new Date(), lastRawId: raw.id, data: { productImages: [] } } });
    const r = await runImageIntegrity("test", { ...fast, now: day(0) });
    expect(r.productImages).toMatchObject({ checked: 1, filled: 1 });
    const data = (await db.commerceProduct.findUniqueOrThrow({ where: { id: old.id } })).data as { product: unknown; productImages: Array<{ src: string }> };
    expect(data.product).toEqual({ name: "Widget" });
    expect(data.productImages.map((i) => i.src)).toEqual(["https://www.acme.com/widget.jpg"]);
    expect(((await db.commerceProduct.findUniqueOrThrow({ where: { id: done.id } })).data as { productImages: unknown[] }).productImages).toEqual([]);
    expect((await runImageIntegrity("test", { ...fast, now: day(1) })).productImages.checked).toBe(0);
  });
});

describe("Admin → Images counts", () => {
  it("counts published pages by bucket", async () => {
    await page();
    await page({ enrichmentStatus: "FAILED", failureReason: "image-integrity: HTTP 404" });
    await page({ sourceType: "PLACEHOLDER" });
    await page({ sourceType: "WIKIMEDIA_COMMONS", url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Acme_Thing.jpg" });
    await page({ status: "QUEUED" });
    await db.normalizedReview.create({ data: { source: "test", sourceId: "noimg", dedupeKey: "noimg", canonicalTitle: "No image", slug: "no-image", productName: "No image", summary: "s", body: "b", status: "PUBLISHED" } });
    const c = await loadImageCounts();
    expect(c).toMatchObject({ published: 5, missing: 1, failed: 1, placeholder: 1, lowConfidence: 2, verifiedExact: 0, categoryFallback: 1 });
  });
});
