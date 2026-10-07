import Link from "next/link";
import BrandLogo from "@/components/brand-logo";
import SafeImg from "@/components/safe-img";
import type { DealCardImage } from "@/lib/images/deal-card-image";
import type { DealImage } from "@/lib/images/deal-image";
import { placeholderPath } from "@/lib/pipeline/images";
import type { PriceDrop } from "@/lib/public/deals";
import { relativeTime } from "@/lib/public/display";
import { themeStyle } from "@/lib/taxonomy/themes";

/**
 * Compact homepage card for one verified price drop (the same PriceDrop /deals lists): image, brand,
 * name, current price, the previous price under the page's own label, the saving, what was verified
 * and when, and the link to the seller. The full card with every fact lives on /deals.
 */
/** The card image: the drop's resolved image (never empty), else the legacy exact photo passed by the caller. */
function cardImageOf(d: PriceDrop, image?: DealImage | null): DealCardImage | null {
  if (d.image && (d.image.exact || !image)) return d.image;
  if (image) return { src: image.src, alt: image.alt ?? "", kind: "official", exact: true, caption: null, source: `official:${image.source}`, sourceUrl: null, query: null, attribution: null, attributionUrl: null, confidence: 1, width: image.width ?? 300, height: image.height ?? 200 };
  return d.image ?? null;
}

export default function HomeDealCard({ d, image }: { d: PriceDrop; image?: DealImage | null }) {
  const img = cardImageOf(d, image);
  const brand = d.brandName ?? d.seller;
  const sellerName = d.official ? (d.brandName ?? d.seller) : d.seller;
  const checked = relativeTime(d.observedAt);
  const save = d.savingPercent >= 1 ? `Save ${d.savingPercent}%` : `Save ${d.savingText}`;
  return (
    <article className="hd-card" style={themeStyle(d.categories[0]) as React.CSSProperties}>
      <div className="hd-media">
        {img ? (
          <SafeImg
            src={img.src}
            fallback={placeholderPath(d.categories[0])}
            alt={img.alt}
            width={300}
            height={200}
            sizes="(max-width: 600px) 75vw, 300px"
            responsive={{ maxWidth: 600, boxAspect: 3 / 2 }}
            fit={img.exact ? "contain" : "cover"}
            loading="lazy"
            decoding="async"
            draggable={false}
            data-image-kind={img.kind}
          />
        ) : (
          <span className="hd-mono" aria-hidden="true">
            {brand.slice(0, 1)}
          </span>
        )}
        <span className="hd-save">{save}</span>
      </div>
      <div className="hd-body">
        <span className="hd-brand">
          {d.brandSlug && <BrandLogo slug={d.brandSlug} name={brand} height={16} />}
          {brand}
        </span>
        <h3 className="hd-name">
          {d.review ? (
            <Link href={`/review/${d.review.slug}`} draggable={false}>
              {d.productName}
            </Link>
          ) : (
            d.productName
          )}
        </h3>
        {img?.caption && (
          <p className="small muted hd-illus" data-illustrative="">
            {img.caption}
          </p>
        )}
        <p className="hd-price">
          <span className="visually-hidden">Current price </span>
          <strong>{d.priceText}</strong>
        </p>
        <p className="hd-was">
          {d.listPriceLabel} <s>{d.listPriceText}</s>
          <span className="hd-amt"> · you save {d.savingText}</span>
        </p>
        <p className="hd-verify">
          <span className="trust verified">Verified</span>
          {checked && (
            <span>
              Checked{" "}
              <time dateTime={d.observedAt} title={d.observedAt}>
                {checked}
              </time>
            </span>
          )}
        </p>
        <div className="hd-cta">
          <a className="btn primary small" href={d.url} rel={d.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank" draggable={false} data-cursor="View">
            View deal
            <span className="visually-hidden">
              {" "}
              on {d.productName} at {sellerName} (opens in a new tab)
            </span>
          </a>
          {d.affiliated && <span className="hd-aff">Affiliate link</span>}
        </div>
      </div>
    </article>
  );
}
