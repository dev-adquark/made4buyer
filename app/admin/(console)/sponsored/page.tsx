import type { SponsoredPlacement } from "@prisma/client";
import Flash from "@/components/flash";
import { ActionForm, Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { evaluatePlacement } from "@/lib/sponsored";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sponsored placements" };

const local = (d: Date | null) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");

function PlacementForm({ p }: { p?: SponsoredPlacement }) {
  const id = p?.id ?? "new";
  return (
    <form action="/api/admin/sponsored" method="post" className="card card-body">
      {p && <input type="hidden" name="id" value={p.id} />}
      <input type="hidden" name="returnTo" value="/admin/sponsored" />
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-title`}>Title</label>
          <input id={`${id}-title`} name="title" defaultValue={p?.title} required maxLength={140} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-adv`}>Advertiser</label>
          <input id={`${id}-adv`} name="advertiser" defaultValue={p?.advertiser} required maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-url`}>Destination URL (https)</label>
          <input id={`${id}-url`} name="url" type="url" defaultValue={p?.url} required placeholder="https://" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-label`}>Label</label>
          <input id={`${id}-label`} name="label" defaultValue={p?.label ?? "Sponsored"} maxLength={30} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-pos`}>Position</label>
          <select id={`${id}-pos`} name="position" defaultValue={p?.position ?? "HOME_HERO"}>
            <option value="HOME_HERO">Home hero</option>
            <option value="CATEGORY_TOP">Category page top</option>
            <option value="REVIEW_SIDEBAR">Review sidebar</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-cat`}>Category targeting</label>
          <select id={`${id}-cat`} name="categorySlug" defaultValue={p?.categorySlug ?? ""}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-start`}>Start</label>
          <input id={`${id}-start`} name="startAt" type="datetime-local" defaultValue={local(p?.startAt ?? null)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-end`}>End</label>
          <input id={`${id}-end`} name="endAt" type="datetime-local" defaultValue={local(p?.endAt ?? null)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-pv`}>Min. page views (30d)</label>
          <input id={`${id}-pv`} name="minMonthlyPageViews" type="number" min={1} defaultValue={p?.minMonthlyPageViews ?? 1000} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-ss`}>Min. sessions (30d)</label>
          <input id={`${id}-ss`} name="minMonthlySessions" type="number" min={1} defaultValue={p?.minMonthlySessions ?? 250} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-disc`}>Disclosure text (shown with the placement)</label>
        <input id={`${id}-disc`} name="disclosure" defaultValue={p?.disclosure ?? "Paid placement. Made4Buyers is compensated by the advertiser."} required minLength={10} maxLength={300} />
      </div>
      <button className="btn primary" type="submit">
        {p ? "Save changes" : "Create placement (disabled)"}
      </button>
    </form>
  );
}

export default async function SponsoredPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const rows = await db.sponsoredPlacement.findMany({ orderBy: { createdAt: "desc" } });
  const evaluations = await Promise.all(rows.map((p) => evaluatePlacement(p)));
  return (
    <>
      <h1>Sponsored placements</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className={`notice ${config.sponsored.enabled() ? "ok" : "warn"}`}>
        Feature flag FEATURE_SPONSORED_PLACEMENTS is <strong>{config.sponsored.enabled() ? "ON" : "OFF"}</strong>. A placement is shown only when the flag is on, it is enabled, within its schedule, and real first-party traffic meets its thresholds.
      </p>
      {rows.map((p, i) => {
        const ev = evaluations[i];
        return (
          <section key={p.id} className="card card-body" style={{ marginBottom: 16 }} aria-labelledby={`sp-${p.id}`}>
            <h2 id={`sp-${p.id}`} style={{ marginTop: 0 }}>
              {p.title} <Badge value={ev.active ? "LIVE" : "INACTIVE"} tone={ev.active ? "ok" : "neutral"} />
            </h2>
            <p className="small muted">
              {p.position} · {p.categorySlug ?? "all categories"} · {when(p.startAt)} → {when(p.endAt)} · traffic {ev.traffic.pageViews} views / {ev.traffic.sessions} sessions (30d)
            </p>
            {!ev.active && (
              <ul className="small">
                {ev.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <div className="small muted">Preview:</div>
            <aside className="sponsor" aria-label="Sponsored placement preview">
              <div className="sponsor-label">{p.label}</div>
              <strong>{p.title}</strong>
              <div className="small muted">
                {p.advertiser} · {p.disclosure}
              </div>
            </aside>
            <div className="btnrow">
              <ActionForm action="/api/admin/sponsored" fields={{ id: p.id, action: "toggle" }} label={p.enabled ? "Disable" : "Enable"} returnTo="/admin/sponsored" />
              <ActionForm action="/api/admin/sponsored" fields={{ id: p.id, action: "delete" }} label="Delete" returnTo="/admin/sponsored" confirm="Delete this placement?" className="btn small danger" />
            </div>
            <details>
              <summary>Edit</summary>
              <PlacementForm p={p} />
            </details>
          </section>
        );
      })}
      <h2>New placement</h2>
      <PlacementForm />
    </>
  );
}
