import type { ContentQueueItem } from "@prisma/client";
import { ActionForm, Badge, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { nextSlotRun } from "@/lib/automation/daily-article";
import { DEFAULT_ADMIN_FREQUENCY, FREQUENCIES, IN_PROGRESS, isFrequency, isKeywordKind, itemType, KEYWORD_KINDS, KEYWORD_LIMITS, keywordItemsPerSlot, listKeywords, type KeywordFilter } from "@/lib/automation/keywords";
import { db } from "@/lib/db";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { businessTimezone, formatInZone } from "@/lib/util/timezone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Keywords" };

const PAGE = "/admin/keywords";
const API = "/api/admin/keywords";
const STATUSES = ["QUEUED", "LOCKED", "GENERATING", "QA", "PUBLISHED", "REJECTED", "EXHAUSTED", "FAILED"];
const RESULTS = ["PUBLISHED", "DUPLICATE", "FAILED", "SKIPPED"];
const RESULT_TONE: Record<string, "ok" | "warn" | "error" | "neutral"> = { PUBLISHED: "ok", DUPLICATE: "neutral", FAILED: "error", SKIPPED: "warn" };
const STATUS_TONE: Record<string, "ok" | "warn" | "error" | "info"> = { QUEUED: "info", LOCKED: "warn", GENERATING: "warn", QA: "warn", PUBLISHED: "ok", REJECTED: "error", EXHAUSTED: "error", FAILED: "error" };
const freqLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase().replace("_", " ");

function CategorySelect({ id, value }: { id: string; value?: string }) {
  return (
    <select id={id} name="categorySlug" required defaultValue={value ?? ""}>
      <option value="" disabled>
        Choose a category
      </option>
      {CATEGORIES.map((c) => (
        <option key={c.slug} value={c.slug}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function KeywordForm({ item, returnTo }: { item?: ContentQueueItem; returnTo: string }) {
  const p = item ? `e-${item.id}` : "new";
  const calendar = item?.source === "calendar";
  const kind = item ? itemType(item) : "GUIDE";
  return (
    <form className="card card-body" action={API} method="post" key={item?.id ?? "new"}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="action" value={item ? "update" : "create"} />
      <input type="hidden" name="enabledPresent" value="1" />
      {item && <input type="hidden" name="id" value={item.id} />}
      {calendar && <p className="small muted">Calendar topic: its keyword, kind and category come from the content calendar, which also refreshes its priority while it is queued.</p>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-kw`}>Keyword</label>
          <input id={`${p}-kw`} name="keyword" required={!calendar} disabled={calendar} maxLength={KEYWORD_LIMITS.keywordMax} defaultValue={item?.topic} placeholder="how to choose a robot vacuum" />
        </div>
        <div className="field">
          <label htmlFor={`${p}-kind`}>Kind</label>
          <select id={`${p}-kind`} name="kind" disabled={calendar} defaultValue={kind}>
            {KEYWORD_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === "GUIDE" ? "GUIDE (morning slot)" : "ARTICLE (evening slot)"}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${p}-cat`}>Category</label>
          {calendar ? <input id={`${p}-cat`} disabled defaultValue={CATEGORY_BY_SLUG.get(item?.categorySlug ?? "")?.name ?? item?.categorySlug} /> : <CategorySelect id={`${p}-cat`} value={item?.categorySlug} />}
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-prio`}>Priority (0–100, higher first)</label>
          <input id={`${p}-prio`} name="priority" type="number" min={KEYWORD_LIMITS.priorityMin} max={KEYWORD_LIMITS.priorityMax} defaultValue={item ? Math.max(0, Math.min(100, item.priority)) : 50} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-freq`}>Frequency</label>
          <select id={`${p}-freq`} name="frequency" defaultValue={item && isFrequency(item.frequency) ? item.frequency : DEFAULT_ADMIN_FREQUENCY}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {freqLabel(f)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${p}-enabled`}>
            <input id={`${p}-enabled`} name="enabled" type="checkbox" value="1" defaultChecked={item?.enabled ?? true} /> Enabled
          </label>
        </div>
      </div>
      <div className="btnrow">
        <button className="btn primary" type="submit">
          {item ? "Save keyword" : "Add keyword"}
        </button>
        {item && (
          <a className="btn" href={returnTo}>
            Cancel
          </a>
        )}
      </div>
    </form>
  );
}

export default async function KeywordsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const tz = businessTimezone();
  const now = new Date();
  const sourceP = param(sp, "source");
  const source: KeywordFilter["source"] = sourceP === "calendar" || sourceP === "all" ? sourceP : "keywords";
  const kindP = param(sp, "kind");
  const statusP = param(sp, "status");
  const enabledP = param(sp, "enabled");
  const categoryP = param(sp, "category");
  const freqP = param(sp, "frequency");
  const resultP = param(sp, "result");
  const q = param(sp, "q")?.trim() || undefined;
  const editId = param(sp, "edit");
  const filter: KeywordFilter = {
    source,
    kind: isKeywordKind(kindP) ? kindP : undefined,
    status: statusP && STATUSES.includes(statusP) ? statusP : undefined,
    enabled: enabledP === "yes" ? true : enabledP === "no" ? false : undefined,
    category: categoryP && CATEGORY_BY_SLUG.has(categoryP) ? categoryP : undefined,
    frequency: isFrequency(freqP) ? freqP : undefined,
    lastResult: resultP && RESULTS.includes(resultP) ? resultP : undefined,
    q,
  };

  const [items, counts] = await Promise.all([
    listKeywords(filter),
    db.contentQueueItem.groupBy({ by: ["source", "enabled"], _count: { _all: true } }),
  ]);
  const reviewIds = items.map((i) => i.normalizedReviewId).filter((x): x is string => Boolean(x));
  const reviews = reviewIds.length ? await db.normalizedReview.findMany({ where: { id: { in: reviewIds } }, select: { id: true, slug: true, status: true, canonicalTitle: true } }) : [];
  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  const edit = editId ? (items.find((i) => i.id === editId) ?? (await db.contentQueueItem.findUnique({ where: { id: editId } })) ?? undefined) : undefined;

  const filterQs = new URLSearchParams(Object.entries({ source: sourceP, kind: kindP, status: statusP, enabled: enabledP, category: categoryP, frequency: freqP, result: resultP, q }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const returnTo = filterQs ? `${PAGE}?${filterQs}` : PAGE;
  const editHref = (id: string) => `${PAGE}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(filterQs)), edit: id }).toString()}#edit`;
  const total = (pred: (c: (typeof counts)[number]) => boolean) => counts.filter(pred).reduce((n, c) => n + c._count._all, 0);
  const keywordTotal = total((c) => c.source !== "calendar");
  const perSlot = keywordItemsPerSlot();

  return (
    <>
      <h1>Keywords</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Scheduled keywords for Keyword-to-Blog. Each keyword goes: relevance check → generation → exact-duplicate check (same title and kind, same slug, or the same body text) → published as returned. Different articles on the same product or category are allowed. A recurring keyword publishes a new article only when the
        result is not an exact duplicate; otherwise the run is recorded as DUPLICATE. Due keywords go before calendar topics, highest priority first.
      </p>
      <p className="small muted">
        Batch: {perSlot} post{perSlot === 1 ? "" : "s"} per slot (KEYWORD_ITEMS_PER_SLOT) · GUIDE keywords run in the morning slot ({when(nextSlotRun("MORNING", now))} · {formatInZone(nextSlotRun("MORNING", now), tz)}), ARTICLE keywords in the evening slot ({when(nextSlotRun("EVENING", now))} ·{" "}
        {formatInZone(nextSlotRun("EVENING", now), tz)}). Business time zone: {tz}. {keywordTotal} keyword{keywordTotal === 1 ? "" : "s"} ({total((c) => c.source !== "calendar" && c.enabled)} enabled) · {total((c) => c.source === "calendar")} calendar topics.
      </p>

      <form className="btnrow" method="get" action={PAGE}>
        <label className="small" htmlFor="f-source">
          Source{" "}
          <select id="f-source" name="source" defaultValue={source}>
            <option value="keywords">Keywords (admin, import)</option>
            <option value="calendar">Content calendar</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="small" htmlFor="f-kind">
          Kind{" "}
          <select id="f-kind" name="kind" defaultValue={filter.kind ?? ""}>
            <option value="">All</option>
            {KEYWORD_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-status">
          Status{" "}
          <select id="f-status" name="status" defaultValue={filter.status ?? ""}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-enabled">
          Enabled{" "}
          <select id="f-enabled" name="enabled" defaultValue={enabledP ?? ""}>
            <option value="">All</option>
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </label>
        <label className="small" htmlFor="f-category">
          Category{" "}
          <select id="f-category" name="category" defaultValue={filter.category ?? ""}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-frequency">
          Frequency{" "}
          <select id="f-frequency" name="frequency" defaultValue={filter.frequency ?? ""}>
            <option value="">All</option>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {freqLabel(f)}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-result">
          Last result{" "}
          <select id="f-result" name="result" defaultValue={filter.lastResult ?? ""}>
            <option value="">All</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-q">
          Search{" "}
          <input id="f-q" name="q" type="search" maxLength={80} defaultValue={q ?? ""} placeholder="Keyword" />
        </label>
        <button className="btn small" type="submit">
          Filter
        </button>
        {filterQs && (
          <a className="btn small" href={PAGE}>
            Clear
          </a>
        )}
        <span className="small muted">
          {items.length} shown{items.length >= 300 ? " (first 300)" : ""}
        </span>
      </form>

      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Kind</th>
              <th>Category</th>
              <th className="num">Priority</th>
              <th>Frequency</th>
              <th>Status</th>
              <th>Last run</th>
              <th>Next run</th>
              <th>Last result</th>
              <th>Article</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const review = i.normalizedReviewId ? reviewById.get(i.normalizedReviewId) : undefined;
              const busy = IN_PROGRESS.includes(i.status);
              const due = i.enabled && i.status === "QUEUED" && (i.nextRunAt ? i.nextRunAt <= now : i.source === "calendar");
              return (
                <tr key={i.id} className={i.enabled ? undefined : "row-inactive"}>
                  <td data-label="Keyword">
                    <strong>{i.topic}</strong>
                    <div className="small muted">
                      {i.keyword} · {i.source}
                    </div>
                  </td>
                  <td data-label="Kind">{itemType(i)}</td>
                  <td data-label="Category" className="small">
                    {CATEGORY_BY_SLUG.get(i.categorySlug)?.name ?? i.categorySlug}
                  </td>
                  <td className="num" data-label="Priority">
                    {i.priority}
                  </td>
                  <td data-label="Frequency">{isFrequency(i.frequency) ? freqLabel(i.frequency) : i.frequency}</td>
                  <td data-label="Status">
                    <Badge value={i.enabled ? i.status : "DISABLED"} tone={i.enabled ? (STATUS_TONE[i.status] ?? "info") : "warn"} />
                    {i.attempts > 0 && <div className="small muted">{i.attempts} attempt(s)</div>}
                  </td>
                  <td data-label="Last run" className="small">
                    {i.lastRunAt ? (
                      <>
                        {when(i.lastRunAt)}
                        <div className="muted">{formatInZone(i.lastRunAt, tz)}</div>
                      </>
                    ) : (
                      "Never"
                    )}
                  </td>
                  <td data-label="Next run" className="small">
                    {i.nextRunAt ? (
                      <>
                        {when(i.nextRunAt)}
                        <div className="muted">{formatInZone(i.nextRunAt, tz)}</div>
                      </>
                    ) : i.status === "QUEUED" ? (
                      "Calendar order"
                    ) : (
                      "No further run"
                    )}
                    {due && <div className="muted">due at the next {itemType(i) === "ARTICLE" ? "evening" : "morning"} slot</div>}
                  </td>
                  <td data-label="Last result" className="small">
                    {i.lastResult ? <Badge value={i.lastResult} tone={RESULT_TONE[i.lastResult] ?? "neutral"} /> : "—"}
                    {i.failureReason && <div className="muted">{i.failureReason.slice(0, 200)}</div>}
                  </td>
                  <td data-label="Article" className="small">
                    {review ? (
                      <>
                        {review.status === "PUBLISHED" ? (
                          <a href={`/review/${review.slug}`} target="_blank" rel="noopener noreferrer">
                            {review.canonicalTitle.slice(0, 80)}
                          </a>
                        ) : (
                          review.canonicalTitle.slice(0, 80)
                        )}
                        <div>
                          <a className="muted" href={`/admin/reviews/${review.id}`}>
                            {review.status}
                          </a>
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Actions">
                    <div className="btnrow" style={{ margin: 0 }}>
                      <ActionForm action={API} fields={{ id: i.id, action: i.enabled ? "disable" : "enable" }} label={i.enabled ? "Disable" : "Enable"} returnTo={returnTo} />
                      <ActionForm action={API} fields={{ id: i.id, action: "run-now" }} label="Run now" returnTo={returnTo} disabledReason={busy ? "being generated right now" : undefined} />
                      <ActionForm
                        action={API}
                        fields={{ id: i.id, action: "publish-now" }}
                        label="Publish now"
                        returnTo={returnTo}
                        confirm={`Generate and publish "${i.topic}" now, outside the daily slots? This uses one Keyword-to-Blog request and can take a few minutes.`}
                        disabledReason={busy ? "being generated right now" : !i.enabled ? "enable it first" : undefined}
                      />
                      <a className="btn small" href={editHref(i.id)}>
                        Edit
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!items.length && (
              <tr>
                <td colSpan={11}>{source === "keywords" && !keywordTotal ? "No keywords yet. Add one or import a list below." : "No keywords match the filter."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Run now makes a keyword due at the next slot of its kind; the daily cadence still applies. Publish now runs one generation immediately, outside the slots (exact-duplicate checks still apply). Frequencies: daily +1 day, twice weekly +3/+4 days, weekly +7, monthly +30, once = no repeat after it is published.
      </p>

      <h2 id="edit">{edit ? `Edit "${edit.topic}"` : "Add a keyword"}</h2>
      {editId && !edit && <p className="notice warn">That keyword no longer exists.</p>}
      <KeywordForm item={edit} returnTo={returnTo} />

      <h2>Bulk import</h2>
      <form className="card card-body" action={API} method="post">
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="action" value="import" />
        <div className="field">
          <label htmlFor="imp-kw">Keywords, one per line (at most {KEYWORD_LIMITS.importLines})</label>
          <textarea id="imp-kw" name="keywords" required rows={8} placeholder={"best budget robot vacuum\nrobot vacuum for pet hair"} />
          <p className="field-hint">Exact repeats (same keyword and kind, ignoring case and punctuation) are skipped. Imported keywords are due at the next slot of their kind, one batch per slot.</p>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="imp-kind">Kind</label>
            <select id="imp-kind" name="kind" defaultValue="GUIDE">
              {KEYWORD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-cat">Category</label>
            <CategorySelect id="imp-cat" />
          </div>
          <div className="field">
            <label htmlFor="imp-prio">Priority (0–100)</label>
            <input id="imp-prio" name="priority" type="number" min={0} max={100} defaultValue={50} />
          </div>
          <div className="field">
            <label htmlFor="imp-freq">Frequency</label>
            <select id="imp-freq" name="frequency" defaultValue={DEFAULT_ADMIN_FREQUENCY}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {freqLabel(f)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="btnrow">
          <button className="btn primary" type="submit">
            Import keywords
          </button>
        </div>
      </form>
    </>
  );
}
