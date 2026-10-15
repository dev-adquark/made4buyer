import Link from "next/link";
import { Badge, CostBadge, when } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { integrationReadiness } from "@/lib/ops/live-check";
import { affiliateCost, analyticsCost, apifyCommerceCost, apifyReviewCost, contentApiCost, feedicoCost, gscCost, keywordToBlogCost, pexelsCost, type CostInfo } from "@/lib/ops/api-costs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

const TONE = { READY: "ok", BLOCKED_BY_ENVIRONMENT: "warn", ERROR: "error" } as const;

/** Apify backs two separate budgets (review-scraping and the commerce engine); shown together here. */
function combinedApifyCost(review: CostInfo, commerce: CostInfo): CostInfo {
  if (review.nature === "PAID_TRACKED" && commerce.nature === "PAID_TRACKED") {
    const spentUsd = (review.spentUsd ?? 0) + (commerce.spentUsd ?? 0);
    const budgetUsd = (review.budgetUsd ?? 0) + (commerce.budgetUsd ?? 0);
    return { nature: "PAID_TRACKED", label: `Paid · $${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)} this month`, spentUsd, budgetUsd, remainingUsd: Math.max(0, budgetUsd - spentUsd), exhausted: review.exhausted || commerce.exhausted, basis: review.basis === "actual" && commerce.basis === "actual" ? "actual" : "estimated", detail: "Review-scraping and the commerce engine each have their own budget — see Admin → Sources and Admin → Commerce." };
  }
  return review.nature === "UNKNOWN" || commerce.nature === "UNKNOWN" ? { nature: "UNKNOWN", label: "Cost unavailable", detail: [review, commerce].find((c) => c.nature === "UNKNOWN")?.detail } : review;
}

/**
 * Every external integration in one table: READY / BLOCKED_BY_ENVIRONMENT / ERROR, the last
 * successful call recorded in the database, the latest error, and the exact env var NAMES still
 * missing. Never shows a value. Read-only: "Run live checks" (Go-live) makes the provider calls.
 *
 * Cost: Free, a real tracked $ budget, a paid plan this app cannot price per request, or unavailable
 * (lib/ops/api-costs.ts) — never "Free" for anything that can actually incur a charge.
 */
export default async function IntegrationsPage() {
  await requireAdminPage();
  const [rows, review, commerce, kwToBlog] = await Promise.all([integrationReadiness(), apifyReviewCost(), apifyCommerceCost(), keywordToBlogCost()]);
  const COST: Record<string, CostInfo> = {
    contentApi: contentApiCost(),
    apify: combinedApifyCost(review, commerce),
    pexels: pexelsCost(),
    feedico: feedicoCost(),
    keywordToBlog: kwToBlog,
    affiliate: affiliateCost(),
    gsc: gscCost(),
    analytics: analyticsCost(),
  };
  const counts = { READY: 0, BLOCKED_BY_ENVIRONMENT: 0, ERROR: 0 };
  for (const r of rows) counts[r.status]++;
  return (
    <>
      <h1>Integrations</h1>
      <p className="muted">
        Status of every external integration in this deployment. Missing variables are listed by name only; values are never shown. Set them in Vercel (Production), redeploy, then run the live checks. The owner steps are in <code>docs/OWNER_ACTIONS.md</code>.
      </p>
      <p className="muted" data-testid="integrations-summary">
        {counts.READY} ready · {counts.BLOCKED_BY_ENVIRONMENT} blocked by environment · {counts.ERROR} with errors
      </p>
      <form className="toolbar" action="/api/admin/live-check" method="post">
        <input type="hidden" name="returnTo" value="/admin/integrations" />
        <button className="btn primary" type="submit">
          Run live checks
        </button>
        <Link className="btn" href="/admin/go-live">
          Last live-check details
        </Link>
      </form>
      <div className="table-wrap">
        <table className="table responsive" data-testid="integrations-table">
          <thead>
            <tr>
              <th scope="col">Integration</th>
              <th scope="col">Status</th>
              <th scope="col">Cost</th>
              <th scope="col">Last successful call</th>
              <th scope="col">Missing env vars</th>
              <th scope="col">Latest error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-integration={r.key}>
                <td data-label="Integration">
                  <strong>{r.name}</strong>
                  {r.note && <div className="small muted">{r.note}</div>}
                </td>
                <td data-label="Status">
                  <Badge value={r.status} tone={TONE[r.status]} />
                </td>
                <td data-label="Cost">{COST[r.key] ? <CostBadge cost={COST[r.key]} /> : "—"}</td>
                <td data-label="Last successful call">{r.lastSuccessAt ? when(r.lastSuccessAt) : "never recorded"}</td>
                <td data-label="Missing env vars">
                  {r.missingEnv.length ? (
                    <ul className="plain">
                      {r.missingEnv.map((n) => (
                        <li key={n}>
                          <code>{n}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "none"
                  )}
                  {r.optionalMissing.length > 0 && <div className="small muted">Optional, not set: {r.optionalMissing.join(", ")}</div>}
                </td>
                <td data-label="Latest error" className="small">
                  {r.lastError ? (
                    <>
                      {when(r.lastError.at)}: {r.lastError.message}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
