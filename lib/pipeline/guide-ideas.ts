import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { dbRateLimit } from "@/lib/security/rate-limit";
import { contentOpportunities, isTechCategory, type Opportunity } from "@/lib/content/calendar";
import { CATEGORY_BY_SLUG, DEPARTMENTS } from "@/lib/taxonomy/definitions";
import { AI_GUIDE_SOURCE, aiGuidesConfigured, generateGuide } from "./ai-guides";
import { recordFailure } from "./failures";
import { runIngestion } from "./ingest";

/**
 * Topics, not text. For products that real editorial reviews cover, ask Keyword-to-Blog for an
 * ORIGINAL buying guide. Only the product name, brand, category and buyer-intent keywords are
 * sent: no third-party review text ever goes to the AI. Results are AI-assisted guides that
 * still need an editor's approval before publishing (the existing QA gate).
 */

export function guideKeywords(productName: string, categoryName?: string): string[] {
  const base = [`${productName} worth buying`, `${productName} alternatives`, `${productName} vs`];
  return categoryName ? [...base, `best ${categoryName.toLowerCase()}`] : base;
}

/** Reviewed products (newest by source date) that have no AI guide yet. */
export async function guideCandidates(take: number) {
  const reviews = await db.normalizedReview.findMany({
    where: { kind: "REVIEW", status: { in: ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] } },
    orderBy: [{ sourcePublishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 200,
    select: { productName: true, brand: true, categorySlug: true },
  });
  const guides = await db.normalizedReview.findMany({ where: { kind: "AI_GUIDE" }, select: { productName: true } });
  const covered = new Set(guides.map((g) => g.productName.toLowerCase()));
  const out: typeof reviews = [];
  for (const r of reviews) {
    const key = r.productName.toLowerCase();
    if (covered.has(key)) continue;
    covered.add(key);
    out.push(r);
    if (out.length >= take) break;
  }
  return out;
}

/** What to ask Keyword-to-Blog for, per opportunity. Only names and intents: never source text. */
export function guideRequestFor(o: Opportunity) {
  const cat = CATEGORY_BY_SLUG.get(o.categorySlug);
  const dept = cat ? DEPARTMENTS.find((d) => d.slug === cat.department)?.name : undefined;
  const industry = cat ? (isTechCategory(cat) ? "consumer technology" : `consumer products: ${(dept ?? cat.name).toLowerCase()}`) : "consumer products";
  const audience = `shoppers choosing ${cat ? cat.name.toLowerCase() : "products"} before they buy`;
  if (o.kind === "CATEGORY_GUIDE") {
    const s = o.subject.toLowerCase();
    return { productName: o.subject, category: cat?.name, keywords: [`how to choose ${s}`, `${s} buying guide`, `best ${s}`], topic: `How to choose ${s}: what actually matters before you buy`, audience, industry };
  }
  return { productName: o.subject, brand: o.brand ?? undefined, category: cat?.name, keywords: guideKeywords(o.subject, cat?.name), audience, industry };
}

export async function runGuideGeneration(trigger: string) {
  if (!config.aiGuides.autoGenerate()) return { status: "DISABLED", reason: "GUIDE_AUTOGEN_ENABLED is not true" };
  if (!aiGuidesConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "Keyword-to-Blog is not configured" };
  const limit = config.aiGuides.dailyLimit();
  // The content calendar: real gaps first, balanced across categories (non-tech prioritised).
  const candidates = await contentOpportunities({ limit });
  const results: Array<{ product: string; key: string; status: string; reason?: string }> = [];
  for (const c of candidates) {
    // Daily cap shared across runs (bounded by the provider's plan quota).
    const slot = await dbRateLimit("guides:auto", limit, 24 * 3_600_000);
    if (!slot.allowed) {
      results.push({ product: c.subject, key: c.key, status: "DAILY_LIMIT" });
      break;
    }
    try {
      const { item } = await generateGuide(guideRequestFor(c));
      const run = await runIngestion({ trigger: `guides:${trigger}`, items: [item], source: AI_GUIDE_SOURCE });
      results.push({ product: c.subject, key: c.key, status: run.normalized ? "DRAFTED" : run.status });
    } catch (error) {
      const message = (error as Error).message;
      await recordFailure({ stage: "CONTENT_FETCH", code: "CONTENT_API_HTTP_ERROR", message: `Keyword-to-Blog (${c.key}): ${message}`, entityType: "job", entityId: "guide-generation" });
      results.push({ product: c.subject, key: c.key, status: "FAILED", reason: message });
      if (/limit|too many/i.test(message)) break;
    }
  }
  log.info("guide generation run", { stage: "CONTENT_FETCH", trigger, drafted: results.filter((r) => r.status === "DRAFTED").length });
  return { status: "OK", candidates: candidates.length, drafted: results.filter((r) => r.status === "DRAFTED").length, results };
}
