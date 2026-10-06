import type { CommerceBrand } from "@prisma/client";
import { ActionForm, Badge, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { BRAND_LIMITS, brandCounts, listBrands, readBrandSeed } from "@/lib/commerce/brands";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce brands" };

const PAGE = "/admin/commerce/brands";
const API = "/api/admin/commerce/brands";

const ROBOTS_TONE: Record<string, "ok" | "warn" | "error"> = { ALLOWED: "ok", NO_ROBOTS: "ok", DISALLOWED: "error", UNREACHABLE: "error" };
const crawlTone = (s: string | null): "ok" | "warn" | "error" => (!s ? "warn" : /^(OK|COLLECTED|SUCCEEDED)$/.test(s) ? "ok" : /RUNNING|READY|COLLECTING/.test(s) ? "warn" : "error");

function BrandForm({ brand, returnTo }: { brand?: CommerceBrand; returnTo: string }) {
  const p = brand ? `e-${brand.id}` : "new";
  return (
    <form className="card card-body" action={API} method="post" key={brand?.id ?? "new"}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="action" value={brand ? "update" : "create"} />
      <input type="hidden" name="enabledPresent" value="1" />
      {brand && <input type="hidden" name="id" value={brand.id} />}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-name`}>Name</label>
          <input id={`${p}-name`} name="name" required maxLength={80} defaultValue={brand?.name} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-slug`}>Slug</label>
          <input id={`${p}-slug`} name="slug" required pattern="[a-z0-9-]{2,60}" defaultValue={brand?.slug} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-domain`}>Official domain (https)</label>
          <input id={`${p}-domain`} name="officialDomain" required defaultValue={brand?.officialDomain} placeholder="www.example.com" />
        </div>
        <div className="field">
          <label htmlFor={`${p}-market`}>Market</label>
          <input id={`${p}-market`} name="market" required pattern="[A-Za-z]{2}" maxLength={2} defaultValue={brand?.market ?? "US"} />
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-prio`}>Priority (higher first)</label>
          <input id={`${p}-prio`} name="priority" type="number" min={BRAND_LIMITS.priority.min} max={BRAND_LIMITS.priority.max} defaultValue={brand?.priority ?? 100} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-freq`}>Crawl every (hours)</label>
          <input id={`${p}-freq`} name="crawlFrequencyHours" type="number" min={BRAND_LIMITS.crawlFrequencyHours.min} max={BRAND_LIMITS.crawlFrequencyHours.max} defaultValue={brand?.crawlFrequencyHours ?? 24} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-max`}>Products per run</label>
          <input id={`${p}-max`} name="maxProductsPerRun" type="number" min={BRAND_LIMITS.maxProductsPerRun.min} max={BRAND_LIMITS.maxProductsPerRun.max} defaultValue={brand?.maxProductsPerRun ?? 20} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-enabled`}>
            <input id={`${p}-enabled`} name="enabled" type="checkbox" value="1" defaultChecked={brand?.enabled ?? true} /> Enabled
          </label>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${p}-cats`}>Categories, one slug per line</label>
        <textarea id={`${p}-cats`} name="categories" required defaultValue={brand?.categories.join("\n")} placeholder="laptops" />
        <p className="field-hint">Made4Buyers category slugs: {CATEGORIES.map((c) => c.slug).join(", ")}.</p>
      </div>
      <div className="field">
        <label htmlFor={`${p}-disc`}>Discovery URLs (sitemaps or listing pages), one per line</label>
        <textarea id={`${p}-disc`} name="discoveryUrls" defaultValue={brand?.discoveryUrls.join("\n")} placeholder="https://www.example.com/sitemap.xml" />
        <p className="field-hint">https, on the official domain or its subdomains. Empty: the Sitemap lines in the brand’s robots.txt are used. Paths are never guessed.</p>
      </div>
      <div className="field">
        <label htmlFor={`${p}-pat`}>Product URL patterns, one per line</label>
        <textarea id={`${p}-pat`} name="productUrlPatterns" defaultValue={brand?.productUrlPatterns.join("\n")} placeholder="https://www.example.com/products/*" />
        <p className="field-hint">Globs that must start with https://&lt;official domain&gt;/. * matches within one path segment, ** across segments. Empty: a conservative product-page heuristic is used.</p>
      </div>
      <div className="field">
        <label htmlFor={`${p}-promo`}>Official promotions pages, one per line</label>
        <textarea id={`${p}-promo`} name="promoUrls" defaultValue={brand?.promoUrls.join("\n")} placeholder="https://www.example.com/deals" />
        <p className="field-hint">First-party offers pages only (coupon extraction), on the official domain.</p>
      </div>
      <div className="field">
        <label htmlFor={`${p}-notes`}>Notes</label>
        <textarea id={`${p}-notes`} name="notes" maxLength={BRAND_LIMITS.notes} defaultValue={brand?.notes ?? ""} />
      </div>
      <div className="btnrow">
        <button className="btn primary" type="submit">
          {brand ? "Save brand" : "Add brand"}
        </button>
        {brand && (
          <a className="btn" href={returnTo}>
            Cancel
          </a>
        )}
      </div>
    </form>
  );
}

export default async function CommerceBrandsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const enabledParam = param(sp, "enabled");
  const category = param(sp, "category") || undefined;
  const q = param(sp, "q")?.trim() || undefined;
  const editId = param(sp, "edit");
  const enabled = enabledParam === "yes" ? true : enabledParam === "no" ? false : undefined;

  const [brands, counts] = await Promise.all([listBrands({ enabled, category: category && CATEGORY_BY_SLUG.has(category) ? category : undefined, q }), brandCounts()]);
  let seedCount: number | null = null;
  try {
    seedCount = readBrandSeed().length;
  } catch {
    seedCount = null;
  }
  const edit = editId ? (brands.find((b) => b.id === editId) ?? (await db.commerceBrand.findUnique({ where: { id: editId } })) ?? undefined) : undefined;
  const filterQs = new URLSearchParams(Object.entries({ enabled: enabledParam, category, q }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const returnTo = filterQs ? `${PAGE}?${filterQs}` : PAGE;
  const editHref = (id: string) => `${PAGE}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(filterQs)), edit: id }).toString()}#edit`;
  const now = new Date();

  return (
    <>
      <h1>Commerce brands</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Official brand sites the commerce engine reads products, prices and first-party promotions from. Only the official domain is crawled; robots.txt is checked before every discovery, and a site that disallows crawling or cannot serve its robots.txt is not crawled. Product URLs come from the brand’s
        own sitemaps. Market says where a brand sells, nothing about ownership.
      </p>
      <p className="small muted">
        {counts.total} brands · {counts.enabled} enabled · {counts.due} due now · {counts.failing} with failures
      </p>

      <div className="btnrow">
        <ActionForm action={API} fields={{ action: "import-seed" }} label={`Import seed brands${seedCount != null ? ` (${seedCount})` : ""}`} returnTo={returnTo} confirm="Import the seed brands? New brands are created; existing brands keep every admin edit and only have empty lists filled in." />
      </div>

      <form className="btnrow" method="get" action={PAGE}>
        <label className="small" htmlFor="f-enabled">
          Status{" "}
          <select id="f-enabled" name="enabled" defaultValue={enabledParam ?? ""}>
            <option value="">All</option>
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label className="small" htmlFor="f-category">
          Category{" "}
          <select id="f-category" name="category" defaultValue={category ?? ""}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-q">
          Search{" "}
          <input id="f-q" name="q" type="search" maxLength={80} defaultValue={q ?? ""} placeholder="Name, slug or domain" />
        </label>
        <button className="btn small" type="submit">
          Filter
        </button>
        {filterQs && (
          <a className="btn small" href={PAGE}>
            Clear
          </a>
        )}
        <span className="small muted">
          {brands.length} brand{brands.length === 1 ? "" : "s"} shown
        </span>
      </form>

      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Brand</th>
              <th>Categories</th>
              <th>Status</th>
              <th className="num">Priority</th>
              <th>Robots.txt</th>
              <th>Last crawl</th>
              <th>Next crawl</th>
              <th>Crawl status</th>
              <th className="num">Failures</th>
              <th>Last error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} className={b.enabled ? undefined : "row-inactive"}>
                <td data-label="Brand">
                  <strong>{b.name}</strong>
                  <div className="small muted">
                    {b.officialDomain} · {b.market}
                  </div>
                  <details className="small">
                    <summary>
                      {b.discoveryUrls.length} discovery · {b.productUrlPatterns.length} patterns · {b.promoUrls.length} promo
                    </summary>
                    <div>Discovery: {b.discoveryUrls.join(", ") || "robots.txt Sitemap lines"}</div>
                    <div>Patterns: {b.productUrlPatterns.join(", ") || "heuristic"}</div>
                    <div>Promotions: {b.promoUrls.join(", ") || "none"}</div>
                    <div>
                      Every {b.crawlFrequencyHours} h · up to {b.maxProductsPerRun} products per run
                    </div>
                    {b.notes && <div className="muted">{b.notes}</div>}
                  </details>
                </td>
                <td data-label="Categories" className="small">
                  {b.categories.map((c) => CATEGORY_BY_SLUG.get(c)?.name ?? c).join(", ")}
                </td>
                <td data-label="Status">
                  <Badge value={b.enabled ? "ENABLED" : "DISABLED"} tone={b.enabled ? "ok" : "warn"} />
                </td>
                <td className="num" data-label="Priority">
                  {b.priority}
                </td>
                <td data-label="Robots.txt">
                  <Badge value={b.robotsStatus ?? "NOT CHECKED"} tone={b.robotsStatus ? (ROBOTS_TONE[b.robotsStatus] ?? "warn") : "warn"} />
                  {b.robotsCheckedAt && <div className="small muted">{when(b.robotsCheckedAt)}</div>}
                </td>
                <td data-label="Last crawl">{b.lastCrawlAt ? when(b.lastCrawlAt) : "Never"}</td>
                <td data-label="Next crawl">
                  {b.nextCrawlAt ? when(b.nextCrawlAt) : "Due (never scheduled)"}
                  {b.nextCrawlAt && b.nextCrawlAt > now && b.consecutiveFailures > 0 && <div className="small muted">backing off after failures</div>}
                </td>
                <td data-label="Crawl status">{b.crawlStatus ? <Badge value={b.crawlStatus} tone={crawlTone(b.crawlStatus)} /> : "—"}</td>
                <td className="num" data-label="Failures">
                  {b.consecutiveFailures}
                </td>
                <td data-label="Last error" className="small">
                  {b.lastError ? b.lastError.slice(0, 200) : "—"}
                </td>
                <td data-label="Actions">
                  <div className="btnrow" style={{ margin: 0 }}>
                    <ActionForm action={API} fields={{ id: b.id, action: "toggle" }} label={b.enabled ? "Disable" : "Enable"} returnTo={returnTo} />
                    <ActionForm action={API} fields={{ id: b.id, action: "crawl-now" }} label="Crawl next" returnTo={returnTo} />
                    <a className="btn small" href={editHref(b.id)}>
                      Edit
                    </a>
                  </div>
                </td>
              </tr>
            ))}
            {!brands.length && (
              <tr>
                <td colSpan={11}>{counts.total ? "No brands match the filter." : "No brands yet. Import the seed brands or add one below."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 id="edit">{edit ? `Edit ${edit.name}` : "Add a brand"}</h2>
      {editId && !edit && <p className="notice warn">That brand no longer exists.</p>}
      <BrandForm brand={edit} returnTo={returnTo} />
    </>
  );
}
