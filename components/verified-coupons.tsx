import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { toPromoCode, type PromoCode } from "@/lib/public/deals";
import { PromoCodeCard } from "./official-deals";

/**
 * Promo codes a brand publishes on its own official site or store, for a review page. The rows come
 * from verifiedCouponsFor(), which applies THE public coupon rule (publicCoupons() in
 * lib/commerce/deal-status.ts): VERIFIED, started, unexpired, verified within the last
 * COMMERCE_COUPON_MAX_AGE_DAYS (7) days, on the brand's own domain, not a duplicate and not
 * contradicted. Older codes are kept for history but never shown. Renders nothing when there are none.
 * Each card is the same one /deals shows: every field exactly as stated, or left out when empty.
 */
export default async function VerifiedCoupons({ brandId, merchant, limit = 4, heading = "Codes from the brand" }: { brandId?: string | null; merchant?: string | null; limit?: number; heading?: string }) {
  const rows = await verifiedCouponsFor({ brandId, merchant }, new Date(), limit).catch(() => []);
  const coupons = rows.map((c) => (c.brand ? toPromoCode(c, c.brand) : null)).filter((c): c is PromoCode => c !== null);
  if (!coupons.length) return null;
  return (
    <section className="verified-coupons" aria-labelledby="verified-coupons-title">
      <h2 id="verified-coupons-title" className="small" style={{ margin: "0 0 8px" }}>
        {heading}
      </h2>
      <ul className="coupon-grid compact">
        {coupons.map((c) => (
          <li key={c.id}>
            <PromoCodeCard c={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}
