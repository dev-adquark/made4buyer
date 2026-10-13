import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { db } from "@/lib/db";
import { categoryCounts } from "@/lib/public/queries";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { matchHref, type MatchPicks, type MatchStep as Step } from "@/lib/public/listing-routes";
import { advance, currentStep, facetLoader, MATCH_TAG, matchResults, TAG_STEPS, type MatchOption, type TagStep } from "@/lib/public/match";
import { tagListingPage } from "@/lib/public/page-cache";
import MatchStep from "./match-step";

/*
 * Rendered by page.tsx (the first question) and v/[state]/page.tsx (later steps and results; the
 * answers in the query string are rewritten there by proxy.ts). Both are cached (ISR).
 *
 * Answer links are plain <a> elements (full loads of cached HTML), not next/link: the answers live
 * in the query string and proxy.ts picks the route from it, which the client router cannot see. A
 * client-side navigation from /match to /match?category=… reused the cached /match page (the first
 * question) under the new URL, so choosing an answer appeared to do nothing.
 */

const STEPS: Array<{ key: Step; label: string; question: string }> = [
  { key: "category", label: "Buying", question: "What are you buying?" },
  { key: "intent", label: "Matters most", question: "What matters most?" },
  { key: "platform", label: "Platform", question: "Which platform?" },
  { key: "tier", label: "Budget", question: "What’s your budget?" },
];
const NO_DATA: Record<TagStep, string> = {
  intent: "We don’t have buying-priority details",
  platform: "We don’t have platform details",
  tier: "We don’t hold verified price ranges",
};

export const matchMetadata: Metadata = { title: "Find my match", description: "Answer a few questions and see the reviewed products that fit what you need.", robots: { index: false, follow: true }, alternates: { canonical: "/match" } };

/** Per-step title, so each step (a page load) is announced by what it asks. */
export function matchMetadataFor(picks: MatchPicks): Metadata {
  const step = currentStep(picks);
  const at = STEPS.findIndex((s) => s.key === step);
  return { ...matchMetadata, title: step ? `${STEPS[at].question} (step ${at + 1} of 4) · Find my match` : "Your match · Find my match" };
}

/** One step of the match flow for the answers so far (`picks`, already validated by the route codec). */
export async function MatchView({ picks: requested }: { picks: MatchPicks }) {
  await tagListingPage();
  const counts = await categoryCounts();
  const category = requested.category ? (CATEGORY_BY_SLUG.get(requested.category) ?? null) : null;
  const categoryCount = category ? (counts.find((c) => c.slug === category.slug)?.count ?? 0) : 0;

  // Answers must be real tags: an answer we do not know (an old or edited link) is asked again.
  const chosen = TAG_STEPS.filter((k) => requested[k] && requested[k] !== "any");
  const tagNames = chosen.length ? await db.categoryTag.findMany({ where: { OR: chosen.map((k) => ({ type: MATCH_TAG[k], slug: requested[k]! })) }, select: { type: true, slug: true, name: true } }) : [];
  const nameOf = (k: TagStep) => tagNames.find((t) => t.type === MATCH_TAG[k] && t.slug === requested[k])?.name;
  const picks: MatchPicks = category ? { category: category.slug } : {};
  let invalidAnswer = false;
  if (category) {
    for (const k of TAG_STEPS) {
      const v = requested[k];
      if (!v) break;
      if (v !== "any" && !nameOf(k)) {
        invalidAnswer = true;
        break;
      }
      picks[k] = v;
    }
  }
  const current = currentStep(picks);
  const facets = category ? facetLoader(category.slug) : null;
  const upTo = (step: Step): MatchPicks => Object.fromEntries(STEPS.slice(0, STEPS.findIndex((s) => s.key === step)).map((s) => [s.key, picks[s.key]]));

  // Steps answered "any" because there was nothing to choose: shown as "Not available", never as a choice.
  const unavailable = new Set<TagStep>();
  if (facets) {
    for (const k of TAG_STEPS) {
      if (picks[k] === "any" && !(await facets(upTo(k)))[k].length) unavailable.add(k);
    }
  }
  const labelFor = (step: Step) => {
    const v = picks[step];
    if (!v) return null;
    if (step === "category") return category?.name ?? v;
    if (v === "any") return unavailable.has(step) ? "Not available" : "Any";
    return nameOf(step) ?? v;
  };

  // The current question's options, each linking to the next question that can narrow anything.
  const empty = Boolean(category && !categoryCount);
  let options: Array<MatchOption & { href: string }> = [];
  let skipHref = "/match";
  if (current && current !== "category" && facets && !empty) {
    const f = await facets(picks);
    options = await Promise.all(f[current].map(async (o) => ({ ...o, href: matchHref(await advance({ ...picks, [current]: o.slug }, facets)) })));
    skipHref = matchHref(await advance({ ...picks, [current]: "any" }, facets));
  }
  const categoryOptions =
    current === "category" ? await Promise.all(counts.map(async (c) => ({ ...c, href: c.count ? matchHref(await advance({ category: c.slug }, facetLoader(c.slug))) : null }))) : [];

  const { results, relaxed } = !current && category && !empty ? await matchResults(category.slug, picks) : { results: [], relaxed: [] as TagStep[] };
  const matchedOn = TAG_STEPS.filter((k) => picks[k] && picks[k] !== "any" && !relaxed.includes(k)).map((k) => nameOf(k)!);
  const stepLabel = (k: Step) => STEPS.find((s) => s.key === k)!.label.toLowerCase();
  const stepNumber = current ? STEPS.findIndex((s) => s.key === current) + 1 : 5;

  return (
    <main style={themeStyle(category?.slug) as React.CSSProperties}>
      <section className="section tight">
        <div className="wrap match-stage">
          <div>
            <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Find my match", href: "/match" }]} />
            <ol className="match-progress" aria-label="Progress">
              {STEPS.map((s, i) => {
                const done = Boolean(picks[s.key]);
                return (
                  <li key={s.key} className={done ? "done" : undefined} aria-current={current === s.key ? "step" : undefined}>
                    {done ? (
                      <a href={matchHref(upTo(s.key))}>
                        {String(i + 1).padStart(2, "0")} {s.label}
                        <span className="val">{labelFor(s.key)}</span>
                        <span className="visually-hidden"> (change)</span>
                      </a>
                    ) : (
                      <>
                        {String(i + 1).padStart(2, "0")} {s.label}
                      </>
                    )}
                  </li>
                );
              })}
              <li className={!current ? "done" : undefined} aria-current={!current ? "step" : undefined}>
                05 Your match
              </li>
            </ol>
          </div>

          <MatchStep>
            {empty && category ? (
              <>
                <h1 className="match-q" tabIndex={-1}>
                  No match yet.
                </h1>
                <EmptyState
                  title={`No ${category.name.toLowerCase()} reviews yet.`}
                  label="Match"
                  action={
                    <>
                      <a className="btn primary" href="/match">
                        Choose another category
                      </a>
                      <Link className="btn" href="/reviews">
                        Browse all reviews
                      </Link>
                    </>
                  }
                >
                  We haven’t published a review in this category yet, so there is nothing to match. We never fill this list with products from other categories.
                </EmptyState>
              </>
            ) : current === "category" ? (
              <>
                <h1 className="match-q" tabIndex={-1}>
                  <span className="visually-hidden">Step 1 of 4: </span>
                  {STEPS[0].question}
                </h1>
                {requested.unknown && (
                  <p className="notice warn" role="status">
                    We don’t cover that category. Choose one below.
                  </p>
                )}
                <ul className="option-grid">
                  {categoryOptions.map((c) => (
                    <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                      {c.href ? (
                        <a href={c.href} data-cursor="Choose">
                          <CategoryIcon slug={c.slug} />
                          <strong>{c.name}</strong>
                          <span>{c.count === 1 ? "1 reviewed product" : `${c.count} reviewed products`}</span>
                        </a>
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
            ) : current && category ? (
              <>
                <h1 className="match-q" tabIndex={-1}>
                  <span className="visually-hidden">{`Step ${stepNumber} of 4: `}</span>
                  {STEPS[stepNumber - 1].question}
                </h1>
                {invalidAnswer && (
                  <p className="notice warn" role="status">
                    That answer isn’t available any more. Choose again.
                  </p>
                )}
                {options.length === 0 && (
                  <p className="lede">
                    {NO_DATA[current as TagStep]} for the {category.name.toLowerCase()} we’ve reviewed so far, so this question can’t narrow anything.
                  </p>
                )}
                <ul className="option-grid">
                  {options.map((o) => (
                    <li key={o.slug}>
                      <a href={o.href} data-cursor="Choose">
                        <strong>{o.name}</strong>
                        <span>{o.count === 1 ? "1 matching product" : `${o.count} matching products`}</span>
                      </a>
                    </li>
                  ))}
                  <li>
                    <a href={skipHref} data-cursor="Skip">
                      <strong>{options.length ? "No preference" : "Continue"}</strong>
                      <span>{options.length ? "Keep every option open" : "Skip this question"}</span>
                    </a>
                  </li>
                </ul>
              </>
            ) : category ? (
              <>
                <h1 className="match-q" tabIndex={-1}>
                  {results.length ? "Your match." : "No match yet."}
                </h1>
                <h2 className="label muted" style={{ fontFamily: "var(--f-mono)" }}>
                  {results.length ? `Your matches in ${category.name.toLowerCase()}` : `Nothing in ${category.name.toLowerCase()} yet`}
                </h2>
                {matchedOn.length > 0 && <p className="lede">Every product below is tagged {matchedOn.map((n) => `“${n}”`).join(" and ")} in our reviews, newest review first.</p>}
                {relaxed.length > 0 && (
                  <p className="notice warn" role="status">
                    Nothing matched every answer, so we’ve ignored your {relaxed.map(stepLabel).join(" and ")} answer.
                  </p>
                )}
                {unavailable.size > 0 && (
                  <p className="muted">
                    {[...unavailable].map((k) => `${STEPS.find((s) => s.key === k)!.label}: not available`).join(" · ")}.{" "}
                    {unavailable.has("tier") ? "We don’t hold verified price ranges for these products, so budget couldn’t narrow the list. A price appears on a review only while it was recently checked." : "We don’t have that detail for these products, so it couldn’t narrow the list."}
                  </p>
                )}
                {results.length ? (
                  <>
                    <ReviewGrid reviews={results} eagerCount={3} layout="ruled" />
                    <div className="btnrow" style={{ marginTop: 32 }}>
                      {results.length >= 2 && (
                        <Link className="btn primary" href={`/compare?ids=${results.slice(0, 3).map((r) => r.id).join(",")}`} data-cursor="Compare">
                          Compare the top {Math.min(3, results.length)}
                        </Link>
                      )}
                      <a className="btn" href={matchHref({ category: category.slug })}>
                        Change answers
                      </a>
                      <Link className="btn" href={`/category/${category.slug}`}>
                        All {category.name.toLowerCase()}
                      </Link>
                      <a className="btn" href="/match">
                        Start again
                      </a>
                    </div>
                  </>
                ) : (
                  <EmptyState title={`No ${category.name.toLowerCase()} reviews yet.`} label="Match" action={<a className="btn" href="/match">Start again</a>} />
                )}
              </>
            ) : null}
          </MatchStep>
        </div>
      </section>
    </main>
  );
}
