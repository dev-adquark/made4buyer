import { adminAction, field } from "@/lib/admin/route";
import { db } from "@/lib/db";
import { audit } from "@/lib/security/audit";
import { refreshQueueStatus } from "@/lib/pipeline/publish";
import { reviewAssignment } from "@/lib/taxonomy/persist";

export const dynamic = "force-dynamic";

/** Accept or reject an automatic category assignment (feeds the categorization-acceptance metric). */
export const POST = adminAction("/admin/categorization", async ({ form, ctx }) => {
  const id = field(form, "id");
  const decision = field(form, "decision");
  if (!id || (decision !== "ACCEPTED" && decision !== "REJECTED")) return { error: "Assignment id and decision are required" };
  const before = await db.reviewCategoryAssignment.findUnique({ where: { id } });
  if (!before) return { error: "Assignment not found" };
  const after = await reviewAssignment(id, decision, ctx.actor);
  await audit(ctx, { action: `assignment.${decision.toLowerCase()}`, entityType: "review_category_assignment", entityId: id, before: { reviewState: before.reviewState, active: before.active }, after: { reviewState: after.reviewState, active: after.active } });
  await refreshQueueStatus(after.normalizedReviewId);
  return { ok: decision === "ACCEPTED" ? "Assignment accepted" : "Assignment rejected — set a category override for this review" };
});
