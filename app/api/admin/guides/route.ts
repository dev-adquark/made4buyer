import { adminAction, field } from "@/lib/admin/route";
import { resolveCategorySlug } from "@/lib/admin/overrides";
import { db } from "@/lib/db";
import { LockHeldError } from "@/lib/jobs/lock";
import { AI_GUIDE_SOURCE, aiGuidesConfigured, generateGuide } from "@/lib/pipeline/ai-guides";
import { runIngestion } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { AUTOMATION_APPROVER } from "@/lib/automation/daily-article";
import { audit } from "@/lib/security/audit";
import { dbRateLimit } from "@/lib/security/rate-limit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Generates one AI-assisted guide draft and runs it through the full pipeline into the QA queue. */
export const POST = adminAction("/admin/guides", async ({ form, ctx }) => {
  if (!aiGuidesConfigured()) return { error: "Keyword-to-Blog is not configured (KEYWORD_TO_BLOG_API_URL / KEYWORD_TO_BLOG_API_KEY)" };
  const productName = field(form, "productName");
  const brand = field(form, "brand") || undefined;
  const categoryRaw = field(form, "category");
  const keywords = field(form, "keywords").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 8);
  if (productName.length < 2 || productName.length > 120) return { error: "Product name is required (2–120 characters)" };
  if (!keywords.length || keywords.some((k) => k.length > 80)) return { error: "Enter 1–8 comma-separated keywords (max 80 characters each)" };
  const category = categoryRaw ? resolveCategorySlug(categoryRaw) : undefined;
  if (categoryRaw && !category) return { error: "Unknown category" };
  const limit = await dbRateLimit(`guides:${ctx.actor}`, 20, 60 * 60_000);
  if (!limit.allowed) return { error: "Generation limit reached (20 per hour). Try again later." };

  const { item, response } = await generateGuide({ productName, brand, category: category ? CATEGORY_BY_SLUG.get(category)!.name : undefined, keywords, topic: field(form, "topic") || undefined, audience: field(form, "audience") || undefined });
  try {
    const run = await runIngestion({ trigger: `admin-generate:${ctx.actor}`, items: [item], source: AI_GUIDE_SOURCE, ctx });
    const review = await db.normalizedReview.findUnique({ where: { source_sourceId: { source: AI_GUIDE_SOURCE, sourceId: item.id } }, select: { id: true } });
    await audit(ctx, { action: "guide.generate", entityType: "normalized_review", entityId: review?.id ?? item.id, metadata: { productName, keywords, requestId: response.requestId, quality: response.quality, runId: run.runId } });
    if (!review) return { error: `Guide was generated but not stored (${Object.keys(run.reasons).join(", ") || run.status}). See Ingestion.` };
    // Direct publish: a successful generation goes live as returned (no QA gate), recorded and labelled.
    await db.normalizedReview.update({ where: { id: review.id }, data: { editorApprovedAt: new Date(), editorApprovedBy: AUTOMATION_APPROVER } });
    const published = await publishReview(review.id, ctx, "admin", { skipQa: true });
    await audit(ctx, { action: "guide.direct_publish", entityType: "normalized_review", entityId: review.id, metadata: { productName, keywords } });
    return published.ok ? { redirect: `/admin/reviews/${review.id}`, ok: "Generated and published." } : { error: `Generated, but publishing failed: ${published.failures.map((f) => f.code).join(", ")}` };
  } catch (error) {
    if (error instanceof LockHeldError) return { error: "An ingestion run is in progress; try again in a minute." };
    throw error;
  }
});
