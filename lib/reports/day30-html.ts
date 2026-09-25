import type { Day30Report } from "./day30";

/** Renders the Day-30 report as a standalone, escaped HTML document. */

const esc = (v: unknown) =>
  String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function fmt(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v <= 1 && v >= 0 ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
  if (v === null || v === undefined) return "—";
  return String(v);
}

function table(title: string, obj: Record<string, unknown>): string {
  const rows = Object.entries(obj)
    .filter(([, v]) => typeof v !== "object" || v === null)
    .map(([k, v]) => `<tr><th scope="row">${esc(k.replace(/([A-Z])/g, " $1").toLowerCase())}</th><td>${esc(fmt(v))}</td></tr>`)
    .join("");
  return `<section><h2>${esc(title)}</h2><table><tbody>${rows}</tbody></table></section>`;
}

function grid(title: string, header: string[], rows: unknown[][], empty: string): string {
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(fmt(c))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${header.length}">${esc(empty)}</td></tr>`;
  return `<section><h2>${esc(title)}</h2><table><thead><tr>${header.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></section>`;
}

export function renderDay30Html(r: Day30Report): string {
  const integrations = Object.entries(r.environment.integrations).map(([k, v]) => [k, v]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Made4Buyers Day-30 Success Report</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#17202a;background:#f7f8fa;margin:0;padding:24px}
main{max-width:980px;margin:auto}h1{margin:0 0 4px}section{background:#fff;border:1px solid #e3e7eb;border-radius:12px;padding:16px 20px;margin:16px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #edf0f2;vertical-align:top}th{color:#56616d;font-weight:600}
.muted{color:#68737e}.flag{font-weight:700}
</style></head><body><main>
<h1>Day-30 Success Report</h1>
<p class="muted">Period ${esc(r.period.start)} → ${esc(r.period.end)} · generated ${esc(r.generatedAt)} · commit ${esc(r.environment.commit ?? "unknown")} · ${esc(r.environment.environment)}</p>
<p class="muted">All values are computed from persisted records. Integrations without credentials are reported as BLOCKED_BY_ENVIRONMENT / NOT_AVAILABLE_IN_ENVIRONMENT, not as zero.</p>
${grid("Integration status", ["Integration", "State"], integrations, "")}
${table("Ingestion", r.ingestion)}
${table("Deal coverage", r.dealCoverage)}
${table("Link health", r.linkHealth)}
${table("Categorization", r.categorization)}
${table("Images", r.images)}
${table("SEO / indexing", r.seoIndexing)}
${grid(`CTR by category (minimum ${r.ctr.minimumImpressions} eligible impressions)`, ["Category", "Eligible impressions", "Clicks", "CTR", "Data sufficiency"], r.ctr.categories.map((c) => [c.categorySlug, c.eligibleImpressions, c.clicks, c.ctr, c.dataSufficiency]), r.ctr.note ?? "INSUFFICIENT_DATA")}
${grid("Success metrics", ["Metric", "Formula", "Numerator", "Denominator", "Value", "Target", "Status"], r.successMetrics.map((m) => [m.label, m.formula, m.numerator, m.denominator, m.value, `${m.comparator} ${(m.target * 100).toFixed(0)}%`, m.status]), "")}
${grid("Top failure reasons", ["Error code", "Stage", "Count", "Share", "Latest occurrence"], r.topFailureReasons.map((f) => [f.errorCode, f.stage, f.count, f.percentage, f.latestOccurrence]), "No failures recorded in this window")}
${grid(`Fixes shipped (source: ${r.fixesShipped.source})`, ["Commit", "Date", "Change"], r.fixesShipped.changes.map((c) => [c.sha, c.date, c.subject]), "No release notes available in this environment")}
</main></body></html>`;
}
