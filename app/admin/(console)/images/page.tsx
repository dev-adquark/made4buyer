import Link from "next/link";
import { Badge, Stat, when } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { config, integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { publicImageUrl } from "@/lib/pipeline/images";

export const dynamic = "force-dynamic";
export const metadata = { title: "Images" };

export default async function ImagesPage() {
  await requireAdminPage();
  const [groups, assets] = await Promise.all([
    db.imageAsset.groupBy({ by: ["sourceType", "licenseState", "enrichmentStatus"], where: { isPrimary: true }, _count: { _all: true } }),
    db.imageAsset.findMany({ where: { isPrimary: true }, orderBy: { createdAt: "desc" }, take: 100, include: { review: { select: { id: true, productName: true, categorySlug: true, status: true } } } }),
  ]);
  const sum = (f: (g: (typeof groups)[number]) => boolean) => groups.filter(f).reduce((n, g) => n + g._count._all, 0);
  const integrations = integrationStatus();

  return (
    <>
      <h1>Images</h1>
      <p className="muted">
        Priority: Content API image → image service ({integrations.imageProvider}) → own category placeholder. CDN: {integrations.imageCdn}. Unverified-license images are {config.images.requireLicense() ? "withheld from the public site (placeholder shown)" : "shown publicly"}.
      </p>
      <div className="stats">
        <Stat label="Content API" value={sum((g) => g.sourceType === "CONTENT_API")} />
        <Stat label="Image service" value={sum((g) => g.sourceType === "ENRICHMENT_SERVICE")} />
        <Stat label="Placeholder" value={sum((g) => g.sourceType === "PLACEHOLDER")} />
        <Stat label="License verified" value={sum((g) => g.licenseState === "VERIFIED")} />
        <Stat label="Provider-asserted" value={sum((g) => g.licenseState === "PROVIDER_ASSERTED")} />
        <Stat label="License unverified" value={sum((g) => g.licenseState === "UNVERIFIED")} />
        <Stat label="Enrichment failed" value={sum((g) => g.enrichmentStatus === "FAILED")} />
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Preview</th>
              <th scope="col">Review</th>
              <th scope="col">Source</th>
              <th scope="col">CDN</th>
              <th scope="col">License</th>
              <th scope="col">Status</th>
              <th scope="col">Public</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => {
              const shown = publicImageUrl(a, a.review.categorySlug);
              return (
                <tr key={a.id}>
                  <td data-label="Preview">
                    <img src={shown.url} alt="" width={96} height={54} loading="lazy" style={{ borderRadius: 6, objectFit: "cover" }} />
                  </td>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${a.review.id}`}>{a.review.productName}</Link>
                  </td>
                  <td data-label="Source" className="small" style={{ wordBreak: "break-all" }}>
                    {a.sourceType}
                    <div className="muted">{a.sourceUrl}</div>
                  </td>
                  <td data-label="CDN" className="small" style={{ wordBreak: "break-all" }}>{a.cdnUrl ?? "—"}</td>
                  <td data-label="License">
                    <Badge value={a.licenseState} />
                    <div className="small muted">{a.license ?? ""}</div>
                  </td>
                  <td data-label="Status">
                    <Badge value={a.enrichmentStatus} /> {a.isFallback && <Badge value="FALLBACK" tone="warn" />}
                    {a.failureReason && <div className="small muted">{a.failureReason}</div>}
                  </td>
                  <td data-label="Public">{shown.isFallback ? <Badge value="PLACEHOLDER" tone="warn" /> : <Badge value="SOURCE" tone="ok" />}</td>
                  <td data-label="Checked">{when(a.verifiedAt)}</td>
                </tr>
              );
            })}
            {!assets.length && (
              <tr>
                <td colSpan={8}>No image assets yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
