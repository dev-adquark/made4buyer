import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config, integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { classifyImage, imageFilterWhere, loadImageCounts, LOW_CONFIDENCE, matchBasisFor } from "@/lib/images/admin-stats";
import { INTEGRITY_PREFIX, integrityCheckTimes } from "@/lib/images/integrity";
import { loadImageSlotCounts, type SlotBuckets } from "@/lib/images/slot-counts";
import { publicImageUrl } from "@/lib/pipeline/images";

export const dynamic = "force-dynamic";
export const metadata = { title: "Images" };

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "low", label: "Low confidence" },
  { key: "exact", label: "Verified exact" },
  { key: "illustrative", label: "Illustrative" },
  { key: "fallback", label: "Category fallback" },
  { key: "placeholder", label: "Placeholder" },
];

const SLOT_COLUMNS: Array<[keyof SlotBuckets, string]> = [
  ["required", "Required"],
  ["exactOfficial", "Exact official"],
  ["retailer", "Retailer exact"],
  ["internal", "Verified internal"],
  ["pexels", "Pexels illustrative"],
  ["categoryFallback", "Category fallback"],
  ["missing", "Missing"],
  ["broken", "Broken"],
  ["mismatched", "Mismatched"],
];

const CLASS_TONE: Record<string, "ok" | "warn" | "error" | "neutral"> = { verifiedExact: "ok", lowConfidence: "warn", failed: "error", illustrative: "neutral", placeholder: "neutral", other: "warn" };

export default async function ImagesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const filter = param(sp, "filter") ?? "";
  const [counts, slots, assets, checks] = await Promise.all([
    loadImageCounts(),
    loadImageSlotCounts().catch(() => null),
    db.imageAsset.findMany({
      where: { isPrimary: true, review: { status: "PUBLISHED" }, ...imageFilterWhere(filter) },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { review: { select: { id: true, slug: true, productName: true, categorySlug: true, status: true } } },
    }),
    integrityCheckTimes(),
  ]);
  const basis = await matchBasisFor(assets);
  const integrations = integrationStatus();
  const returnTo = `/admin/images${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;

  return (
    <>
      <h1>Images</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Hero images of published pages. Single-product pages show the exact product (licensed, identity-matched) or a neutral category image; category pages may show a labelled illustrative photo. The <code>image-integrity</code> job re-checks live images daily: a broken one falls back to the category image at once and is restored when it loads again. CDN: {integrations.imageCdn}. Unverified-licence images are {config.images.requireLicense() ? "withheld (category image shown)" : "shown publicly"}.
      </p>
      <h2>Image slots on the public site</h2>
      <p className="small muted">
        Every image slot the design gives (review and guide cards/heroes, deal and price cards, category features), per item. Priority: exact official photo → retailer&rsquo;s exact photo → our verified exact photo → labelled Pexels photo of the product&rsquo;s type → neutral category image. Missing = a placeholder or nothing on a review/guide; broken and mismatched images already show the next fallback.
      </p>
      {slots ? (
        <div className="table-wrap">
          <table className="table" data-testid="image-slot-counts">
            <thead>
              <tr>
                <th scope="col">Slots</th>
                {SLOT_COLUMNS.map(([, label]) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Reviews & guides", slots.reviews],
                  ["Deal & price cards", slots.deals],
                  ["Category features", slots.categoryFeatures],
                  ["Total", slots.total],
                ] as Array<[string, SlotBuckets]>
              ).map(([name, b]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  {SLOT_COLUMNS.map(([k, label]) => (
                    <td key={k} data-label={label} data-slot={k}>
                      {b[k]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">Slot counts unavailable.</p>
      )}
      <h2>Review hero images</h2>
      <div className="stats">
        <Stat label="Published pages" value={counts.published} />
        <Stat label="Missing" value={counts.missing} note="no image row" />
        <Stat label="Failed" value={counts.failed} note="broken or not exact" />
        <Stat label="Low confidence" value={counts.lowConfidence} note={`exact claim < ${LOW_CONFIDENCE}`} />
        <Stat label="Verified exact" value={counts.verifiedExact} />
        <Stat label="Illustrative" value={counts.illustrative} />
        <Stat label="Category fallback" value={counts.categoryFallback} note="public site shows category image" />
        <Stat label="Placeholder" value={counts.placeholder} />
      </div>
      <nav className="toolbar" aria-label="Filter images">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key ? `/admin/images?filter=${f.key}` : "/admin/images"} className={`btn small${f.key === filter ? " primary" : ""}`} aria-current={f.key === filter ? "page" : undefined}>
            {f.label}
          </Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Preview</th>
              <th scope="col">Page</th>
              <th scope="col">Provenance</th>
              <th scope="col">Licence</th>
              <th scope="col">Match</th>
              <th scope="col">Status</th>
              <th scope="col">Last checked</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => {
              const shown = publicImageUrl(a, a.review.categorySlug);
              const cls = classifyImage(a);
              const check = checks.get(a.id);
              const remote = a.sourceType !== "PLACEHOLDER" && /^https?:/.test(a.cdnUrl ?? a.sourceUrl ?? "");
              const checkable = remote && (a.enrichmentStatus !== "FAILED" || (a.failureReason ?? "").startsWith(INTEGRITY_PREFIX));
              return (
                <tr key={a.id}>
                  <td data-label="Preview">
                    <img src={shown.url} alt="" width={96} height={54} loading="lazy" referrerPolicy="no-referrer" style={{ borderRadius: 6, objectFit: "cover" }} />
                  </td>
                  <td data-label="Page">
                    <Link href={`/admin/reviews/${a.review.id}`}>{a.review.productName}</Link>
                    <div className="small muted">/review/{a.review.slug}</div>
                  </td>
                  <td data-label="Provenance" className="small" style={{ wordBreak: "break-all" }}>
                    <Badge value={a.imageType ?? a.sourceType} /> <Badge value={cls} tone={CLASS_TONE[cls]} />
                    <div className="muted">{a.sourceType}</div>
                    {a.sourceUrl && <div className="muted">{a.sourceUrl}</div>}
                    {a.sourcePageUrl && (
                      <div>
                        <a href={a.sourcePageUrl} rel="noopener noreferrer" target="_blank">
                          Source page
                        </a>
                      </div>
                    )}
                    {a.searchQuery && <div className="muted">Query: “{a.searchQuery}”{a.providerPhotoId ? ` · ${a.providerPhotoId}` : ""}</div>}
                  </td>
                  <td data-label="Licence" className="small">
                    <Badge value={a.licenseState} />
                    <div className="muted">{a.license ?? "—"}</div>
                    {a.attribution && <div className="muted">{a.attribution}</div>}
                  </td>
                  <td data-label="Match" className="small">
                    <div>{basis.get(a.id)}</div>
                    <div className="muted">confidence {a.matchConfidence == null ? "—" : a.matchConfidence.toFixed(2)}</div>
                  </td>
                  <td data-label="Status" className="small">
                    <Badge value={a.enrichmentStatus} /> {shown.isFallback ? <Badge value="CATEGORY IMAGE SHOWN" tone="warn" /> : <Badge value="SHOWN" tone="ok" />}
                    {a.failureReason && <div className="muted">{a.failureReason}</div>}
                  </td>
                  <td data-label="Last checked" className="small">
                    {check ? when(check.at) : when(a.verifiedAt)}
                    {check?.last && <div className="muted">{check.last}{check.transient ? ` (${check.transient}× unreachable)` : ""}</div>}
                  </td>
                  <td data-label="Action">
                    <ActionForm action="/api/admin/images/recheck" fields={{ assetId: a.id }} label="Re-check" returnTo={returnTo} disabledReason={checkable ? undefined : "Placeholders and images failed for other reasons are not re-checked"} />
                  </td>
                </tr>
              );
            })}
            {!assets.length && (
              <tr>
                <td colSpan={8}>No images in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {assets.length === 100 && <p className="small muted">Showing the 100 most recently updated.</p>}
    </>
  );
}
