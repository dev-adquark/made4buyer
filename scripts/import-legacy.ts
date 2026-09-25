/**
 * One-off migration from the legacy `db push` schema ("Review", "Deal", "AnalyticsEvent",
 * "SponsoredPlacement" tables) into the RealTech Review Engine schema. Legacy tables are
 * read-only here and are never dropped.
 *
 *   npm run legacy:import            # report what would be imported
 *   npm run legacy:import -- --apply # import
 *
 * - Each legacy Review becomes a ContentItem (source "legacy") and is re-run through the
 *   full pipeline; its slug and original publishedAt are preserved.
 * - Legacy PUBLISHED reviews are re-published through the QA gates. Reviews that fail QA
 *   are listed and stay in the QA queue (they are not force-published).
 * - Legacy Deal rows are NOT imported as verified: offers are re-matched via Sovrn and
 *   links re-verified, because the legacy boolean carried no verification evidence.
 * - Analytics events are copied (review_view → page_view, compare → comparison).
 * - Sponsored placements are copied disabled.
 */
import "./support/load-env";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { processContentItem } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { sha256, stableStringify } from "@/lib/util/text";

type LegacyReview = {
  id: string; sourceId: string; title: string; slug: string; summary: string; body: string; productName: string | null; brand: string | null; category: string;
  subcategory: string | null; imageUrl: string | null; imageLicense: string | null; imageAttribution: string | null; sourceUrl: string | null; canonicalUrl: string | null;
  status: string; publishedAt: Date | null; createdAt: Date;
};

async function tableExists(name: string) {
  const rows = await db.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${name}) AS "exists"`;
  return Boolean(rows[0]?.exists);
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!(await tableExists("Review"))) {
    console.log("No legacy \"Review\" table found — nothing to import.");
    return;
  }
  const reviews = await db.$queryRawUnsafe<LegacyReview[]>(`SELECT * FROM "Review" ORDER BY "createdAt" ASC`);
  console.log(`Legacy reviews: ${reviews.length} (${reviews.filter((r) => r.status === "PUBLISHED").length} published)`);
  if (!apply) {
    console.log("Dry run. Re-run with --apply to import.");
    return;
  }
  const counters = { totalFetched: 0, normalized: 0, duplicate: 0, unchanged: 0, updated: 0, failedNormalization: 0, queued: 0, failure: 0, reasons: {}, duplicates: [] };
  const report: Array<{ slug: string; result: string }> = [];
  for (const r of reviews) {
    const raw = { id: r.sourceId, title: r.title, summary: r.summary, body: r.body, productName: r.productName ?? undefined, brand: r.brand ?? undefined, category: r.category, subcategory: r.subcategory ?? undefined, url: r.sourceUrl ?? undefined, canonicalUrl: r.canonicalUrl ?? undefined, imageUrl: r.imageUrl ?? undefined, imageLicense: r.imageLicense ?? undefined, imageAttribution: r.imageAttribution ?? undefined, publishedAt: (r.publishedAt ?? r.createdAt).toISOString() };
    const item = await db.contentItem.upsert({
      where: { source_sourceId: { source: "legacy", sourceId: r.sourceId } },
      create: { source: "legacy", sourceId: r.sourceId, sourceUrl: r.sourceUrl, rawPayload: raw as Prisma.InputJsonValue, contentHash: sha256(stableStringify(raw)), processingStatus: "INGESTED", statusReason: `imported from legacy Review ${r.id}` },
      update: {},
    });
    await processContentItem(item.id, counters);
    const review = await db.normalizedReview.findUnique({ where: { source_sourceId: { source: "legacy", sourceId: r.sourceId } } });
    if (!review) {
      report.push({ slug: r.slug, result: "not imported (duplicate or invalid — see content_items)" });
      continue;
    }
    const slugTaken = await db.normalizedReview.findUnique({ where: { slug: r.slug }, select: { id: true } });
    if (!slugTaken || slugTaken.id === review.id) await db.normalizedReview.update({ where: { id: review.id }, data: { slug: r.slug, publishedAt: r.publishedAt } });
    if (r.status === "PUBLISHED") {
      const res = await publishReview(review.id, { actor: "legacy-import" }, "admin");
      report.push({ slug: r.slug, result: res.ok ? "published" : `QA failed: ${res.failures.map((f) => f.code).join(", ")}` });
    } else report.push({ slug: r.slug, result: `imported as ${review.status}` });
  }

  if (await tableExists("AnalyticsEvent")) {
    const events = await db.$queryRawUnsafe<Array<{ event: string; category: string | null; sessionId: string | null; metadata: unknown; createdAt: Date }>>(`SELECT "event","category","sessionId","metadata","createdAt" FROM "AnalyticsEvent"`);
    const map: Record<string, string> = { review_view: "page_view", compare: "comparison" };
    await db.analyticsEvent.createMany({ data: events.map((e) => ({ event: map[e.event] ?? e.event, categorySlug: null, sessionId: e.sessionId, metadata: { legacy: true, legacyCategory: e.category } as Prisma.InputJsonValue, createdAt: e.createdAt })) });
    console.log(`Analytics events copied: ${events.length}`);
  }
  if (await tableExists("SponsoredPlacement")) {
    const rows = await db.$queryRawUnsafe<Array<{ title: string; label: string; url: string; minEvents: number; minSessions: number; startAt: Date | null; endAt: Date | null }>>(`SELECT * FROM "SponsoredPlacement"`);
    for (const p of rows) {
      await db.sponsoredPlacement.create({ data: { title: p.title, label: p.label, url: p.url, advertiser: "Legacy placement", disclosure: "Paid placement.", position: "HOME_HERO", enabled: false, startAt: p.startAt, endAt: p.endAt, minMonthlyPageViews: Math.max(1, p.minEvents), minMonthlySessions: Math.max(1, p.minSessions) } });
    }
    console.log(`Sponsored placements copied (disabled): ${rows.length}`);
  }
  console.table(report);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
