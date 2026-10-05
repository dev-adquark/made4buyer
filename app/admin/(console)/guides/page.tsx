import Link from "next/link";
import Flash from "@/components/flash";
import { Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { aiGuidesConfigured } from "@/lib/pipeline/ai-guides";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI guides" };

export default async function GuidesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const configured = aiGuidesConfigured();
  const guides = await db.normalizedReview.findMany({ where: { kind: "AI_GUIDE" }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, canonicalTitle: true, productName: true, status: true, editorApprovedAt: true, editorApprovedBy: true, generationMeta: true, createdAt: true } });
  return (
    <>
      <h1>AI-assisted guides</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">Keyword-to-Blog writes a buying guide with an AI model. A successful generation is published straight away (direct-publish mode: no QA or approval gate; only repeated topics are prevented). Each page is labelled AI-assisted and says no editor reviewed it. Use Unpublish on a guide to take it down.</p>
      {!configured && <p className="notice warn">Keyword-to-Blog is BLOCKED_BY_ENVIRONMENT: set KEYWORD_TO_BLOG_API_URL and KEYWORD_TO_BLOG_API_KEY.</p>}
      <form action="/api/admin/guides" method="post" className="card card-body">
        <input type="hidden" name="returnTo" value="/admin/guides" />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="g-product">Product name</label>
            <input id="g-product" name="productName" required minLength={2} maxLength={120} placeholder="e.g. MacBook Air 13 (M4)" />
          </div>
          <div className="field">
            <label htmlFor="g-brand">Brand (optional)</label>
            <input id="g-brand" name="brand" maxLength={80} placeholder="e.g. Apple" />
          </div>
          <div className="field">
            <label htmlFor="g-cat">Category (optional)</label>
            <select id="g-cat" name="category" defaultValue="">
              <option value="">Detect automatically</option>
              {CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="g-kw">Keywords</label>
          <input id="g-kw" name="keywords" required placeholder="macbook air m4, best laptop for students" />
          <div className="field-hint">The first keyword is sent to Keyword-to-Blog (the request is kept to one keyword so generation stays fast).</div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="g-topic">Angle (optional)</label>
            <input id="g-topic" name="topic" maxLength={200} placeholder="Who should buy it and who should skip it" />
          </div>
          <div className="field">
            <label htmlFor="g-aud">Audience (optional)</label>
            <input id="g-aud" name="audience" maxLength={200} placeholder="Students on a budget" />
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={!configured}>
          Generate and publish
        </button>
        <p className="field-hint">Takes up to a minute. Uses one Keyword-to-Blog generation from your plan.</p>
      </form>
      <h2>Generated guides</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Guide</th>
              <th scope="col">Status</th>
              <th scope="col">Approved by</th>
              <th scope="col">Generator quality</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {guides.map((g) => {
              const meta = (g.generationMeta ?? {}) as { qualityStatus?: string; qualityScore?: number; model?: string };
              return (
                <tr key={g.id}>
                  <td data-label="Guide">
                    <Link href={`/admin/reviews/${g.id}`}>{g.canonicalTitle}</Link>
                    <div className="small muted">{g.productName}</div>
                  </td>
                  <td data-label="Status">
                    <Badge value={g.status} />
                  </td>
                  <td data-label="Editor approval">{g.editorApprovedAt ? `${g.editorApprovedBy === "automation:direct-publish" ? "Direct publish" : g.editorApprovedBy} · ${when(g.editorApprovedAt)}` : <Badge value={g.status} />}</td>
                  <td data-label="Generator quality" className="small">
                    {meta.qualityStatus ?? "—"}
                    {meta.qualityScore != null ? ` (${meta.qualityScore})` : ""}
                    {meta.model ? <div className="muted">{meta.model}</div> : null}
                  </td>
                  <td data-label="Created">{when(g.createdAt)}</td>
                </tr>
              );
            })}
            {!guides.length && (
              <tr>
                <td colSpan={5}>No AI guides yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
