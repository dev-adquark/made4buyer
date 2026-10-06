import Link from "next/link";
import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import type { FactSummary } from "@/lib/products/enrich";

export const dynamic = "force-dynamic";
export const metadata = { title: "Product data" };

const TONE: Record<string, "ok" | "warn" | "error" | "info" | "neutral"> = { VERIFIED: "ok", SUPPORTED: "info", CONFLICTING: "error", STALE: "warn", UNKNOWN: "neutral", UNAVAILABLE: "neutral", NOT_APPLICABLE: "neutral", COMPLETE: "ok", PARTIAL: "warn", MISSING: "error" };

const show = (v: unknown) => (v == null ? "—" : Array.isArray(v) ? v.join(", ") : String(v));

/** Admin → Product data: completeness, conflicts, staleness and every field's provenance. */
export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const filter = param(sp, "status");
  const id = param(sp, "id");
  const where = { content: { some: { review: { status: "PUBLISHED" as const } } }, ...(filter === "NOT_ENRICHED" ? { enrichedAt: null } : filter ? { enrichmentStatus: filter } : {}) };
  const [rows, byStatus, notEnriched, detail] = await Promise.all([
    db.productEntity.findMany({ where, orderBy: [{ enrichedAt: { sort: "desc", nulls: "last" } }], take: 100, select: { id: true, name: true, brand: true, categorySlug: true, enrichmentStatus: true, enrichedAt: true, factSummary: true } }),
    db.productEntity.groupBy({ by: ["enrichmentStatus"], where: { content: { some: { review: { status: "PUBLISHED" } } } }, _count: { _all: true } }),
    db.productEntity.count({ where: { enrichedAt: null, content: { some: { review: { status: "PUBLISHED" } } } } }),
    id ? db.productEntity.findUnique({ where: { id }, include: { facts: { orderBy: [{ field: "asc" }, { observedAt: "desc" }] } } }) : Promise.resolve(null),
  ]);
  const count = (s: string) => byStatus.find((b) => b.enrichmentStatus === s)?._count._all ?? 0;
  const summary = (detail?.factSummary ?? null) as FactSummary | null;
  return (
    <>
      <h1>Product data</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Every product field is enriched on its own from the sources that can state it: the review source, and known manufacturer and retailer pages for that exact product. Each value keeps its source and check time. A value is used only after an exact-product match, and a field no source states stays &ldquo;Not available&rdquo;. Nothing is guessed.
      </p>
      <div className="stats">
        <Stat label="Complete" value={count("COMPLETE")} />
        <Stat label="Partially complete" value={count("PARTIAL")} />
        <Stat label="Missing core fields" value={count("MISSING")} />
        <Stat label="Not enriched yet" value={notEnriched} note="picked up by the enrich-products job" />
      </div>
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "enrich-products" }} label="Enrich products now" returnTo="/admin/products" />
      </div>
      <nav aria-label="Filter">
        <ul className="chips">
          {["", "COMPLETE", "PARTIAL", "MISSING", "NOT_ENRICHED"].map((s) => (
            <li key={s || "all"}>
              <Link className="chip neutral" href={s ? `/admin/products?status=${s}` : "/admin/products"} aria-current={(filter ?? "") === s ? "true" : undefined}>
                {s || "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {detail && summary && (
        <section aria-labelledby="detail-h">
          <h2 id="detail-h">
            {detail.name} <Badge value={detail.enrichmentStatus} tone={TONE[detail.enrichmentStatus ?? ""] ?? "neutral"} />
          </h2>
          <p className="small muted">
            Quality score {summary.quality ? `${summary.quality.score}/100 (${summary.quality.band.replace(/_/g, " ").toLowerCase()}; ${Object.entries(summary.quality.parts).map(([k, v]) => `${k} ${v}`).join(", ")})` : "not computed yet"}. Identity matched by {summary.identityBasis ?? "—"}. Next refresh {when(summary.nextRefreshAt ?? null)}. Last attempts: {summary.attempts?.join(" · ") || "—"}.
            <br />
            Resolved {when(summary.resolvedAt)}. Missing: {summary.missing.join(", ") || "none"}. Conflicting: {summary.conflicting.join(", ") || "none"}. Stale: {summary.stale.join(", ") || "none"}. Platform: {summary.platform === "NOT_APPLICABLE" ? "not applicable to this category" : "applies"}. Price tier: {summary.priceTier ? `${summary.priceTier.tier} (${summary.priceTier.methodology})` : "not derived (no current verified price)"}.
          </p>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Resolved value</th>
                  <th scope="col">Status</th>
                  <th scope="col">Source</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(summary.fields).map(([field, f]) => (
                  <tr key={field}>
                    <td data-label="Field">{field}</td>
                    <td data-label="Value">{show(f?.value)}{f?.unit ? ` ${f.unit}` : ""}</td>
                    <td data-label="Status"><Badge value={f?.status} tone={TONE[f?.status ?? ""] ?? "neutral"} /></td>
                    <td data-label="Source">{f?.sourceUrl ? <a href={f.sourceUrl} rel="noopener noreferrer" target="_blank">{f.sourceName}</a> : (f?.sourceName ?? "—")} <span className="small muted">{f?.source ?? ""}</span></td>
                    <td data-label="Checked">{when(f?.observedAt ?? null)}</td>
                    <td data-label="Note" className="small">{f?.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>All stored facts ({detail.facts.length})</summary>
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Value</th>
                    <th scope="col">Source</th>
                    <th scope="col">Match</th>
                    <th scope="col">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.facts.map((f) => (
                    <tr key={f.id}>
                      <td data-label="Field">{f.field}</td>
                      <td data-label="Value">{show(f.value)}{f.unit ? ` ${f.unit}` : ""}</td>
                      <td data-label="Source">{f.source} · {f.sourceName}</td>
                      <td data-label="Match">{f.matchBasis}</td>
                      <td data-label="Observed">{when(f.observedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Completeness</th>
              <th scope="col">Score</th>
              <th scope="col">Missing</th>
              <th scope="col">Conflicting / stale</th>
              <th scope="col">Enriched</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.factSummary as FactSummary | null;
              return (
                <tr key={r.id}>
                  <td data-label="Product">
                    <Link href={`/admin/products?id=${r.id}${filter ? `&status=${filter}` : ""}`}>{r.name}</Link>
                    <div className="small muted">{r.brand ?? "brand not established"}</div>
                  </td>
                  <td data-label="Completeness"><Badge value={r.enrichmentStatus ?? "NOT ENRICHED"} tone={TONE[r.enrichmentStatus ?? ""] ?? "neutral"} /></td>
                  <td data-label="Score">{s?.quality ? `${s.quality.score}` : "—"}</td>
                  <td data-label="Missing" className="small">{s?.missing.join(", ") || "—"}</td>
                  <td data-label="Conflicting / stale" className="small">{[...(s?.conflicting ?? []), ...(s?.stale ?? []).map((f) => `${f} (stale)`)].join(", ") || "—"}</td>
                  <td data-label="Enriched">{when(r.enrichedAt)}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={6}>No products match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
