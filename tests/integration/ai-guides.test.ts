import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AI_GUIDE_SOURCE, generateGuide } from "@/lib/pipeline/ai-guides";
import { runIngestion } from "@/lib/pipeline/ingest";
import { evaluateQa, publishReview, runPublishCycle } from "@/lib/pipeline/publish";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";
import { sampleEnvironment } from "../support/pipeline";

let env: Awaited<ReturnType<typeof sampleEnvironment>>;
beforeAll(async () => {
  await seedTaxonomy();
  env = await sampleEnvironment();
});
afterAll(() => env.close());
beforeEach(() => resetDb());

describe("AI-assisted guides", () => {
  it("generates through the full pipeline, blocks publishing until an editor approves, and never presents a review", async () => {
    const { item } = await generateGuide({ productName: "MacBook Air 13 (M4)", brand: "Apple", keywords: ["macbook air", "student laptop"], topic: "Is the MacBook Air right for students" });
    await runIngestion({ trigger: "test", items: [item], source: AI_GUIDE_SOURCE });
    const guide = await db.normalizedReview.findUniqueOrThrow({ where: { source_sourceId: { source: AI_GUIDE_SOURCE, sourceId: item.id } }, include: { entities: true } });
    expect(guide.kind).toBe("AI_GUIDE");
    expect(guide.categorySlug).toBe("laptops");
    expect(guide.generationMeta).toMatchObject({ provider: "keyword-to-blog", model: "stub-model", qualityScore: 88 });
    expect(guide.entities?.rating).toBeNull();
    expect(guide.status).toBe("NEEDS_REVIEW");
    expect((await evaluateQa(guide.id)).map((f) => f.code)).toContain("AI_GUIDE_NEEDS_EDITOR_APPROVAL");

    const r = withEnv({ AUTO_PUBLISH_ENABLED: "true" });
    await runPublishCycle({ actor: "system" });
    r();
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: guide.id } })).status).not.toBe("PUBLISHED");
    expect((await publishReview(guide.id, { actor: "qa" })).ok).toBe(false);

    await db.normalizedReview.update({ where: { id: guide.id }, data: { editorApprovedAt: new Date(), editorApprovedBy: "editor" } });
    expect((await publishReview(guide.id, { actor: "qa" })).ok).toBe(true);
    const model = await buildPageRenderModel(guide.id);
    expect(model).toMatchObject({ kind: "AI_GUIDE", rating: null });
    expect(model.bodyParagraphs).toContain("## Who it suits");
  });

  it("reports provider auth failures without storing anything", async () => {
    const r = withEnv({ KEYWORD_TO_BLOG_API_KEY: "wrong" });
    await expect(generateGuide({ productName: "X Phone", keywords: ["x"] })).rejects.toThrow(/Invalid API key/);
    r();
    expect(await db.normalizedReview.count()).toBe(0);
  });
});
