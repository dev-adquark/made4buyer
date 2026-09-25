import type { Metadata } from "next";
import ReviewCard from "@/components/review-card";
import TrackOnce from "@/components/track-once";
import { searchReviews } from "@/lib/public/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search reviews", robots: { index: false, follow: true }, alternates: { canonical: "/search" } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: raw } = await searchParams;
  const q = (raw ?? "").trim().slice(0, 100);
  const results = q ? await searchReviews(q) : [];
  return (
    <main className="section">
      <div className="container">
        <h1>Search technology reviews</h1>
        <form className="hero-search" role="search" action="/search">
          <label htmlFor="search-q" className="visually-hidden">
            Search query
          </label>
          <input id="search-q" name="q" type="search" defaultValue={q} placeholder="Search laptops, phones, AI tools…" maxLength={100} />
          <button className="btn primary" type="submit">
            Search
          </button>
        </form>
        {q && (
          <>
            <TrackOnce event="search" metadata={{ q, results: results.length }} />
            <p className="muted" aria-live="polite">
              {results.length === 1 ? "1 result" : `${results.length} results`} for “{q}”
            </p>
          </>
        )}
        {q && !results.length && <p className="notice">No published reviews match your search. Try a product name, brand or category.</p>}
        <div className="grid">
          {results.map((r) => (
            <ReviewCard key={r.id} review={r} />
          ))}
        </div>
      </div>
    </main>
  );
}
