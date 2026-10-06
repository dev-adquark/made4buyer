import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { runAffiliateStage, type OfferStageResult } from "@/lib/pipeline/stages";
import { checkLink } from "@/lib/sovrn/link-check";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const SITE_KEY = "pub-site-key-test";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let server: http.Server;
let restore: () => void;
let reply: () => { status: number; body: string } = () => ({ status: 200, body: "{}" });
const checks: URL[] = [];

const answer = (affiliatable: boolean) => () => ({
  status: 200,
  body: JSON.stringify({ url: "x", optimized: `https://redirect.viglink.com?u=x&key=${SITE_KEY}`, affiliatable, competitive: null, optimizable: null, eepc: 0.05 }),
});

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({ sovrnKey: "sovrn-test" });
  server = http.createServer((req, res) => {
    checks.push(new URL(req.url ?? "/", "http://127.0.0.1"));
    const r = reply();
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  restore = withEnv({
    CONTENT_API_URL: `${stub.base}/content`,
    CONTENT_API_KEY: undefined,
    CONTENT_API_SOURCE_NAME: "sample-fixture",
    SOVRN_API_URL: `${stub.base}/sovrn`,
    SOVRN_API_KEY: "sovrn-test",
    SOVRN_SITE_KEY: SITE_KEY,
    SOVRN_LINK_CHECK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/link/`,
    SOVRN_LINK_CHECK_ENABLED: "false",
  });
});
afterAll(async () => {
  restore();
  await stub.close();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  checks.length = 0;
  await resetDb();
});

/** A real matched offer from the fixture run, re-shaped as a merchant URL without a provider deeplink (→ LINK_WRAPPER). */
async function wrappedSelection(): Promise<{ reviewId: string; selected: OfferStageResult["selected"] }> {
  await runIngestion({ trigger: "test" });
  const match = await db.sovrnOfferMatch.findFirstOrThrow({ where: { matchStatus: "MATCHED", isBestOffer: true }, orderBy: { offerId: "asc" } });
  const offer = { offerId: `${match.offerId}-wrapped`, title: "Wrapped merchant offer", offerUrl: "https://www.example-merchant.com/p/123" };
  return {
    reviewId: match.normalizedReviewId,
    selected: [{ matchId: match.id, ranked: { offer, breakdown: {} as OfferStageResult["selected"][number]["ranked"]["breakdown"], viable: true }, isBest: false }],
  };
}

describe("Sovrn Link Check (DB cache)", () => {
  it("records checks under linkcheck: and reuses a success", async () => {
    reply = answer(true);
    const first = await checkLink("https://www.example-merchant.com/p/1");
    expect(first).toMatchObject({ status: "OK", affiliatable: true, fromCache: false });
    const second = await checkLink("https://www.example-merchant.com/p/1");
    expect(second).toMatchObject({ status: "OK", affiliatable: true, fromCache: true });
    expect(checks).toHaveLength(1);
    const row = await db.sovrnOfferCache.findFirstOrThrow({ where: { queryKey: { startsWith: "linkcheck:" } } });
    expect(row).toMatchObject({ queryKey: "linkcheck:https://www.example-merchant.com/p/1", providerStatus: "OK", httpStatus: 200 });
  });
});

describe("affiliate stage gating", () => {
  it("does not create (and deactivates) a wrapped link Sovrn reports as not affiliatable", async () => {
    const { reviewId, selected } = await wrappedSelection();
    const offerId = selected[0].ranked.offer.offerId;
    const r = withEnv({ SOVRN_LINK_CHECK_ENABLED: "true" });
    try {
      reply = answer(true);
      const created = await runAffiliateStage(reviewId, selected);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ generationMethod: "LINK_WRAPPER", isActive: true });
      expect(checks).toHaveLength(1);

      // The site loses affiliation for that merchant: a fresh check (cache cleared) says no.
      await db.sovrnOfferCache.deleteMany({ where: { queryKey: { startsWith: "linkcheck:" } } });
      reply = answer(false);
      const after = await runAffiliateStage(reviewId, selected);
      expect(after).toHaveLength(0);
    } finally {
      r();
    }
    const link = await db.affiliateLink.findUniqueOrThrow({ where: { normalizedReviewId_sovrnOfferId: { normalizedReviewId: reviewId, sovrnOfferId: offerId } } });
    expect(link.isActive).toBe(false);
    const failure = await db.pipelineFailure.findFirstOrThrow({ where: { stage: "AFFILIATE_LINK", entityId: `${reviewId}:${offerId}` } });
    expect(failure).toMatchObject({ errorCode: "AFFILIATE_URL_INVALID", message: "Sovrn reports this merchant is not affiliatable for this site (link check)" });
  });

  it("keeps creating the link when the check itself fails (an outage never blocks)", async () => {
    const { reviewId, selected } = await wrappedSelection();
    const r = withEnv({ SOVRN_LINK_CHECK_ENABLED: "true" });
    try {
      reply = () => ({ status: 400, body: JSON.stringify({ status: 400, message: "bad", error: "Bad Request" }) });
      const links = await runAffiliateStage(reviewId, selected);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ generationMethod: "LINK_WRAPPER", isActive: true, verificationStatus: "PENDING" });
    } finally {
      r();
    }
  });

  it("does not call Sovrn when gating is off or the link is a provider deeplink", async () => {
    const { reviewId, selected } = await wrappedSelection();
    reply = answer(false);
    expect(await runAffiliateStage(reviewId, selected)).toHaveLength(1);
    const r = withEnv({ SOVRN_LINK_CHECK_ENABLED: "true" });
    try {
      const deeplinked = [{ ...selected[0], ranked: { ...selected[0].ranked, offer: { ...selected[0].ranked.offer, providerAffiliateUrl: "https://sovrn.co/abc123" } } }];
      const links = await runAffiliateStage(reviewId, deeplinked);
      expect(links).toHaveLength(1);
      expect(links[0].generationMethod).toBe("PROVIDER_DEEPLINK");
    } finally {
      r();
    }
    expect(checks).toHaveLength(0);
  });
});
