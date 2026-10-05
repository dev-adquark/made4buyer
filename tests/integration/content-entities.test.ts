import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addContentEntity,
  removeContentEntity,
  setContentKind,
} from "@/lib/admin/content-entities";
import { sourceHealth } from "@/lib/admin/source-health";
import { runIntegrityChecks } from "@/lib/ops/integrity";
import { runReclassify } from "@/lib/jobs/reclassify";
import { runIngestion } from "@/lib/pipeline/ingest";
import { processReview } from "@/lib/pipeline/process";
import { evaluateQa, publishReview } from "@/lib/pipeline/publish";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { searchProducts, searchReviews } from "@/lib/public/queries";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE articles (fictional text) exercising the multi-product model through the real pipeline.
const body = (topic: string) =>
  `${topic}. We compare pricing, performance, setup and day-to-day use for teams of different sizes. ` +
  "Each option has trade-offs: one is faster to start with, another scales better, and the third is cheaper at volume. ".repeat(
    3,
  );
const item = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  title,
  summary: `${title}: what buyers should know before choosing.`,
  body: body(title),
  url: `https://reviews.example.com/${id}`,
  publishedAt: "2026-09-20T10:00:00Z",
  ...extra,
});
const ctx = { actor: "editor@example.com" };

let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({
    SOVRN_API_URL: undefined,
    PEXELS_API_KEY: undefined,
    IMAGE_ENRICHMENT_URL: undefined,
  });
});
afterAll(() => restore());
beforeEach(() => resetDb());

const ingest = (items: unknown[]) =>
  runIngestion({ trigger: "test", items, source: "sample-fixture" });

describe("multi-product content", () => {
  it("files 'A vs B vs C' as a COMPARISON of three products, passes QA and skips single-product offers", async () => {
    await ingest([
      item(
        "c1",
        "tmux vs Zellij vs WezTerm (2026): terminal multiplexers for developers",
      ),
    ]);
    const r = await db.normalizedReview.findFirstOrThrow({
      include: {
        contentEntities: {
          include: { entity: true },
          orderBy: { position: "asc" },
        },
      },
    });
    expect(r.kind).toBe("COMPARISON");
    expect(r.productName).toBe("tmux vs Zellij vs WezTerm");
    expect(r.contentEntities.map((c) => [c.entity.name, c.role])).toEqual([
      ["tmux", "COMPARED"],
      ["Zellij", "COMPARED"],
      ["WezTerm", "COMPARED"],
    ]);
    const qa = await evaluateQa(r.id);
    expect(qa.map((q) => q.code)).not.toContain("ENTITIES_NEED_REVIEW");
    expect(qa.map((q) => q.code)).not.toContain("COMPARISON_ENTITIES_MISSING");
    expect(r.dealStatus).toBe("NO_MATCH");
    // The three products inherit the article's category.
    expect(
      r.contentEntities.every((c) => c.entity.categorySlug === r.categorySlug),
    ).toBe(true);
  });

  it("resolves spelling variants to one product shared across articles", async () => {
    await ingest([
      item("a1", "NordVPN vs Surfshark: which VPN is better for streaming?"),
      item("a2", "Nord VPN vs ExpressVPN (2026): speed and privacy compared"),
    ]);
    const nord = await db.productEntity.findMany({
      where: { matchKey: "nordvpn" },
      include: { _count: { select: { content: true } } },
    });
    expect(nord).toHaveLength(1);
    expect(nord[0]._count.content).toBe(2);
    // Articles in one batch are processed concurrently: whichever spelling arrives first becomes
    // the display name and the other an alias. Both must be on the one record.
    expect([nord[0].name, ...nord[0].aliases].sort()).toEqual(["Nord VPN", "NordVPN"]);
    // Search finds content through the product and its alias.
    for (const r of await db.normalizedReview.findMany())
      await publishReview(r.id, ctx, "admin").catch(() => undefined);
    await db.normalizedReview.updateMany({
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    expect((await searchReviews("Nord VPN")).length).toBe(2);
    expect(
      (await searchReviews("vpn", 30, { type: "COMPARISON" })).length,
    ).toBe(2);
    expect((await searchReviews("vpn", 30, { type: "REVIEW" })).length).toBe(0);
    const found = await searchProducts("nordvpn");
    expect(found).toHaveLength(1);
    expect(["NordVPN", "Nord VPN"]).toContain(found[0].name);
  });

  it("keeps editor links on reprocessing and never re-adds a removed product", async () => {
    await ingest([
      item("e1", "Doppler vs Infisical vs 1Password Secrets 2026"),
    ]);
    const r = await db.normalizedReview.findFirstOrThrow();
    const onePw = await db.productEntity.findFirstOrThrow({
      where: { name: "1Password Secrets" },
    });
    await removeContentEntity(r.id, onePw.id, ctx);
    await addContentEntity(
      r.id,
      { name: "HashiCorp Vault", role: "COMPARED" },
      ctx,
    );
    await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
    const names = (
      await db.contentEntity.findMany({
        where: { normalizedReviewId: r.id },
        include: { entity: true },
      })
    )
      .map((c) => c.entity.name)
      .sort();
    expect(names).toEqual(["Doppler", "HashiCorp Vault", "Infisical"]);
    const model = await buildPageRenderModel(r.id);
    expect(model.products.map((p) => p.name)).toContain("HashiCorp Vault");
    expect(model.rating).toBeNull();
    expect(
      await db.auditLog.count({
        where: {
          action: { in: ["content.entity.add", "content.entity.remove"] },
        },
      }),
    ).toBe(2);
  });

  it("lets an editor override the content kind, and a comparison without two products is held in QA", async () => {
    await ingest([item("k1", "The 7 Best VPNs for Streaming in 2026")]);
    const r = await db.normalizedReview.findFirstOrThrow();
    expect(r.kind).toBe("BUYING_GUIDE");
    await setContentKind(r.id, "COMPARISON", ctx);
    await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
    expect(
      (await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } }))
        .kind,
    ).toBe("COMPARISON");
    expect((await evaluateQa(r.id)).map((q) => q.code)).toContain(
      "COMPARISON_ENTITIES_MISSING",
    );
    await setContentKind(r.id, null, ctx);
    await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
    expect(
      (await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } }))
        .kind,
    ).toBe("BUYING_GUIDE");
  });

  it("links a confident single-product review to one PRIMARY product", async () => {
    await ingest([
      item(
        "p1",
        "Sony WH-1000XM6 review: the best noise cancelling headphones",
        { productName: "Sony WH-1000XM6", brand: "Sony" },
      ),
    ]);
    const links = await db.contentEntity.findMany({
      include: { entity: true },
    });
    expect(links.map((l) => [l.entity.name, l.role])).toEqual([
      ["Sony WH-1000XM6", "PRIMARY"],
    ]);
  });
});

describe("reclassify-content", () => {
  it("re-runs classification without changing publish state, and is repeatable", async () => {
    await ingest([
      item("r1", "Neon vs Supabase Postgres 2026: Which Should You Choose?"),
      item("r2", "NordVPN review: fast, private and easy to use", {
        productName: "NordVPN",
      }),
    ]);
    await db.normalizedReview.updateMany({
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    const first = await runReclassify("test");
    expect(first).toMatchObject({ status: "OK", checked: 2, failed: 0 });
    expect(
      await db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    ).toBe(2);
    const vpn = await db.normalizedReview.findFirstOrThrow({
      where: { productName: "NordVPN" },
    });
    expect(vpn.categorySlug).toBe("security-software");
    const second = await runReclassify("test");
    expect(second).toMatchObject({ checked: 2, changed: 0, failed: 0 });
  });
});

describe("source health counts and integrity", () => {
  it("counts a source's articles by state and reports a clean integrity audit", async () => {
    const src = await db.reviewSource.create({
      data: {
        slug: "example",
        name: "Example",
        homepageUrl: "https://example.com/",
        allowedDomains: ["example.com"],
        startUrls: ["https://example.com/r"],
        reviewUrlPatterns: ["https://example.com/r/**"],
      },
    });
    await runIngestion({
      trigger: "test",
      items: [
        item("s1", "Cursor vs Windsurf (2026): AI editor comparison"),
        item("s2", "Vercel vs Netlify (2026)"),
      ],
      source: "apify:example",
    });
    const h = (await sourceHealth([src.id])).get(src.id)!;
    expect(h.inQa + h.published).toBe(2);
    const integrity = await runIntegrityChecks();
    expect(integrity.checks.duplicateSourceUrls.count).toBe(0);
    expect(integrity.checks.publishedInvalidCategory.count).toBe(0);
  });
});

describe("entity resolution under concurrency", () => {
  it("resolves the same product from parallel workers to one record", async () => {
    const { resolveEntity } = await import("@/lib/entities/resolve");
    const results = await Promise.all(
      ["NordVPN", "Nord VPN", "nordvpn", "NORD VPN", "Nord-VPN", "NordVPN"].map(
        (n) => resolveEntity(n),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.productEntity.count()).toBe(1);
  });
});
