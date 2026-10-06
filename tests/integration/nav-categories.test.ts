import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { publishReview, unpublishReview } from "@/lib/pipeline/publish";
import { filterNavCategories, nonEmptyCategorySlugs } from "@/lib/public/nav-categories";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { sampleEnvironment } from "../support/pipeline";

const admin = { actor: "admin@test" };
let env: Awaited<ReturnType<typeof sampleEnvironment>>;

beforeAll(async () => {
  await seedTaxonomy();
  env = await sampleEnvironment();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb();
  await runIngestion({ trigger: "test" });
});

const navSlugs = async () => filterNavCategories(CATEGORIES, await nonEmptyCategorySlugs()).map((c) => c.slug);

describe("navigation categories", () => {
  it("lists a category only once it has a PUBLISHED review, and drops it again when unpublished", async () => {
    const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-001" } });
    expect(r.categorySlug).toBeTruthy();
    // Ingested but unpublished content does not make any category visible.
    expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(0);
    expect(await navSlugs()).toEqual([]);

    expect((await publishReview(r.id, admin)).ok).toBe(true);
    expect(await navSlugs()).toEqual([r.categorySlug]);

    await unpublishReview(r.id, admin);
    expect(await navSlugs()).toEqual([]);
  });
});
