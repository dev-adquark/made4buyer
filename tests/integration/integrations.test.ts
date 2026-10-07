import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAffiliateLinks } from "@/lib/affiliate/apply";
import { db } from "@/lib/db";
import { integrationReadiness } from "@/lib/ops/live-check";
import { runIngestion } from "@/lib/pipeline/ingest";
import { offerUrl } from "@/lib/public/offers";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";
import { miniStub, type StubReply } from "../support/mini-stub";

const AFF_CLEAR = { AFFILIATE_PROVIDER: undefined, AMAZON_ASSOCIATES_TAG: undefined, SKIMLINKS_PUBLISHER_ID: undefined, IMPACT_ACCOUNT_SID: undefined };

let reply: () => StubReply = () => ({ body: { items: [] } });
let stub: Awaited<ReturnType<typeof miniStub>>;
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await miniStub(() => reply());
  restore = withEnv({ ...AFF_CLEAR, CONTENT_API_URL: `${stub.base}/feed`, CONTENT_API_KEY: "readiness-secret-value-123", CONTENT_API_SOURCE_NAME: "contract-feed", CONTENT_API_MAX_RETRIES: "0", AUTO_PUBLISH_ENABLED: "false" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

describe("Content API schema mismatch is admin-visible", () => {
  it("fails the run with CONTENT_API_SCHEMA_MISMATCH, records a failure, and Integrations shows ERROR", async () => {
    reply = () => ({ body: { schemaVersion: "2", items: [{ id: "x", title: "A title that is long enough", body: "b".repeat(200) }] } });
    const summary = await runIngestion({ trigger: "test" });
    expect(summary.status).toBe("FAILED");
    expect(summary.reasons).toMatchObject({ CONTENT_API_SCHEMA_MISMATCH: 1 });
    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(run.failureReasonSummary).toMatchObject({ CONTENT_API_SCHEMA_MISMATCH: 1, message: expect.stringMatching(/schema mismatch.*version 2/) });
    const failure = await db.pipelineFailure.findFirstOrThrow({ where: { stage: "CONTENT_FETCH", errorCode: "CONTENT_API_SCHEMA_MISMATCH" } });
    expect(failure.message).toMatch(/schema mismatch/);

    const rows = await integrationReadiness();
    const content = rows.find((r) => r.key === "contentApi")!;
    expect(content).toMatchObject({ status: "ERROR", missingEnv: [], lastError: { message: expect.stringMatching(/^CONTENT_API_SCHEMA_MISMATCH/) } });
    expect(JSON.stringify(rows)).not.toContain("readiness-secret-value-123");

    // A good run afterwards clears the error.
    reply = () => ({ body: { schemaVersion: "1", items: [] } });
    expect((await runIngestion({ trigger: "test" })).status).toBe("COMPLETED");
    expect((await integrationReadiness()).find((r) => r.key === "contentApi")).toMatchObject({ status: "READY", lastError: null, lastSuccessAt: expect.any(String) });
  });
});

describe("Integrations readiness", () => {
  it("lists every integration with exact missing env var names, never values", async () => {
    const r = withEnv({ PEXELS_API_KEY: undefined, GSC_SITE_URL: undefined, GSC_SERVICE_ACCOUNT_JSON: undefined, KEYWORD_TO_BLOG_API_URL: undefined, KEYWORD_TO_BLOG_API_KEY: undefined, APIFY_API_TOKEN: undefined, CRON_SECRET: undefined });
    const rows = await integrationReadiness();
    r();
    expect(rows.map((x) => x.key)).toEqual(["contentApi", "apify", "pexels", "keywordToBlog", "affiliate", "gsc", "analytics", "cron"]);
    const by = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(by.apify).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", missingEnv: ["APIFY_API_TOKEN"] });
    expect(by.pexels).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", missingEnv: ["PEXELS_API_KEY"] });
    expect(by.keywordToBlog.missingEnv).toEqual(["KEYWORD_TO_BLOG_API_URL", "KEYWORD_TO_BLOG_API_KEY"]);
    expect(by.gsc.missingEnv).toEqual(["GSC_SITE_URL", "GSC_SERVICE_ACCOUNT_JSON"]);
    expect(by.affiliate).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", missingEnv: ["AFFILIATE_PROVIDER"] });
    expect(by.cron).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", missingEnv: ["CRON_SECRET"] });
    expect(by.analytics.status).toBe("READY");
  });

  it("flags an unknown AFFILIATE_PROVIDER as ERROR and a provider with missing variables as BLOCKED", async () => {
    let r = withEnv({ AFFILIATE_PROVIDER: "amazn" });
    expect((await integrationReadiness()).find((x) => x.key === "affiliate")).toMatchObject({ status: "ERROR", lastError: { message: expect.stringContaining("amazn") } });
    r();
    r = withEnv({ AFFILIATE_PROVIDER: "skimlinks" });
    expect((await integrationReadiness()).find((x) => x.key === "affiliate")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", missingEnv: ["SKIMLINKS_PUBLISHER_ID", "SKIMLINKS_SITE_ID", "SKIMLINKS_CLIENT_ID", "SKIMLINKS_CLIENT_SECRET"] });
    r();
  });
});

describe("affiliate links on CommerceOffer", () => {
  async function offers() {
    const product = await db.commerceProduct.create({ data: { canonicalUrl: "https://www.amazon.com/dp/B0TESTASIN", name: "Test product", observedAt: new Date() } });
    const amazon = await db.commerceOffer.create({ data: { productId: product.id, seller: "Amazon", sellerType: "RETAILER", destinationUrl: "https://www.amazon.com/Test-Product/dp/B0TESTASIN", observedAt: new Date() } });
    const other = await db.commerceOffer.create({ data: { productId: product.id, seller: "Brand", sellerType: "MANUFACTURER", destinationUrl: "https://brand.example.com/p/1", observedAt: new Date() } });
    return { amazon, other };
  }

  it("stores provider links only for supported destinations, keeps the plain link otherwise, and reverts when the provider is removed", async () => {
    const { amazon, other } = await offers();
    let r = withEnv({ AFFILIATE_PROVIDER: "amazon", AMAZON_ASSOCIATES_TAG: "made4buyerstest-20" });
    const result = await runAffiliateLinks("test");
    expect(result).toMatchObject({ status: "OK", provider: "amazon", checked: 2, affiliated: 1, notAffiliatable: 1, unavailable: 0 });
    const a = await db.commerceOffer.findUniqueOrThrow({ where: { id: amazon.id } });
    expect(a).toMatchObject({ affiliateStatus: "AFFILIATED", affiliateProvider: "amazon", affiliateUrl: "https://www.amazon.com/dp/B0TESTASIN?tag=made4buyerstest-20", destinationUrl: amazon.destinationUrl });
    expect(offerUrl(a)).toEqual({ url: a.affiliateUrl, affiliated: true });
    const o = await db.commerceOffer.findUniqueOrThrow({ where: { id: other.id } });
    expect(o).toMatchObject({ affiliateStatus: "NOT_AFFILIATABLE", affiliateUrl: null });
    expect(offerUrl(o)).toEqual({ url: other.destinationUrl, affiliated: false });

    // Idempotent: nothing left to do on the next run.
    expect((await runAffiliateLinks("test")).checked).toBe(0);
    expect((await integrationReadiness()).find((x) => x.key === "affiliate")).toMatchObject({ status: "READY", lastSuccessAt: expect.any(String) });
    r();

    r = withEnv({ AFFILIATE_PROVIDER: "none" });
    expect(await runAffiliateLinks("test")).toMatchObject({ status: "NOT_CONFIGURED", reverted: 2 });
    expect(await db.commerceOffer.count({ where: { affiliateUrl: { not: null } } })).toBe(0);
    r();
  });
});
