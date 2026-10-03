import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import SectionHeader from "@/components/section-header";
import { db } from "@/lib/db";
import { dealLedgerSummary, dealMerchants, lapsedOffers, VERIFIED_LINK, verifiedDealRows } from "@/lib/public/queries";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { dateline, shortDate } from "@/lib/util/format";

export const dynamic = "force-dynamic";
type Search = { category?: string; merchant?: string; q?: string };

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const sp = await searchParams;
  // Filtered views and an empty ledger are not useful search results.
  const thin = Boolean(sp.category || sp.merchant || sp.q) || (await db.affiliateLink.count({ where: { ...VERIFIED_LINK, review: { status: "PUBLISHED" } } })) === 0;
  return { title: "Verified deals", description: "Offers on reviewed products whose links we have checked, with the date of the last check.", alternates: { canonical: "/deals" }, robots: thin ? { index: false, follow: true } : undefined };
}

export default async function Deals({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const category = sp.category && CATEGORY_BY_SLUG.has(sp.category) ? sp.category : undefined;
  const merchant = sp.merchant ? sp.merchant.slice(0, 120) : undefined;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const [rows, { counts, newest }, merchants, lapsed] = await Promise.all([verifiedDealRows({ categorySlug: category, merchant, q, take: 80 }), dealLedgerSummary(), dealMerchants(), lapsedOffers(8, category)]);
  const filtered = Boolean(category || merchant || q);
  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const next = { category, merchant, q: q || undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/deals${s ? `?${s}` : ""}`;
  };

  return (
    <main style={themeStyle(category) as React.CSSProperties}>
      <section className="page-hero">
        <div className="wrap">
          <div className="ph-top">
            <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Verified deals", href: "/deals" }]} />
            <span className="label muted">{newest ? `Last check ${dateline(newest)}` : "No checks yet"}</span>
          </div>
          <h1>
            Real deals.
            <span style={{ display: "block", fontSize: "0.4em", lineHeight: 0.95, marginTop: "0.14em", fontVariationSettings: "\"wdth\" 88", letterSpacing: "0.005em" }}>Checked before we show them.</span>
          </h1>
          <p className="lede">Only offers whose link we followed to the retailer and confirmed. Prices and availability are the retailer’s and can change; every card says when we last checked.</p>
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
            <button className="btn primary" type="submit">
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
        <div className="wrap">
          <div className="result-bar">
            <h2 id="deal-results" className="label" style={{ margin: 0 }} aria-live="polite">
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
            <EmptyState title={filtered ? "No verified offer matches." : "No verified offers yet."} label="Deals" action={filtered ? <Link className="btn" href="/deals">Show all deals</Link> : <Link className="btn" href="/reviews">Browse all reviews</Link>}>
              {filtered ? "Nothing matches these filters right now." : "We list an offer only after checking its link. Reviews without a verified offer are still available."}
            </EmptyState>
          )}
        </div>
      </section>
      {lapsed.length > 0 && (
        <section className="section tight" aria-labelledby="lapsed-title">
          <div className="wrap">
            <SectionHeader id="lapsed-title" label={`${lapsed.length} removed`} title="Offers we’ve taken down">
              These products had an offer that failed its latest check, so we removed it. We’ll show a new one once it’s verified.
            </SectionHeader>
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
