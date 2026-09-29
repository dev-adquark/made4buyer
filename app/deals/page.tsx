import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import { dealMerchants, lapsedOffers, verifiedDealRows } from "@/lib/public/queries";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { shortDate } from "@/lib/util/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verified deals", description: "Offers on reviewed products whose links we have checked, with the date of the last check.", alternates: { canonical: "/deals" } };

type Search = { category?: string; merchant?: string; q?: string };

export default async function Deals({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const category = sp.category && CATEGORY_BY_SLUG.has(sp.category) ? sp.category : undefined;
  const merchant = sp.merchant ? sp.merchant.slice(0, 120) : undefined;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const [rows, all, merchants, lapsed] = await Promise.all([verifiedDealRows({ categorySlug: category, merchant, q, take: 80 }), verifiedDealRows({ take: 300 }), dealMerchants(), lapsedOffers(8, category)]);
  const counts = new Map<string, number>();
  for (const r of all) if (r.review.categorySlug) counts.set(r.review.categorySlug, (counts.get(r.review.categorySlug) ?? 0) + 1);
  const filtered = Boolean(category || merchant || q);
  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const next = { category, merchant, q: q || undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/deals${s ? `?${s}` : ""}`;
  };
  const newest = all.reduce<Date | null>((d, r) => (!d || r.verifiedAt > d ? r.verifiedAt : d), null);

  return (
    <main style={themeStyle(category) as React.CSSProperties}>
      <section className="page-hero on-ink">
        <div className="container">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Verified deals", href: "/deals" }]} />
          <h1>Verified deals</h1>
          <p className="lede">
            Only offers whose link we followed to the retailer and confirmed. Prices and availability are the retailer’s and can change.
            {newest ? ` Most recent check: ${shortDate(newest)}.` : ""}
          </p>
          <form action="/deals" role="search" className="searchbox wide" style={{ maxWidth: 720, marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {category && <input type="hidden" name="category" value={category} />}
            <label htmlFor="deal-q" className="visually-hidden">
              Search deals
            </label>
            <svg className="search-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input id="deal-q" name="q" type="search" defaultValue={q} maxLength={80} placeholder="Search deals by product or brand" style={{ flex: "1 1 240px" }} />
            {merchants.length > 0 && (
              <>
                <label htmlFor="deal-m" className="visually-hidden">
                  Merchant
                </label>
                <select id="deal-m" name="merchant" defaultValue={merchant ?? ""} style={{ flex: "0 1 220px" }}>
                  <option value="">All merchants</option>
                  {merchants.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} ({m.count})
                    </option>
                  ))}
                </select>
              </>
            )}
            <button className="btn light" type="submit">
              Show deals
            </button>
          </form>
          <nav aria-label="Filter deals by category">
            <ul className="chips" style={{ marginTop: 16 }}>
              <li>
                <Link className="chip" href={href({ category: undefined })} aria-current={!category ? "true" : undefined}>
                  All
                </Link>
              </li>
              {CATEGORIES.filter((c) => counts.get(c.slug)).map((c) => (
                <li key={c.slug}>
                  <Link className="chip" href={href({ category: c.slug })} aria-current={category === c.slug ? "true" : undefined}>
                    {c.name} ({counts.get(c.slug)})
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <section className="section" aria-labelledby="deal-results">
        <div className="container">
          <div className="result-bar">
            <h2 id="deal-results" style={{ font: "600 15px var(--font-body)", margin: 0 }} aria-live="polite">
              {rows.length === 1 ? "1 verified offer" : `${rows.length} verified offers`}
              {q ? ` matching “${q}”` : ""}
              {merchant ? ` at ${merchant}` : ""}
            </h2>
            {filtered && (
              <Link className="btn small" href="/deals">
                Clear filters
              </Link>
            )}
          </div>
          {rows.length ? (
            <DealLedger rows={rows} />
          ) : (
            <EmptyState title="No verified offer currently available." action={filtered ? <Link className="btn" href="/deals">Show all deals</Link> : <Link className="btn" href="/reviews">Browse all reviews</Link>}>
              {filtered ? "Nothing matches these filters right now." : "We list an offer only after checking its link. Reviews without a verified offer are still available."}
            </EmptyState>
          )}
        </div>
      </section>
      {lapsed.length > 0 && (
        <section className="section band" aria-labelledby="lapsed-title">
          <div className="container">
            <div className="section-head">
              <div>
                <h2 id="lapsed-title">Offers we’ve taken down</h2>
                <p>These products had an offer that failed its latest check, so we removed it. We’ll show a new one once it’s verified.</p>
              </div>
            </div>
            <ul className="ledger">
              {lapsed.map((r) => (
                <li key={r.id} style={themeStyle(r.categorySlug) as React.CSSProperties}>
                  <div className="ledger-row unavailable" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)" }}>
                    <Link className="l-title" href={`/review/${r.slug}`}>
                      {r.productName}
                    </Link>
                    <div className="l-meta">
                      No verified offer currently available.
                      {r.dealCheckedAt ? (
                        <>
                          {" "}
                          Last checked <time dateTime={r.dealCheckedAt.toISOString()}>{shortDate(r.dealCheckedAt)}</time>.
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
