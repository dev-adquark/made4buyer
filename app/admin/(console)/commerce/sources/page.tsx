import Link from "next/link";
import { Badge, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce sources" };

type Tone = "ok" | "warn" | "error" | "info" | "neutral";
const TONE: Record<string, Tone> = { OK: "ok", SUCCEEDED: "ok", COMPLETED: "ok", ALLOWED: "ok", RUNNING: "info", RETRY_QUEUED: "warn", FAILED: "error", BLOCKED: "error", DISALLOWED: "error", APPROVED: "ok", UNREVIEWED: "neutral", REJECTED: "error" };
const tone = (v: string | null | undefined): Tone => (v ? (TONE[v] ?? "neutral") : "neutral");

/** Admin → Commerce sources: crawl health of every brand site and non-brand source (read-only). */
export default async function CommerceSourcesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const [brands, sources, byBrand, bySource] = await Promise.all([
    db.commerceBrand.findMany({ orderBy: [{ enabled: "desc" }, { priority: "asc" }, { name: "asc" }] }),
    db.commerceSource.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] }),
    db.commerceRun.groupBy({ by: ["brandId"], where: { brandId: { not: null } }, _sum: { extracted: true, accepted: true }, _count: { _all: true } }),
    db.commerceRun.groupBy({ by: ["sourceId"], where: { sourceId: { not: null } }, _sum: { extracted: true, accepted: true }, _count: { _all: true } }),
  ]);
  const tally = (values: Array<string | null>) => {
    const m = new Map<string, number>();
    for (const v of values) m.set(v ?? "NOT CRAWLED", (m.get(v ?? "NOT CRAWLED") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const crawlTally = tally(brands.map((b) => b.crawlStatus));
  const robotsTally = tally(brands.map((b) => b.robotsStatus));
  const brandRuns = (id: string) => byBrand.find((r) => r.brandId === id);
  const sourceRuns = (id: string) => bySource.find((r) => r.sourceId === id);

  return (
    <>
      <h1>Commerce sources</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Where the commerce engine reads from: official brand sites (products, prices, first-party promotions) and non-brand sources. This page is read-only. Brands are managed in <Link href="/admin/commerce/brands">Commerce brands</Link>; non-brand sources are managed in <Link href="/admin/commerce/coupons">Coupons</Link>. “Found” is the
        total records Apify extracted across all runs; “Updated” is the total accepted into products, offers or coupons.
      </p>

      <div className="stats">
        <Stat label="Brands" value={`${brands.filter((b) => b.enabled).length} / ${brands.length}`} note="enabled / total" />
        <Stat label="Non-brand sources" value={`${sources.filter((s) => s.enabled).length} / ${sources.length}`} note="enabled / total" />
        <Stat label="Brands failing" value={brands.filter((b) => b.consecutiveFailures > 0 || b.crawlStatus === "FAILED").length} note={<Link href="/admin/commerce">Retry from the overview</Link>} />
      </div>
      {brands.length > 0 && (
        <p className="small">
          Crawl status: {crawlTally.map(([k, n]) => `${k} ${n}`).join(" · ")}
          <br />
          Robots status: {robotsTally.map(([k, n]) => `${k} ${n}`).join(" · ")}
        </p>
      )}

      <h2 id="cs-brands-h">Brands</h2>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cs-brands-h">
          <thead>
            <tr>
              <th scope="col">Brand</th>
              <th scope="col">Enabled</th>
              <th scope="col">Crawl status</th>
              <th scope="col">Robots</th>
              <th scope="col">Last crawl</th>
              <th scope="col">Next crawl</th>
              <th scope="col" className="num">Runs</th>
              <th scope="col" className="num">Found</th>
              <th scope="col" className="num">Updated</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const r = brandRuns(b.id);
              return (
                <tr key={b.id}>
                  <td data-label="Brand">
                    <Link href="/admin/commerce/brands">{b.name}</Link>
                    <div className="small muted">
                      {b.officialDomain} · every {b.crawlFrequencyHours} h
                    </div>
                  </td>
                  <td data-label="Enabled">
                    <Badge value={b.enabled ? "ON" : "OFF"} tone={b.enabled ? "ok" : "neutral"} />
                  </td>
                  <td data-label="Crawl status">
                    <Badge value={b.crawlStatus ?? "NOT CRAWLED"} tone={tone(b.crawlStatus)} />
                    {b.consecutiveFailures > 0 && <div className="small muted">{b.consecutiveFailures} consecutive failure{b.consecutiveFailures === 1 ? "" : "s"}</div>}
                  </td>
                  <td data-label="Robots" className="small">
                    <Badge value={b.robotsStatus ?? "UNCHECKED"} tone={tone(b.robotsStatus)} />
                    {b.robotsCheckedAt && <div className="muted">{when(b.robotsCheckedAt)}</div>}
                  </td>
                  <td data-label="Last crawl" className="small">
                    {when(b.lastCrawlAt)}
                  </td>
                  <td data-label="Next crawl" className="small">
                    {when(b.nextCrawlAt)}
                  </td>
                  <td data-label="Runs" className="num">{r?._count._all ?? 0}</td>
                  <td data-label="Found" className="num">{r?._sum.extracted ?? 0}</td>
                  <td data-label="Updated" className="num">{r?._sum.accepted ?? 0}</td>
                  <td data-label="Last error" className="small" style={{ wordBreak: "break-word" }}>
                    {b.lastError ?? "—"}
                  </td>
                </tr>
              );
            })}
            {!brands.length && (
              <tr>
                <td colSpan={10}>
                  No brands configured yet. <Link href="/admin/commerce/brands">Add brands</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 id="cs-sources-h">Non-brand sources</h2>
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
              <th scope="col" className="num">Found</th>
              <th scope="col" className="num">Updated</th>
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
                  <td data-label="Found" className="num">{r?._sum.extracted ?? 0}</td>
                  <td data-label="Updated" className="num">{r?._sum.accepted ?? 0}</td>
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
