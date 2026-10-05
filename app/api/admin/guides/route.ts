import { adminAction, field } from "@/lib/admin/route";
import { resolveCategorySlug } from "@/lib/admin/overrides";
import { db } from "@/lib/db";
import { AI_GUIDE_SOURCE, aiGuidesConfigured, generateGuide } from "@/lib/pipeline/ai-guides";
import { ingestGeneratedPost } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { AUTOMATION_APPROVER, findDuplicate } from "@/lib/automation/daily-article";
import { audit } from "@/lib/security/audit";
import { dbRateLimit } from "@/lib/security/rate-limit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Admin "Generate and publish": keyword → Keyword-to-Blog → publish as returned (exact duplicates prevented). */
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

  // Exact-duplicate check before spending an API request (same subject, same post type).
  // The topic actually sent (topic field, else the product name) is what must not repeat.
  const subject = field(form, "topic") || productName;
  const before = await findDuplicate(subject, category ?? "", { type: "GUIDE" });
  if (before) return { error: `Duplicate prevented: ${before}` };
  let generated: Awaited<ReturnType<typeof generateGuide>>;
  try {
    generated = await generateGuide({ productName, brand, category: category ? CATEGORY_BY_SLUG.get(category)!.name : undefined, keywords, topic: field(form, "topic") || undefined, audience: field(form, "audience") || undefined, articleType: "GUIDE" });
  } catch (error) {
    return { error: `Keyword-to-Blog API failed: ${error instanceof Error ? error.message.replace(/^Keyword-to-Blog:\s*/, "") : String(error)}` };
  }
  const { item, response } = generated;
  // Exact returned title already published as a guide: not published twice.
  const after = await findDuplicate(subject, category ?? "", { title: item.title, type: "GUIDE" });
  if (after) return { error: `Duplicate prevented: ${after}` };
  // Direct publish: store this one post and publish it as returned (no QA or approval gate).
  const stored = await ingestGeneratedPost(item, AI_GUIDE_SOURCE, `admin-generate:${ctx.actor}`);
  await audit(ctx, { action: "guide.generate", entityType: "normalized_review", entityId: stored.reviewId ?? item.id, metadata: { productName, keywords, requestId: response.requestId, quality: response.quality } });
  if (!stored.reviewId) return { error: /duplicate/i.test(stored.reason ?? "") ? `Duplicate prevented: ${stored.reason}` : `Generated, but not stored: ${stored.reason}` };
  await db.normalizedReview.update({ where: { id: stored.reviewId }, data: { editorApprovedAt: new Date(), editorApprovedBy: AUTOMATION_APPROVER } });
  const published = await publishReview(stored.reviewId, ctx, "admin", { skipQa: true });
  await audit(ctx, { action: "guide.direct_publish", entityType: "normalized_review", entityId: stored.reviewId, metadata: { productName, keywords } });
  return published.ok ? { redirect: `/admin/reviews/${stored.reviewId}`, ok: "Generated and published." } : { error: `Generated, but publishing failed: ${published.failures.map((f) => f.code).join(", ")}` };
});
