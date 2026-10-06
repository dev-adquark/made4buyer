import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { couponIsCurrent } from "@/lib/pipeline/render-model";
import { couponsConfigured } from "@/lib/sovrn/coupons";

/** Admin → Deals: Sovrn promo-code coverage, lookup outcomes and the codes on file. */
export default async function CouponSection() {
  const [active, inactive, lookups, recent, candidates] = await Promise.all([
    db.sovrnCoupon.findMany({ where: { isActive: true }, select: { verified: true, verifiedAt: true } }),
    db.sovrnCoupon.count({ where: { isActive: false } }),
    db.sovrnOfferCache.groupBy({ by: ["providerStatus"], where: { queryKey: { startsWith: "coupons:" } }, _count: { _all: true } }),
    db.sovrnCoupon.findMany({ orderBy: { updatedAt: "desc" }, take: 20, include: { review: { select: { productName: true, slug: true } } } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", OR: [{ sourceProductUrl: { not: null } }, { affiliateLinks: { some: { isActive: true, verificationStatus: "VERIFIED_OK", finalUrl: { not: null } } } }] } }),
  ]);
  const shown = active.filter((c) => c.verified && c.verifiedAt && couponIsCurrent({ verifiedAt: c.verifiedAt.toISOString() })).length;
  const configured = couponsConfigured();
  return (
    <>
      <h2>Coupons (Sovrn Product Promo Codes)</h2>
      {!configured && (
        <p className="notice warn">
          Not running: the Product Promo Codes API needs separate registration with Sovrn Support. When Sovrn confirms access, set SOVRN_COUPONS_ENABLED=true. No code is ever shown unless Sovrn returned and verified it.
        </p>
      )}
      <div className="stats">
        <Stat label="Products with a retailer URL" value={candidates} note="eligible for a coupon lookup" />
        <Stat label="Codes shown on the site" value={shown} note={`verified within ${config.sovrn.couponMaxAgeDays()} days`} />
        <Stat label="Codes on file (active)" value={active.length} />
        <Stat label="Retired codes" value={inactive} note="no longer returned by Sovrn" />
      </div>
      <p className="small muted">Lookup outcomes: {lookups.length ? lookups.map((l) => `${l.providerStatus} ${l._count._all}`).join(" · ") : "no lookups yet"}</p>
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "refresh-coupons" }} label="Refresh coupons now" returnTo="/admin/deals" disabledReason={configured ? undefined : "SOVRN_COUPONS_ENABLED is off"} />
      </div>
      {recent.length > 0 && (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Code</th>
                <th scope="col">Verified</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id}>
                  <td data-label="Product">{c.review.productName}</td>
                  <td data-label="Code">
                    <code>{c.code}</code> <span className="small muted">{c.merchantName ?? c.merchantDomain ?? ""}</span>
                  </td>
                  <td data-label="Verified">{c.verified ? when(c.verifiedAt) : "unverified"}</td>
                  <td data-label="State">
                    <Badge value={!c.isActive ? "RETIRED" : c.verified && c.verifiedAt && couponIsCurrent({ verifiedAt: c.verifiedAt.toISOString() }) ? "SHOWN" : "NOT SHOWN"} tone={!c.isActive ? "neutral" : c.verified ? "ok" : "warn"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
