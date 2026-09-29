import type { Prisma } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { db } from "@/lib/db";
import { cardSelect, categoryCounts, facetCounts, LATEST_FIRST } from "@/lib/public/queries";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Find my match", description: "Answer a few questions and see the reviewed products that fit what you need.", robots: { index: false, follow: true }, alternates: { canonical: "/match" } };

type Step = "category" | "intent" | "platform" | "tier";
const STEPS: Array<{ key: Step; label: string; question: string }> = [
  { key: "category", label: "What you’re buying", question: "What are you shopping for?" },
  { key: "intent", label: "What it’s for", question: "What will you mostly use it for?" },
  { key: "platform", label: "Platform", question: "Any platform you need it to work with?" },
  { key: "tier", label: "Budget", question: "Which price range suits you?" },
];
const TAG: Record<Exclude<Step, "category">, "INTENT" | "PLATFORM" | "PRICE_TIER"> = { intent: "INTENT", platform: "PLATFORM", tier: "PRICE_TIER" };

const clean = (v?: string) => (v && /^[a-z0-9-]{1,60}$/.test(v) ? v : undefined);

function whereFor(category: string, picks: Partial<Record<Step, string>>, drop: Step[] = []): Prisma.NormalizedReviewWhereInput {
  return {
    categorySlug: category,
    AND: (["intent", "platform", "tier"] as const)
      .filter((k) => picks[k] && picks[k] !== "any" && !drop.includes(k))
      .map((k) => ({ assignments: { some: { active: true, tagType: TAG[k], categoryTag: { slug: picks[k]! } } } })),
  };
}

export default async function MatchPage({ searchParams }: { searchParams: Promise<Partial<Record<Step, string>>> }) {
  const sp = await searchParams;
  const picks: Partial<Record<Step, string>> = {};
  for (const s of STEPS) {
    const v = clean(sp[s.key]);
    if (v) picks[s.key] = v;
  }
  if (picks.category && !CATEGORY_BY_SLUG.has(picks.category)) delete picks.category;
  const current = STEPS.find((s) => !picks[s.key])?.key ?? null;
  const href = (patch: Partial<Record<Step, string | undefined>>) => {
    const p = new URLSearchParams();
    const next = { ...picks, ...patch };
    for (const s of STEPS) if (next[s.key]) p.set(s.key, next[s.key]!);
    const q = p.toString();
    return `/match${q ? `?${q}` : ""}`;
  };
  const upTo = (step: Step) => Object.fromEntries(STEPS.slice(0, STEPS.findIndex((s) => s.key === step)).map((s) => [s.key, picks[s.key]])) as Partial<Record<Step, string>>;

  const counts = await categoryCounts();
  const category = picks.category ? CATEGORY_BY_SLUG.get(picks.category)! : null;

  // Options for the current step: real tag values among published reviews that fit earlier answers.
  let options: Array<{ slug: string; name: string; count: number }> = [];
  if (current && current !== "category" && category) {
    const f = await facetCounts(whereFor(category.slug, upTo(current)));
    options = f[current];
  }

  // Results: strict match first; if nothing fits, relax the latest answers one by one and say so.
  let results: Awaited<ReturnType<typeof db.normalizedReview.findMany<{ select: typeof cardSelect }>>> = [];
  let relaxed: Step[] = [];
  if (!current && category) {
    for (const drop of [[], ["tier"], ["tier", "platform"], ["tier", "platform", "intent"]] as Step[][]) {
      results = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", ...whereFor(category.slug, picks, drop) }, orderBy: LATEST_FIRST, take: 12, select: cardSelect });
      if (results.length) {
        relaxed = drop.filter((d) => picks[d] && picks[d] !== "any");
        break;
      }
    }
  }
  const chosen = (["intent", "platform", "tier"] as const).filter((k) => picks[k] && picks[k] !== "any");
  const tagNames = chosen.length ? await db.categoryTag.findMany({ where: { OR: chosen.map((k) => ({ type: TAG[k], slug: picks[k]! })) }, select: { type: true, slug: true, name: true } }) : [];
  const labelFor = (step: Step) => {
    const v = picks[step];
    if (!v) return null;
    if (v === "any") return "Any";
    if (step === "category") return category?.name ?? v;
    return tagNames.find((t) => t.type === TAG[step as Exclude<Step, "category">] && t.slug === v)?.name ?? v;
  };

  return (
    <main style={themeStyle(category?.slug) as React.CSSProperties}>
      <section className="page-hero on-ink">
        <div className="container">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Find my match", href: "/match" }]} />
          <h1>Find my match</h1>
          <p className="lede">Four quick questions. We match your answers against how each reviewed product is filed, and show only what we’ve actually reviewed.</p>
        </div>
      </section>
      <section className="section">
        <div className="container wizard">
          <ol className="wizard-steps" aria-label="Progress">
            {STEPS.map((s, i) => {
              const done = Boolean(picks[s.key]);
              return (
                <li key={s.key} className={done ? "done" : undefined} aria-current={current === s.key ? "step" : undefined}>
                  <span className="n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="label">
                    {done ? (
                      <Link href={href(Object.fromEntries(STEPS.slice(i).map((x) => [x.key, undefined])))} style={{ color: "inherit" }}>
                        {s.label}: {labelFor(s.key)}
                        <span className="visually-hidden"> (change)</span>
                      </Link>
                    ) : (
                      s.label
                    )}
                  </span>
                </li>
              );
            })}
            <li className={!current ? "done" : undefined} aria-current={!current ? "step" : undefined}>
              <span className="n" aria-hidden="true">
                {STEPS.length + 1}
              </span>
              <span className="label">Your matches</span>
            </li>
          </ol>

          <div>
            {current === "category" && (
              <>
                <h2>{STEPS[0].question}</h2>
                <ul className="option-grid">
                  {counts.map((c) => (
                    <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                      {c.count ? (
                        <Link href={href({ category: c.slug })}>
                          <CategoryIcon slug={c.slug} />
                          <strong>{c.name}</strong>
                          <span>{c.count === 1 ? "1 reviewed product" : `${c.count} reviewed products`}</span>
                        </Link>
                      ) : (
                        <div className="off">
                          <CategoryIcon slug={c.slug} />
                          <strong>{c.name}</strong>
                          <span>No reviews yet</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {current && current !== "category" && (
              <>
                <h2>{STEPS.find((s) => s.key === current)!.question}</h2>
                {options.length === 0 && <p className="muted">We don’t have this detail for the {category?.name.toLowerCase()} we’ve reviewed so far, so this question can be skipped.</p>}
                <ul className="option-grid">
                  {options.map((o) => (
                    <li key={o.slug}>
                      <Link href={href({ [current]: o.slug })}>
                        <strong>{o.name}</strong>
                        <span>{o.count === 1 ? "1 matching product" : `${o.count} matching products`}</span>
                      </Link>
                    </li>
                  ))}
                  <li>
                    <Link href={href({ [current]: "any" })}>
                      <strong>{options.length ? "No preference" : "Skip this question"}</strong>
                      <span>Keep every option open</span>
                    </Link>
                  </li>
                </ul>
              </>
            )}

            {!current && category && (
              <>
                <h2>{results.length ? `Your matches in ${category.name.toLowerCase()}` : "No matches yet"}</h2>
                {relaxed.length > 0 && (
                  <p className="notice warn" role="status">
                    Nothing matched every answer, so we’ve ignored your {relaxed.map((r) => STEPS.find((s) => s.key === r)!.label.toLowerCase()).join(" and ")} answer.
                  </p>
                )}
                {results.length ? (
                  <>
                    <ReviewGrid reviews={results} eagerCount={3} />
                    <div className="btnrow">
                      {results.length >= 2 && (
                        <Link className="btn primary" href={`/compare?ids=${results.slice(0, 3).map((r) => r.id).join(",")}`}>
                          Compare the top {Math.min(3, results.length)}
                        </Link>
                      )}
                      <Link className="btn" href="/match">
                        Start again
                      </Link>
                    </div>
                  </>
                ) : (
                  <EmptyState title={`No ${category.name.toLowerCase()} reviews are published yet.`} action={<Link className="btn" href="/match">Start again</Link>} />
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
