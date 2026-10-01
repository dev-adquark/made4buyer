import { adminAction, field } from "@/lib/admin/route";
import { parseSourceForm } from "@/lib/admin/sources";
import { db } from "@/lib/db";
import { apifyConfigured, startSourceRun } from "@/lib/pipeline/apify";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = adminAction("/admin/sources", async ({ form, ctx }) => {
  const id = field(form, "id");
  const action = field(form, "action") || "save";

  if (action === "toggle" || action === "run") {
    const source = await db.reviewSource.findUnique({ where: { id } });
    if (!source) return { error: "Source not found" };
    if (action === "toggle") {
      const after = await db.reviewSource.update({ where: { id }, data: { enabled: !source.enabled } });
      await audit(ctx, { action: after.enabled ? "source.enable" : "source.disable", entityType: "review_source", entityId: id, before: { enabled: source.enabled }, after: { enabled: after.enabled } });
      return { ok: after.enabled ? `${source.name} enabled: it will be crawled on the next scheduled run` : `${source.name} disabled` };
    }
    if (!apifyConfigured()) return { error: "APIFY_API_TOKEN is not configured (BLOCKED_BY_ENVIRONMENT)" };
    const r = await startSourceRun(source, `admin:${ctx.actor}`);
    await audit(ctx, { action: "source.run", entityType: "review_source", entityId: id, metadata: r });
    return r.status === "STARTED" ? { ok: `Apify run ${r.runId} started for ${source.name}. Collect it from Jobs → collect-scrapes once it finishes.` } : { error: `${source.name}: ${r.status}${r.reason ? `: ${r.reason}` : ""}` };
  }

  const parsed = parseSourceForm((n) => field(form, n));
  if (!parsed.ok) return { error: parsed.error };
  const v = parsed.value;
  const clash = await db.reviewSource.findUnique({ where: { slug: v.slug } });
  if (clash && clash.id !== id) return { error: `Slug ${v.slug} is already used` };
  if (id) {
    const before = await db.reviewSource.findUnique({ where: { id } });
    if (!before) return { error: "Source not found" };
    const after = await db.reviewSource.update({ where: { id }, data: v });
    await audit(ctx, { action: "source.update", entityType: "review_source", entityId: id, before, after });
    return { ok: `${after.name} saved` };
  }
  // New sources start disabled: an admin enables them after checking the source's terms.
  const created = await db.reviewSource.create({ data: { ...v, enabled: false } });
  await audit(ctx, { action: "source.create", entityType: "review_source", entityId: created.id, after: created });
  return { ok: `${created.name} added (disabled). Check the source’s terms, then enable it.` };
});
