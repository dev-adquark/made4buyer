import type { SponsoredPosition } from "@prisma/client";
import { adminAction, field, optionalDate } from "@/lib/admin/route";
import { db } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { audit } from "@/lib/security/audit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";

const POSITIONS: SponsoredPosition[] = ["HOME_HERO", "CATEGORY_TOP", "REVIEW_SIDEBAR"];

export const POST = adminAction("/admin/sponsored", async ({ form, ctx }) => {
  const id = field(form, "id");
  const action = field(form, "action") || "save";
  if (action === "toggle") {
    const before = await db.sponsoredPlacement.findUnique({ where: { id } });
    if (!before) return { error: "Placement not found" };
    const after = await db.sponsoredPlacement.update({ where: { id }, data: { enabled: !before.enabled } });
    await audit(ctx, { action: after.enabled ? "sponsored.enable" : "sponsored.disable", entityType: "sponsored_placement", entityId: id, before: { enabled: before.enabled }, after: { enabled: after.enabled } });
    return { ok: after.enabled ? "Placement enabled (still subject to feature flag, schedule and traffic threshold)" : "Placement disabled" };
  }
  if (action === "delete") {
    const before = await db.sponsoredPlacement.findUnique({ where: { id } });
    if (!before) return { error: "Placement not found" };
    await db.sponsoredPlacement.delete({ where: { id } });
    await audit(ctx, { action: "sponsored.delete", entityType: "sponsored_placement", entityId: id, before });
    return { ok: "Placement deleted" };
  }

  const title = field(form, "title");
  const advertiser = field(form, "advertiser");
  const disclosure = field(form, "disclosure");
  const position = field(form, "position") as SponsoredPosition;
  const categorySlug = field(form, "categorySlug") || null;
  const url = validateOutboundUrl(field(form, "url"), { standardPortsOnly: true });
  if (!title || title.length > 140) return { error: "Title is required (max 140 characters)" };
  if (!advertiser || advertiser.length > 100) return { error: "Advertiser is required (max 100 characters)" };
  if (disclosure.length < 10 || disclosure.length > 300) return { error: "Disclosure text is required (10–300 characters)" };
  if (!url.url || url.url.protocol !== "https:") return { error: "A public https:// URL is required" };
  if (!POSITIONS.includes(position)) return { error: "Invalid position" };
  if (categorySlug && !CATEGORY_BY_SLUG.has(categorySlug)) return { error: "Unknown category" };
  const startAt = optionalDate(field(form, "startAt")) ?? null;
  const endAt = optionalDate(field(form, "endAt")) ?? null;
  if (startAt && endAt && endAt <= startAt) return { error: "End must be after start" };
  const minMonthlyPageViews = Math.floor(Number(field(form, "minMonthlyPageViews") || 1000));
  const minMonthlySessions = Math.floor(Number(field(form, "minMonthlySessions") || 250));
  if (!Number.isFinite(minMonthlyPageViews) || minMonthlyPageViews < 1 || !Number.isFinite(minMonthlySessions) || minMonthlySessions < 1) {
    return { error: "Traffic thresholds must be positive numbers" };
  }
  const data = { title, advertiser, disclosure, url: url.url.toString(), label: field(form, "label") || "Sponsored", position, categorySlug, startAt, endAt, minMonthlyPageViews, minMonthlySessions };
  if (id) {
    const before = await db.sponsoredPlacement.findUnique({ where: { id } });
    if (!before) return { error: "Placement not found" };
    const after = await db.sponsoredPlacement.update({ where: { id }, data });
    await audit(ctx, { action: "sponsored.update", entityType: "sponsored_placement", entityId: id, before, after });
    return { ok: "Placement updated" };
  }
  const created = await db.sponsoredPlacement.create({ data: { ...data, enabled: false } });
  await audit(ctx, { action: "sponsored.create", entityType: "sponsored_placement", entityId: created.id, after: created });
  return { ok: "Placement created (disabled). Preview it, then enable." };
});
