import { adminAction, field } from "@/lib/admin/route";
import { confirmEntities, resolveCategorySlug, resolveSubcategorySlug, setCategoryOverride, setDealOverride, setEntityOverrides } from "@/lib/admin/overrides";
import { db } from "@/lib/db";
import { audit } from "@/lib/security/audit";
import { processReview } from "@/lib/pipeline/process";
import { publishReview, refreshQueueStatus, rejectReview, restoreReview, unpublishReview } from "@/lib/pipeline/publish";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { verifyLinkRecord } from "@/lib/pipeline/stages";
import { cleanText } from "@/lib/util/text";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function afterChange(reviewId: string) {
  const r = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  if (r.status === "PUBLISHED") {
    await persistPageRenderModel(reviewId);
    revalidateReviewPaths(r);
  }
}

/** All single-review QA actions: edit, publish, reject, restore, unpublish, overrides, reprocess. */
export const POST = adminAction("/admin/qa", async ({ form, ctx }) => {
  const id = field(form, "id");
  const action = field(form, "action");
  if (action === "bulk-publish") {
    const ids = form.getAll("ids").map(String).filter(Boolean).slice(0, 100);
    let ok = 0;
    const failed: string[] = [];
    for (const rid of ids) {
      const res = await publishReview(rid, ctx, "admin");
      if (res.ok) ok++;
      else failed.push(rid);
    }
    return failed.length ? { error: `Published ${ok}; ${failed.length} failed QA gates` } : { ok: `Published ${ok} review(s)` };
  }
  if (!id) return { error: "Review id is required" };
  const review = await db.normalizedReview.findUnique({ where: { id } });
  if (!review) return { error: "Review not found" };

  switch (action) {
    case "save": {
      const title = cleanText(field(form, "canonicalTitle"));
      const summary = field(form, "summary");
      const body = field(form, "body").replace(/\r\n/g, "\n");
      if (title.length < 8 || title.length > 200) return { error: "Title must be 8–200 characters" };
      if (summary.length < 20 || summary.length > 600) return { error: "Summary must be 20–600 characters" };
      if (body.length < 120) return { error: "Body must be at least 120 characters" };
      const before = { canonicalTitle: review.canonicalTitle, summary: review.summary, body: review.body.slice(0, 500) };
      await db.normalizedReview.update({ where: { id }, data: { canonicalTitle: title, summary, body, manualEditLocked: true } });
      await audit(ctx, { action: "review.edit", entityType: "normalized_review", entityId: id, before, after: { canonicalTitle: title, summary, body: body.slice(0, 500) } });
      await refreshQueueStatus(id);
      await afterChange(id);
      return { ok: "Review saved" };
    }
    case "publish": {
      const res = await publishReview(id, ctx, "admin");
      return res.ok ? { ok: "Review published" } : { error: `QA gate failed: ${res.failures.map((f) => f.message).join("; ")}` };
    }
    case "unpublish":
      await unpublishReview(id, ctx, field(form, "reason") || "unpublished by admin");
      return { ok: "Review unpublished" };
    case "reject":
      await rejectReview(id, ctx, field(form, "reason") || "rejected by admin");
      return { ok: "Review rejected" };
    case "restore":
      await restoreReview(id, ctx);
      return { ok: "Review restored to the QA queue" };
    case "override-category": {
      const category = resolveCategorySlug(field(form, "category"));
      if (!category) return { error: "Unknown category" };
      const subRaw = field(form, "subcategory");
      const sub = subRaw ? resolveSubcategorySlug(category, subRaw) : undefined;
      if (subRaw && !sub) return { error: `Unknown subcategory for ${category}` };
      await setCategoryOverride(id, category, sub, ctx, "ADMIN");
      await processReview(id, { from: "TAXONOMY", skipImage: true });
      await afterChange(id);
      return { ok: "Category overridden; taxonomy and offer matching re-run" };
    }
    case "override-entities": {
      const values: Record<string, string | null> = {};
      for (const f of ["brand", "productName", "modelNumber", "deviceType", "platform", "useCase"]) {
        if (form.has(f)) values[f] = field(form, f) || null;
      }
      for (const [k, v] of Object.entries(values)) if (v && v.length > 160) return { error: `${k} is too long` };
      await setEntityOverrides(id, values, ctx, "ADMIN");
      await processReview(id, { from: "ENTITY_EXTRACTION", skipImage: true });
      await afterChange(id);
      return { ok: "Entity overrides saved; categorization and Sovrn matching re-run" };
    }
    case "confirm-entities": {
      const changed = await confirmEntities(id, ctx);
      await processReview(id, { from: "ENTITY_EXTRACTION", skipImage: true });
      return changed ? { ok: "Low-confidence entities confirmed" } : { error: "No low-confidence entities to confirm" };
    }
    case "override-deal": {
      const dealId = field(form, "dealId");
      if (dealId && !/^[A-Za-z0-9._:\-/]{1,300}$/.test(dealId)) return { error: "Deal ID contains invalid characters" };
      await setDealOverride(id, dealId || null, ctx, "ADMIN");
      const summary = await processReview(id, { from: "OFFER_MATCHING", skipImage: true, bypassOfferCache: true });
      await afterChange(id);
      return { ok: `Deal override ${dealId ? "set" : "cleared"}; matching result: ${summary.dealStatus ?? "unknown"}` };
    }
    case "reprocess": {
      const summary = await processReview(id, { bypassOfferCache: true });
      await audit(ctx, { action: "review.reprocess", entityType: "normalized_review", entityId: id, metadata: summary });
      await afterChange(id);
      return { ok: `Pipeline re-run: status ${summary.status}, deals ${summary.dealStatus ?? "n/a"}, ${summary.linksVerified} verified link(s)` };
    }
    case "verify-links": {
      const links = await db.affiliateLink.findMany({ where: { normalizedReviewId: id, isActive: true } });
      if (!links.length) return { error: "This review has no active affiliate links to verify" };
      const results = await Promise.all(links.map((l) => verifyLinkRecord(l)));
      const summary = results.map((r) => r.outcome.status);
      await audit(ctx, { action: "links.verify", entityType: "normalized_review", entityId: id, metadata: { results: summary } });
      await afterChange(id);
      return { ok: `Checked ${links.length} link(s): ${summary.join(", ")}` };
    }
    default:
      return { error: `Unknown action "${action}"` };
  }
});
