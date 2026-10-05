import { ActionForm, Badge, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import {
  automationHealth,
  istParts,
  MAX_SLOT_ATTEMPTS,
  nextSlotRun,
  type Slot,
} from "@/lib/automation/daily-article";
import { config } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Daily articles" };

const TONE: Record<string, "ok" | "warn" | "error"> = {
  PUBLISHED: "ok",
  RUNNING: "warn",
  RETRYING: "warn",
  PENDING: "warn",
  BLOCKED: "error",
  QUEUED: "warn",
  LOCKED: "warn",
  GENERATING: "warn",
  QA: "warn",
  REJECTED: "error",
  FAILED: "error",
  EXHAUSTED: "error",
};

export default async function AutomationPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdminPage();
  const sp = await searchParams;
  const now = new Date();
  const { day } = istParts(now);
  const [slots, recent, queue, counts, health] = await Promise.all([
    db.automationSlot.findMany({ where: { day } }),
    db.automationSlot.findMany({
      orderBy: [{ day: "desc" }, { slot: "asc" }],
      take: 14,
    }),
    db.contentQueueItem.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 30,
    }),
    db.contentQueueItem.groupBy({ by: ["status"], _count: { _all: true } }),
    automationHealth(now),
  ]);
  const ids = [...slots, ...recent]
    .map((s) => s.normalizedReviewId)
    .filter(Boolean) as string[];
  const qids = [...slots, ...recent]
    .map((s) => s.queueItemId)
    .filter(Boolean) as string[];
  const [reviews, items] = await Promise.all([
    db.normalizedReview.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        slug: true,
        canonicalTitle: true,
        categorySlug: true,
        dealStatus: true,
        status: true,
        images: {
          where: { isPrimary: true },
          select: { providerPhotoId: true, isFallback: true, subject: true },
        },
      },
    }),
    db.contentQueueItem.findMany({ where: { id: { in: qids } } }),
  ]);
  const enabled = config.aiGuides.autoGenerate();
  return (
    <>
      <h1>Daily articles</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        A buying guide at 08:00 and an informational article at 19:00 (Asia/Kolkata): relevant topic from the queue → exact-duplicate check (no API call is spent on a repeat) → Keyword-to-Blog → published exactly as returned. No quality, SEO or approval gate; only an exact repeat (same topic or same title, same post type) is stopped. Up to {MAX_SLOT_ATTEMPTS} attempts per slot with backoff, within the Keyword-to-Blog quota of {config.aiGuides.dailyLimit()} requests/day.
      </p>
      {!enabled && (
        <p className="notice warn">
          GUIDE_AUTOGEN_ENABLED is not true: the scheduler will not publish
          anything.
        </p>
      )}

      <h2>Today ({day})</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">Status</th>
              <th scope="col">Topic / category</th>
              <th scope="col">Article</th>
              <th scope="col">Image</th>
              <th scope="col">Offer</th>
              <th scope="col" className="num">
                Attempts / API calls
              </th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {(["MORNING", "EVENING"] as Slot[]).map((name) => {
              const s = slots.find((x) => x.slot === name);
              const r = reviews.find((x) => x.id === s?.normalizedReviewId);
              const q = items.find((x) => x.id === s?.queueItemId);
              const img = r?.images[0];
              return (
                <tr key={name}>
                  <td data-label="Slot">
                    {name}{" "}
                    <div className="small muted">
                      {name === "MORNING" ? "08:00" : "19:00"} IST
                    </div>
                  </td>
                  <td data-label="Status">
                    <Badge
                      value={s?.status ?? "PENDING"}
                      tone={TONE[s?.status ?? "PENDING"]}
                    />
                  </td>
                  <td data-label="Topic / category" className="small">
                    {q
                      ? `${q.topic} · ${q.categorySlug}${q.productName ? ` · ${q.productName}` : ""}`
                      : "—"}
                  </td>
                  <td data-label="Article" className="small">
                    {r ? (
                      <>
                        <a
                          href={
                            r.status === "PUBLISHED"
                              ? `/review/${r.slug}`
                              : `/admin/reviews/${r.id}`
                          }
                        >
                          {r.canonicalTitle}
                        </a>{" "}
                        <Badge value={r.status} />
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Image" className="small">
                    {img
                      ? img.isFallback
                        ? "placeholder"
                        : `${img.providerPhotoId} (${img.subject ?? ""})`
                      : "—"}
                  </td>
                  <td data-label="Offer" className="small">
                    {r ? r.dealStatus : "—"}
                  </td>
                  <td data-label="Attempts / API calls" className="num">
                    {s ? `${s.attempts} / ${s.apiCalls}` : "0 / 0"}
                  </td>
                  <td data-label="Last error" className="small">
                    {s?.lastError ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        Next runs: MORNING {when(nextSlotRun("MORNING", now))} · EVENING{" "}
        {when(nextSlotRun("EVENING", now))}. Last successful:{" "}
        {health.lastPublished
          ? `${health.lastPublished.day} ${health.lastPublished.slot} (${when(health.lastPublished.at)})`
          : "none yet"}
        .
      </p>
      <div className="btnrow">
        <ActionForm
          action="/api/admin/jobs"
          fields={{ job: "daily-article" }}
          label="Run the due slot now"
          returnTo="/admin/automation"
          disabledReason={
            enabled ? undefined : "GUIDE_AUTOGEN_ENABLED is not true"
          }
        />
      </div>

      <h2>Health</h2>
      {health.ok ? (
        <p className="notice ok">
          No problems detected. {health.queued} topics queued.
        </p>
      ) : (
        <ul className="notice warn">
          {health.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <h2>Recent slots</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Slot</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Attempts
              </th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((s) => {
              const r = reviews.find((x) => x.id === s.normalizedReviewId);
              return (
                <tr key={s.id}>
                  <td data-label="Day">{s.day}</td>
                  <td data-label="Slot">{s.slot}</td>
                  <td data-label="Status">
                    <Badge value={s.status} tone={TONE[s.status]} />
                  </td>
                  <td data-label="Attempts" className="num">
                    {s.attempts}
                  </td>
                  <td data-label="Result" className="small">
                    {r ? (
                      <a href={`/review/${r.slug}`}>{r.canonicalTitle}</a>
                    ) : (
                      (s.lastError ?? "—")
                    )}
                  </td>
                </tr>
              );
            })}
            {!recent.length && (
              <tr>
                <td colSpan={5}>No scheduled runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Content queue</h2>
      <p className="small muted">
        {counts.map((c) => `${c.status}: ${c._count._all}`).join(" · ") ||
          "Empty: it fills from the content calendar on the next run."}
      </p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Keyword</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Priority
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Attempts
              </th>
              <th scope="col">Last attempt / reason</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((q) => (
              <tr key={q.id}>
                <td data-label="Topic">{q.topic}</td>
                <td data-label="Keyword" className="small">
                  {q.keyword}
                </td>
                <td data-label="Category" className="small">
                  {q.categorySlug}
                </td>
                <td data-label="Priority" className="num">
                  {q.priority}
                </td>
                <td data-label="Status">
                  <Badge value={q.status} tone={TONE[q.status]} />
                </td>
                <td data-label="Attempts" className="num">
                  {q.attempts}
                </td>
                <td data-label="Last attempt / reason" className="small">
                  {q.lastAttemptAt ? when(q.lastAttemptAt) : "—"}
                  {q.failureReason && (
                    <div className="muted">{q.failureReason}</div>
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
