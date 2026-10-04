import { ActionForm, Badge, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { sourceHealth } from "@/lib/admin/source-health";
import { apifyConfigured } from "@/lib/pipeline/apify";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review sources" };

const RUN_TONE: Record<string, "ok" | "warn" | "error"> = { COLLECTED: "ok", SUCCEEDED: "ok", RUNNING: "warn", READY: "warn", COLLECTING: "warn", FAILED: "error", ABORTED: "error", "TIMED-OUT": "error", COLLECT_FAILED: "error", SOURCE_DISABLED: "warn" };

export default async function SourcesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const editId = param(sp, "edit");
  const [sources, runs, latest] = await Promise.all([
    db.reviewSource.findMany({ orderBy: { name: "asc" } }),
    db.apifyRun.findMany({ orderBy: { startedAt: "desc" }, take: 30, include: { source: { select: { name: true } } } }),
    db.apifyRun.findMany({ orderBy: { startedAt: "desc" }, distinct: ["sourceId"] }),
  ]);
  const health = await sourceHealth(sources.map((s) => s.id));
  const edit = editId ? sources.find((s) => s.id === editId) : undefined;
  const last = (id: string) => latest.find((r) => r.sourceId === id);
  return (
    <>
      <h1>Review sources</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Editorial review sites crawled with the Apify Web Scraper. Only these sources are crawled, only their allowed domains are accepted, and robots.txt is respected. Add a source only if its terms allow automated access. Sources are excerpt-only unless you hold a licence: we keep the text privately for
        extraction and show a summary that links to the original.
      </p>
      {!apifyConfigured() && <p className="notice warn">APIFY_API_TOKEN is not configured (BLOCKED_BY_ENVIRONMENT). Sources can be set up, but no crawl will run.</p>}

      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Source</th>
              <th>Status</th>
              <th>Rights</th>
              <th>Every</th>
              <th>Last run</th>
              <th>Last success</th>
              <th className="num">Discovered</th>
              <th>Robots.txt</th>
              <th>Last result</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const r = last(s.id);
              const h = health.get(s.id);
              return (
                <tr key={s.id} className={s.enabled ? undefined : "row-inactive"}>
                  <td data-label="Source">
                    <strong>{s.name}</strong>
                    <div className="small muted">{s.allowedDomains.join(", ")}</div>
                    <details className="small">
                      <summary>Listing URLs and patterns</summary>
                      <div>Start: {s.startUrls.join(", ")}</div>
                      <div>Reviews: {s.reviewUrlPatterns.join(", ")}</div>
                    </details>
                  </td>
                  <td data-label="Status">
                    <Badge value={s.enabled ? "ENABLED" : "DISABLED"} tone={s.enabled ? "ok" : "warn"} />
                  </td>
                  <td data-label="Rights">{s.rights === "LICENSED" ? "Licensed (full text)" : "Excerpt only"}</td>
                  <td data-label="Every">{s.crawlFrequencyHours} h</td>
                  <td data-label="Last run">{when(s.lastRunAt)}</td>
                  <td data-label="Last success">{h?.lastSuccessAt ? when(h.lastSuccessAt) : "Never"}</td>
                  <td className="num" data-label="Discovered">
                    {h?.discovered ?? 0}
                    {h && h.discovered > 0 && <div className="small muted">{h.accepted} accepted</div>}
                  </td>
                  <td data-label="Robots.txt">
                    <Badge value={h?.robots === "DISALLOWED" ? "DISALLOWED" : h?.robots === "ALLOWED" ? "ALLOWED AT LAST START" : "NOT CHECKED"} tone={h?.robots === "DISALLOWED" ? "error" : h?.robots === "ALLOWED" ? "ok" : "warn"} />
                  </td>
                  <td data-label="Last result">
                    {r ? (
                      <>
                        <Badge value={r.status} tone={RUN_TONE[r.status] ?? "warn"} />
                        {r.itemCount != null && (
                          <div className="small muted">
                            {r.itemCount} pages, {r.accepted ?? 0} accepted, {r.rejected ?? 0} rejected
                          </div>
                        )}
                        {r.error && <div className="small muted">{r.error}</div>}
                      </>
                    ) : (
                      "Never run"
                    )}
                    {h?.lastFailure && (
                      <div className="small">
                        Last failure ({when(h.lastFailure.at)}): <code>{h.lastFailure.code}</code> {h.lastFailure.message.slice(0, 200)}
                      </div>
                    )}
                  </td>
                  <td data-label="Actions">
                    <div className="btnrow" style={{ margin: 0 }}>
                      <ActionForm action="/api/admin/sources" fields={{ id: s.id, action: "toggle" }} label={s.enabled ? "Disable" : "Enable"} returnTo="/admin/sources" />
                      <ActionForm action="/api/admin/sources" fields={{ id: s.id, action: "run" }} label="Run now" returnTo="/admin/sources" disabledReason={apifyConfigured() ? undefined : "APIFY_API_TOKEN not configured"} />
                      <a className="btn small" href={`/admin/sources?edit=${s.id}`}>
                        Edit
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!sources.length && (
              <tr>
                <td colSpan={10}>No sources yet. Add the first one below.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>{edit ? `Edit ${edit.name}` : "Add a source"}</h2>
      <form className="card card-body" action="/api/admin/sources" method="post" key={edit?.id ?? "new"}>
        <input type="hidden" name="returnTo" value="/admin/sources" />
        {edit && <input type="hidden" name="id" value={edit.id} />}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="s-name">Name</label>
            <input id="s-name" name="name" required maxLength={80} defaultValue={edit?.name} />
          </div>
          <div className="field">
            <label htmlFor="s-slug">Slug</label>
            <input id="s-slug" name="slug" required pattern="[a-z0-9-]{2,40}" defaultValue={edit?.slug} />
          </div>
          <div className="field">
            <label htmlFor="s-home">Homepage</label>
            <input id="s-home" name="homepageUrl" type="url" required defaultValue={edit?.homepageUrl} placeholder="https://example.com" />
          </div>
          <div className="field">
            <label htmlFor="s-cat">Category hint (optional)</label>
            <select id="s-cat" name="categoryHint" defaultValue={edit?.categoryHint ?? ""}>
              <option value="">Classify automatically</option>
              {CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="s-dom">Allowed domains</label>
          <input id="s-dom" name="allowedDomains" required defaultValue={edit?.allowedDomains.join(", ")} placeholder="example.com" />
          <p className="field-hint">Pages on any other domain are rejected as SOURCE_NOT_ALLOWED.</p>
        </div>
        <div className="field">
          <label htmlFor="s-start">Start (listing) URLs, one per line</label>
          <textarea id="s-start" name="startUrls" required defaultValue={edit?.startUrls.join("\n")} placeholder="https://example.com/reviews" />
        </div>
        <div className="field">
          <label htmlFor="s-pat">Review URL patterns, one per line</label>
          <textarea id="s-pat" name="reviewUrlPatterns" required defaultValue={edit?.reviewUrlPatterns.join("\n")} placeholder="https://example.com/reviews/**" />
          <p className="field-hint">Only pages matching these globs are extracted. * matches within one path segment, ** across segments.</p>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="s-freq">Crawl every (hours)</label>
            <input id="s-freq" name="crawlFrequencyHours" type="number" min={6} max={720} defaultValue={edit?.crawlFrequencyHours ?? 24} />
          </div>
          <div className="field">
            <label htmlFor="s-max">Review pages per run</label>
            <input id="s-max" name="maxPagesPerRun" type="number" min={1} max={200} defaultValue={edit?.maxPagesPerRun ?? 20} />
          </div>
          <div className="field">
            <label htmlFor="s-rights">Text rights</label>
            <select id="s-rights" name="rights" defaultValue={edit?.rights ?? "EXCERPT_ONLY"}>
              <option value="EXCERPT_ONLY">Excerpt only (default)</option>
              <option value="LICENSED">Licensed: we may publish the full text</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="s-notes">Notes (terms checked, contact, licence)</label>
          <textarea id="s-notes" name="notes" defaultValue={edit?.notes ?? ""} />
        </div>
        <div className="btnrow">
          <button className="btn primary" type="submit">
            {edit ? "Save source" : "Add source"}
          </button>
          {edit && (
            <a className="btn" href="/admin/sources">
              Cancel
            </a>
          )}
        </div>
      </form>

      <h2>Recent Apify runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Source</th>
              <th>Run</th>
              <th>Status</th>
              <th>Started</th>
              <th className="num">Pages</th>
              <th className="num">Accepted</th>
              <th className="num">Rejected</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Source">{r.source.name}</td>
                <td data-label="Run">
                  <code>{r.apifyRunId}</code>
                </td>
                <td data-label="Status">
                  <Badge value={r.status} tone={RUN_TONE[r.status] ?? "warn"} />
                </td>
                <td data-label="Started">{when(r.startedAt)}</td>
                <td className="num" data-label="Pages">
                  {r.itemCount ?? "–"}
                </td>
                <td className="num" data-label="Accepted">
                  {r.accepted ?? "–"}
                </td>
                <td className="num" data-label="Rejected">
                  {r.rejected ?? "–"}
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={7}>No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
