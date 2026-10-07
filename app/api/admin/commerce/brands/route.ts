import { adminAction, field } from "@/lib/admin/route";
import { crawlBrandNow, createBrand, importSeedBrands, parseBrandForm, slugFromName, toggleBrand, updateBrand } from "@/lib/commerce/brands";
import { db } from "@/lib/db";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The source registry (Admin → Commerce → Sources); /admin/commerce/brands redirects there. */
const PAGE = "/admin/commerce/sources";

/** Admin → Commerce → Sources (brand registry): create | update | toggle | crawl-now | import-seed. Every change is audited. */
export const POST = adminAction(PAGE, async ({ form, ctx }) => {
  const action = field(form, "action");
  const id = field(form, "id");

  if (action === "import-seed") {
    const r = await importSeedBrands();
    await audit(ctx, { action: "commerce_brand.import_seed", entityType: "commerce_brand", entityId: "seed", metadata: r });
    const invalid = r.invalid.length ? `; ${r.invalid.length} invalid (${r.invalid.map((i) => `${i.slug}: ${i.error}`).join("; ").slice(0, 150)})` : "";
    return { ok: `Seed brands imported: ${r.created} created, ${r.filled} filled in (empty lists only), ${r.unchanged} unchanged of ${r.total}${invalid}`, json: { ok: true, ...r } };
  }

  if (action === "toggle") {
    const r = await toggleBrand(id);
    if (!r) return { error: "Brand not found" };
    await audit(ctx, { action: r.after.enabled ? "commerce_brand.enable" : "commerce_brand.disable", entityType: "commerce_brand", entityId: id, before: { enabled: r.before.enabled }, after: { enabled: r.after.enabled } });
    return { ok: r.after.enabled ? `${r.after.name} enabled` : `${r.after.name} disabled: it is not crawled until enabled again` };
  }

  if (action === "crawl-now") {
    const r = await crawlBrandNow(id);
    if (!r) return { error: "Brand not found" };
    await audit(ctx, { action: "commerce_brand.crawl_now", entityType: "commerce_brand", entityId: id, before: { nextCrawlAt: r.before.nextCrawlAt }, after: { nextCrawlAt: r.after.nextCrawlAt } });
    return { ok: r.after.enabled ? `${r.after.name} is due: it is crawled on the next commerce-discover run` : `${r.after.name} is scheduled now, but it is disabled: enable it to crawl` };
  }

  if (action === "update") {
    const existing = await db.commerceBrand.findUnique({ where: { id } });
    if (!existing) return { error: "Brand not found" };
    const parsed = parseBrandForm((n) => field(form, n), existing);
    if (!parsed.ok) return { error: parsed.error };
    const r = await updateBrand(id, parsed.value);
    if (!r.ok) return { error: r.error };
    await audit(ctx, { action: "commerce_brand.update", entityType: "commerce_brand", entityId: id, before: r.before, after: r.after });
    return { ok: `${r.after.name} saved` };
  }

  if (action === "create") {
    // "Add brand" may leave the slug blank: it is derived from the name (and still validated).
    const parsed = parseBrandForm((n) => (n === "slug" && !field(form, "slug") ? slugFromName(field(form, "name")) : field(form, n)));
    if (!parsed.ok) return { error: parsed.error };
    const r = await createBrand(parsed.value);
    if (!r.ok) return { error: r.error };
    await audit(ctx, { action: "commerce_brand.create", entityType: "commerce_brand", entityId: r.value.id, after: r.value });
    return { ok: `${r.value.name} added${r.value.enabled ? "" : " (disabled)"}` };
  }

  return { error: `Unknown action: ${action || "(none)"}` };
});
