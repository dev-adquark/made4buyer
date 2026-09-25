import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { verifyLinkRecord } from "@/lib/pipeline/stages";
import { fetchSovrnOffers } from "@/lib/sovrn/client";
import { runLinkVerification } from "@/lib/jobs/revalidation";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({ sovrnKey: "sovrn-test" });
  restore = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_KEY: undefined, CONTENT_API_SOURCE_NAME: "sample-fixture", SOVRN_API_URL: `${stub.base}/sovrn`, SOVRN_API_KEY: "sovrn-test", SOVRN_SITE_KEY: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

describe("Sovrn adapter", () => {
  it("authenticates, caches successful responses and does not reuse errors", async () => {
    const q = { productName: "Pixel 10", brand: "Google", categorySlug: "phones" };
    const first = await fetchSovrnOffers(q);
    expect(first.status).toBe("OK");
    const calls = () => stub.requests.filter((r) => r.path.startsWith("/sovrn")).length;
    const n = calls();
    const second = await fetchSovrnOffers(q);
    expect(second).toMatchObject({ status: "OK", fromCache: true });
    expect(calls()).toBe(n);
    const cache = await db.sovrnOfferCache.findFirstOrThrow({ where: { queryKey: "Google Pixel 10" } });
    expect(cache.providerStatus).toBe("OK");
    expect(cache.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const r = withEnv({ SOVRN_API_KEY: "wrong" });
    const denied = await fetchSovrnOffers({ productName: "Galaxy S26 Ultra", brand: "Samsung" });
    r();
    expect(denied.status).toBe("PROVIDER_ERROR");
    const again = await fetchSovrnOffers({ productName: "Galaxy S26 Ultra", brand: "Samsung" });
    expect(again.status).toBe("OK");
  });

  it("reports BLOCKED_BY_ENVIRONMENT when unconfigured instead of inventing offers", async () => {
    const r = withEnv({ SOVRN_API_URL: undefined });
    const res = await fetchSovrnOffers({ productName: "Pixel 10" });
    r();
    expect(res.status).toBe("UNAVAILABLE");
  });
});

describe("offer matching → affiliate links → verification (full ingestion)", () => {
  it("matches, scores, links and verifies; unmatched and failing links stay honest", async () => {
    await runIngestion({ trigger: "test" });
    const reviews = await db.normalizedReview.findMany({ include: { offerMatches: true, affiliateLinks: true } });
    const by = (id: string) => reviews.find((r) => r.sourceId === id)!;

    const mba = by("s-001");
    expect(mba.dealStatus).toBe("MATCHED");
    const best = mba.offerMatches.find((m) => m.isBestOffer)!;
    expect(best.selectionReason).toMatch(/^Selected /);
    expect(best.scoreBreakdown).toHaveProperty("product");
    expect(mba.offerMatches.find((m) => m.offerId === "sv-mba-case")?.matchStatus).toBe("BELOW_THRESHOLD");
    const mbaBest = mba.affiliateLinks.find((l) => l.isBest)!;
    expect(mbaBest).toMatchObject({ generationMethod: "PROVIDER_DEEPLINK", verificationStatus: "VERIFIED_OK", isActive: true });
    expect(mbaBest.redirectChain).toHaveLength(2);
    expect(mbaBest.nextVerificationAt!.getTime()).toBeGreaterThan(Date.now());

    expect(by("s-006").dealStatus).toBe("NO_MATCH");
    expect(by("s-006").affiliateLinks).toHaveLength(0);
    expect(await db.pipelineFailure.count({ where: { errorCode: "SOVRN_NO_MATCH", normalizedReviewId: by("s-006").id } })).toBe(1);

    const anker = by("s-011").affiliateLinks.find((l) => l.isBest)!;
    expect(anker.verificationStatus).toBe("UNAVAILABLE");
    expect(anker.httpStatus).toBe(404);
    expect(await db.pipelineFailure.count({ where: { stage: "LINK_VERIFICATION", entityId: anker.id } })).toBe(1);
  });

  it("revalidation runs are recorded with counts and a reason breakdown", async () => {
    await runIngestion({ trigger: "test" });
    const res = await runLinkVerification({ trigger: "test", onlyDue: false, range: { start: new Date(Date.now() - 86_400_000), end: new Date() } });
    const run = await db.revalidationRun.findUniqueOrThrow({ where: { id: res.runId } });
    expect(run.checkedCount).toBe(res.checked);
    expect(run.checkedCount).toBeGreaterThan(0);
    expect(run.successCount + run.failureCount).toBe(run.checkedCount);
    expect(run.reasonBreakdown).toHaveProperty("VERIFIED_OK");
    expect(run.reasonBreakdown).toHaveProperty("UNAVAILABLE");
    expect(await db.analyticsEvent.count({ where: { event: "verification" } })).toBe(1);
  });

  it("blocks loopback verification when the test escape hatch is off (SSRF)", async () => {
    await runIngestion({ trigger: "test" });
    const link = await db.affiliateLink.findFirstOrThrow({ where: { verificationStatus: "VERIFIED_OK" } });
    const r = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: undefined });
    const { outcome } = await verifyLinkRecord(link);
    r();
    expect(outcome.status).toBe("BLOCKED");
    const again = await db.affiliateLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(again.verificationStatus).toBe("BLOCKED");
  });
});
