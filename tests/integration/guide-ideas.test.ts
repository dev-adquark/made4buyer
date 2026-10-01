import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runGuideGeneration } from "@/lib/pipeline/guide-ideas";
import { runIngestion } from "@/lib/pipeline/ingest";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only (local stub + fixtures).
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_SOURCE_NAME: "sample-fixture", SOVRN_API_URL: undefined, KEYWORD_TO_BLOG_API_URL: `${stub.base}/ktb/v1/generate`, KEYWORD_TO_BLOG_API_KEY: "test-ktb-key", GUIDE_AUTOGEN_ENABLED: "true", KEYWORD_TO_BLOG_DAILY_LIMIT: "2" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

describe("topic-only guide generation", () => {
  it("drafts original AI guides for reviewed products, within the daily cap, never approved or published", async () => {
    await runIngestion({ trigger: "test" });
    const first = await runGuideGeneration("test");
    expect(first).toMatchObject({ status: "OK", drafted: 2 });
    const guides = await db.normalizedReview.findMany({ where: { kind: "AI_GUIDE" } });
    expect(guides).toHaveLength(2);
    for (const g of guides) {
      expect(g.status).not.toBe("PUBLISHED");
      expect(g.editorApprovedAt).toBeNull();
    }
    // The cap holds across runs; a product never gets a second guide.
    const second = await runGuideGeneration("test");
    expect(second.results?.[0]).toMatchObject({ status: "DAILY_LIMIT" });
    expect(new Set(guides.map((g) => g.productName.toLowerCase())).size).toBe(2);
  });

  it("is off unless explicitly enabled", async () => {
    const r = withEnv({ GUIDE_AUTOGEN_ENABLED: undefined });
    expect(await runGuideGeneration("test")).toMatchObject({ status: "DISABLED" });
    r();
  });
});
