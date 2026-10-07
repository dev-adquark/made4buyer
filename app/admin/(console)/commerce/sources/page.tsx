import Link from "next/link";
import { ActionForm, Badge, safeHref, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { brandRegistryStats } from "@/lib/commerce/admin-queries";
import { brandCounts, inCrawlWindow, listBrands, readBrandSeed, windowLabel, windowOverdue } from "@/lib/commerce/brands";
import { db } from "@/lib/db";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { AddBrandForm, BRAND_API, BrandForm } from "./brand-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce sources" };

const PAGE = "/admin/commerce/sources";

type Tone = "ok" | "warn" | "error" | "info" | "neutral";
const TONE: Record<string, Tone> = {
  OK: "ok",
  SUCCEEDED: "ok",
  COMPLETED: "ok",
  COLLECTED: "ok",
  ALLOWED: "ok",
  NO_ROBOTS: "ok",
  RUNNING: "info",
  READY: "info",
  COLLECTING: "info",
  RETRY_QUEUED: "warn",
  FAILED: "error",
  BLOCKED: "error",
  DISALLOWED: "error",
  UNREACHABLE: "error",
  APPROVED: "ok",
  UNREVIEWED: "neutral",
  REJECTED: "error",
  VERIFIED: "ok",
  MISMATCH: "error",
  NOT_FOUND: "warn",
  NOT_CHECKED: "neutral",
};
const tone = (v: string | null | undefined): Tone => (v ? (TONE[v] ?? (/FAIL|ERROR|BLOCK|DISALLOW/.test(v) ? "error" : "neutral")) : "neutral");

/**
 * Admin → Commerce → Sources: the source registry. Every official brand site the engine reads
 * (products, prices, deals, first-party promotions) with its crawl health, what its runs found and
 * how its products verify — and the one editor for brands. Non-brand sources are listed read-only
 * (reviewed and enabled in Coupons).
 */
export default async function CommerceSourcesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const enabledParam = param(sp, "enabled");
  const categoryParam = param(sp, "category");
  const category = categoryParam && CATEGORY_BY_SLUG.has(categoryParam) ? categoryParam : undefined;
  const q = param(sp, "q")?.trim().slice(0, 80) || undefined;
  const editId = param(sp, "edit");
  const enabled = enabledParam === "yes" ? true : enabledParam === "no" ? false : undefined;

  const [brands, counts, stats, sources, bySource] = await Promise.all([
    listBrands({ enabled, category, q }),
    brandCounts(),
    brandRegistryStats(),
    db.commerceSource.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] }),
    db.commerceRun.groupBy({ by: ["sourceId"], where: { sourceId: { not: null } }, _sum: { extracted: true, accepted: true }, _count: { _all: true } }),
  ]);
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
  const sourceRuns = (id: string) => bySource.find((r) => r.sourceId === id);
  const now = new Date();

  return (
    <>
      <h1>Commerce sources</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        The source registry: the official brand sites the commerce engine reads products, prices, deals and first-party promotions from, and the one place they are edited. Only the official domain (and its subdomains) is crawled; robots.txt is checked before every discovery, and a site that disallows crawling or cannot serve its
        robots.txt is not crawled. Every registry URL must be https on the brand’s official domain, without a port or tracking parameters. “Found” is the total records Apify extracted across the brand’s runs; “Accepted” the total accepted into products, offers or coupons; “Verification” counts the official-site
        status of the Made4Buyers products its commerce products are attached to.
      </p>

      <div className="stats">
        <Stat label="Brands" value={`${counts.enabled} / ${counts.total}`} note="enabled / total" />
        <Stat label="Due now" value={counts.due} />
        <Stat label="With failures" value={counts.failing} note={<Link href="/admin/commerce">Retry from the overview</Link>} />
        <Stat label="Non-brand sources" value={`${sources.filter((s) => s.enabled).length} / ${sources.length}`} note="enabled / total" />
      </div>

      <div className="btnrow">
        <ActionForm action={BRAND_API} fields={{ action: "import-seed" }} label={`Import seed brands${seedCount != null ? ` (${seedCount})` : ""}`} returnTo={returnTo} confirm="Import the seed brands? New brands are created; existing brands keep every admin edit and only have empty lists filled in." />
        <a className="btn small" href="#add">
          Add brand
        </a>
        <Link className="btn small" href="/admin/commerce/runs">
          Runs
        </Link>
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

      <h2 id="cs-brands-h">Brands</h2>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cs-brands-h">
          <thead>
            <tr>
              <th scope="col">Brand</th>
              <th scope="col">Status</th>
              <th scope="col">Last / next crawl</th>
              <th scope="col">Failures</th>
              <th scope="col" className="num">
                Records found
              </th>
              <th scope="col">Verification</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const s = stats.get(b.id);
              const official = Object.entries(s?.official ?? {}).sort((a, c) => c[1] - a[1]);
              return (
                <tr key={b.id} className={b.enabled ? undefined : "row-inactive"}>
                  <td data-label="Brand">
                    <strong>{b.name}</strong>
                    <div className="small muted">
                      {b.officialDomain} · {b.market} · {b.currency}
                    </div>
                    <div className="small muted">{b.categories.map((c) => CATEGORY_BY_SLUG.get(c)?.name ?? c).join(", ")}</div>
                    <details className="small">
                      <summary>
                        {b.dealUrls.length} deal · {b.productUrls.length} product · {b.promoUrls.length} promo · {b.discoveryUrls.length} discovery · {b.productUrlPatterns.length} patterns
                      </summary>
                      <div style={{ wordBreak: "break-all" }}>Deal pages: {b.dealUrls.join(", ") || "none"}</div>
                      <div style={{ wordBreak: "break-all" }}>Product pages: {b.productUrls.join(", ") || "none"}</div>
                      <div style={{ wordBreak: "break-all" }}>Promotions: {b.promoUrls.join(", ") || "none"}</div>
                      <div style={{ wordBreak: "break-all" }}>Discovery: {b.discoveryUrls.join(", ") || "robots.txt Sitemap lines"}</div>
                      <div style={{ wordBreak: "break-all" }}>Patterns: {b.productUrlPatterns.join(", ") || "heuristic"}</div>
                      <div>
                        Every {b.crawlFrequencyHours} h · up to {b.maxProductsPerRun} products per run · priority {b.priority}
                      </div>
                      {b.officialStoreUrl && (
                        <div>
                          <a href={safeHref(b.officialStoreUrl)} rel="noopener noreferrer nofollow" target="_blank">
                            Official store
                          </a>
                        </div>
                      )}
                      {b.notes && <div className="muted">{b.notes}</div>}
                    </details>
                  </td>
                  <td data-label="Status">
                    <Badge value={b.enabled ? "ENABLED" : "DISABLED"} tone={b.enabled ? "ok" : "warn"} />
                    <div>
                      <Badge value={b.crawlStatus ?? "NOT CRAWLED"} tone={tone(b.crawlStatus)} />
                    </div>
                    <div className="small muted">
                      robots <Badge value={b.robotsStatus ?? "NOT CHECKED"} tone={tone(b.robotsStatus)} />
                      {b.robotsCheckedAt && <> {when(b.robotsCheckedAt)}</>}
                    </div>
                  </td>
                  <td data-label="Last / next crawl" className="small">
                    {b.lastCrawlAt ? when(b.lastCrawlAt) : "Never"}
                    <div className="muted">
                      next {b.nextCrawlAt ? when(b.nextCrawlAt) : "due (never scheduled)"}
                      {b.nextCrawlAt && b.nextCrawlAt > now && b.consecutiveFailures > 0 ? " · backing off after failures" : ""}
                    </div>
                    <div className="muted">
                      {windowLabel(b)}
                      {b.crawlWindowStartHour !== null && b.crawlWindowHours < 24 && ` · ${inCrawlWindow(b, now) ? "in window now" : windowOverdue(b, now) && (!b.nextCrawlAt || b.nextCrawlAt <= now) ? "window missed: due anyway" : "outside window"}`}
                    </div>
                  </td>
                  <td data-label="Failures" className="small" style={{ wordBreak: "break-word" }}>
                    <strong>{b.consecutiveFailures}</strong> consecutive
                    {b.lastError && <div className="muted">{b.lastError.slice(0, 240)}</div>}
                  </td>
                  <td data-label="Records found" className="num small">
                    {s?.extracted ?? 0} found
                    <div className="muted">{s?.accepted ?? 0} accepted</div>
                    <div className="muted">
                      {s?.runs ?? 0} run{s?.runs === 1 ? "" : "s"} · {s?.products ?? 0} product{s?.products === 1 ? "" : "s"}
                    </div>
                    {s?.lastRun && (
                      <div className="muted">
                        last <Badge value={s.lastRun.status} tone={tone(s.lastRun.status)} />
                      </div>
                    )}
                    {s?.runs ? <Link href={`/admin/commerce/runs?brand=${encodeURIComponent(b.id)}`}>Runs</Link> : null}
                  </td>
                  <td data-label="Verification" className="small">
                    {official.length ? (
                      official.map(([k, n]) => (
                        <div key={k}>
                          <Badge value={k} tone={tone(k)} /> {n}
                        </div>
                      ))
                    ) : (
                      <span className="muted">No attached products</span>
                    )}
                    {(s?.products ?? 0) > 0 && <Link href={`/admin/commerce/products?brand=${encodeURIComponent(b.id)}`}>Products</Link>}
                  </td>
                  <td data-label="Actions">
                    <div className="btnrow" style={{ margin: 0 }}>
                      <ActionForm action={BRAND_API} fields={{ id: b.id, action: "toggle" }} label={b.enabled ? "Disable" : "Enable"} returnTo={returnTo} />
                      <ActionForm action={BRAND_API} fields={{ id: b.id, action: "crawl-now" }} label="Crawl next" returnTo={returnTo} />
                      <a className="btn small" href={editHref(b.id)}>
                        Edit
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!brands.length && (
              <tr>
                <td colSpan={7}>{counts.total ? "No brands match the filter." : "No brands yet. Import the seed brands or add one below."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editId && (
        <>
          <h2 id="edit">{edit ? `Edit ${edit.name}` : "Edit brand"}</h2>
          {edit ? <BrandForm brand={edit} returnTo={returnTo} /> : <p className="notice warn">That brand no longer exists.</p>}
        </>
      )}

      <h2 id="add">Add a brand</h2>
      <p className="small muted">Name, official domain, a category, the currency and its official URLs. Priority, crawl frequency, window and the remaining lists take their defaults and can be edited afterwards.</p>
      <AddBrandForm returnTo={returnTo} />

      <h2 id="cs-sources-h">Non-brand sources</h2>
      <p className="small muted">
        Third-party sources stay disabled until their terms are reviewed; they are reviewed and enabled in <Link href="/admin/commerce/coupons">Coupons</Link>.
      </p>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cs-sources-h">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Kind</th>
              <th scope="col">Enabled</th>
              <th scope="col">Terms</th>
              <th scope="col">Robots</th>
              <th scope="col">Crawl status</th>
              <th scope="col">Last / next crawl</th>
              <th scope="col" className="num">
                Found
              </th>
              <th scope="col" className="num">
                Accepted
              </th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const r = sourceRuns(s.id);
              return (
                <tr key={s.id}>
                  <td data-label="Source">
                    {s.name}
                    <div className="small muted">{s.domain}</div>
                  </td>
                  <td data-label="Kind" className="small">
                    {s.kind}
                  </td>
                  <td data-label="Enabled">
                    <Badge value={s.enabled ? "ON" : "OFF"} tone={s.enabled ? "ok" : "neutral"} />
                  </td>
                  <td data-label="Terms">
                    <Badge value={s.termsStatus} tone={tone(s.termsStatus)} />
                  </td>
                  <td data-label="Robots" className="small">
                    <Badge value={s.robotsStatus ?? "UNCHECKED"} tone={tone(s.robotsStatus)} />
                  </td>
                  <td data-label="Crawl status">
                    <Badge value={s.crawlStatus ?? "NOT CRAWLED"} tone={tone(s.crawlStatus)} />
                  </td>
                  <td data-label="Last / next crawl" className="small">
                    {when(s.lastCrawlAt)}
                    <div className="muted">next {when(s.nextCrawlAt)}</div>
                  </td>
                  <td data-label="Found" className="num">
                    {r?._sum.extracted ?? 0}
                  </td>
                  <td data-label="Accepted" className="num">
                    {r?._sum.accepted ?? 0}
                  </td>
                  <td data-label="Last error" className="small" style={{ wordBreak: "break-word" }}>
                    {s.lastError ?? "—"}
                  </td>
                </tr>
              );
            })}
            {!sources.length && (
              <tr>
                <td colSpan={10}>
                  No non-brand sources. They are added and reviewed in <Link href="/admin/commerce/coupons">Coupons</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
