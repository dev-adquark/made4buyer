import type { CommerceBrand } from "@prisma/client";
import { BRAND_LIMITS, DEFAULT_BRAND_CURRENCY, DEFAULT_BRAND_TIMEZONE } from "@/lib/commerce/brands";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

export const BRAND_API = "/api/admin/commerce/brands";

const URL_HINT = "https, on the official domain or its subdomains, no port, no tracking parameters (utm_*, gclid …).";

function UrlList({ id, name, label, hint, value, placeholder, max }: { id: string; name: string; label: string; hint: string; value?: string[]; placeholder: string; max: number }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name={name} defaultValue={value?.join("\n")} placeholder={placeholder} />
      <p className="field-hint">
        {hint} One per line, at most {max}. {URL_HINT}
      </p>
    </div>
  );
}

/** Quick "Add brand": name, official domain, category, currency and its URLs. Everything else gets the defaults and is editable afterwards. */
export function AddBrandForm({ returnTo }: { returnTo: string }) {
  return (
    <form className="card card-body" action={BRAND_API} method="post">
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="enabledPresent" value="1" />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="add-name">Name</label>
          <input id="add-name" name="name" required maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="add-slug">Slug (optional)</label>
          <input id="add-slug" name="slug" pattern="[a-z0-9-]{2,60}" placeholder="derived from the name" />
        </div>
        <div className="field">
          <label htmlFor="add-domain">Official domain (https)</label>
          <input id="add-domain" name="officialDomain" required placeholder="www.example.com" />
          <p className="field-hint">A public domain name (no IP address, port or internal name). robots.txt is checked live before the first crawl.</p>
        </div>
        <div className="field">
          <label htmlFor="add-category">Category</label>
          <select id="add-category" name="categories" required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="add-currency">Currency (ISO 4217)</label>
          <input id="add-currency" name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={DEFAULT_BRAND_CURRENCY} />
        </div>
        <div className="field">
          <label htmlFor="add-enabled">
            <input id="add-enabled" name="enabled" type="checkbox" value="1" /> Enable now
          </label>
          <p className="field-hint">Unchecked: saved disabled, never crawled until enabled.</p>
        </div>
      </div>
      <UrlList id="add-deal" name="dealUrls" label="Deal URLs (official sale / deals pages)" hint="Listing pages of discounted products." placeholder="https://www.example.com/sale" max={BRAND_LIMITS.urlListItems} />
      <UrlList id="add-product" name="productUrls" label="Product URLs" hint="Single official product pages crawled every run." placeholder="https://www.example.com/products/widget" max={BRAND_LIMITS.urlListItems} />
      <UrlList id="add-promo" name="promoUrls" label="Promotions pages (coupon codes)" hint="First-party offers pages only." placeholder="https://www.example.com/offers" max={BRAND_LIMITS.listItems} />
      <UrlList id="add-disc" name="discoveryUrls" label="Discovery URLs (sitemaps or listing pages)" hint="Empty: the Sitemap lines in the brand’s robots.txt are used." placeholder="https://www.example.com/sitemap.xml" max={BRAND_LIMITS.listItems} />
      <div className="btnrow">
        <button className="btn primary" type="submit">
          Add brand
        </button>
      </div>
    </form>
  );
}

/** Full brand editor (the one editor of the source registry). */
export function BrandForm({ brand, returnTo }: { brand: CommerceBrand; returnTo: string }) {
  const p = `e-${brand.id}`;
  return (
    <form className="card card-body" action={BRAND_API} method="post" key={brand.id}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="action" value="update" />
      <input type="hidden" name="enabledPresent" value="1" />
      <input type="hidden" name="id" value={brand.id} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-name`}>Name</label>
          <input id={`${p}-name`} name="name" required maxLength={80} defaultValue={brand.name} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-slug`}>Slug</label>
          <input id={`${p}-slug`} name="slug" required pattern="[a-z0-9-]{2,60}" defaultValue={brand.slug} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-domain`}>Official domain (https)</label>
          <input id={`${p}-domain`} name="officialDomain" required defaultValue={brand.officialDomain} placeholder="www.example.com" />
        </div>
        <div className="field">
          <label htmlFor={`${p}-market`}>Market</label>
          <input id={`${p}-market`} name="market" required pattern="[A-Za-z]{2}" maxLength={2} defaultValue={brand.market} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-currency`}>Currency (ISO 4217)</label>
          <input id={`${p}-currency`} name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={brand.currency} />
          <p className="field-hint">Prices in another currency are not stored.</p>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-prio`}>Priority (higher first)</label>
          <input id={`${p}-prio`} name="priority" type="number" min={BRAND_LIMITS.priority.min} max={BRAND_LIMITS.priority.max} defaultValue={brand.priority} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-freq`}>Crawl every (hours)</label>
          <input id={`${p}-freq`} name="crawlFrequencyHours" type="number" min={BRAND_LIMITS.crawlFrequencyHours.min} max={BRAND_LIMITS.crawlFrequencyHours.max} defaultValue={brand.crawlFrequencyHours} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-max`}>Products per run</label>
          <input id={`${p}-max`} name="maxProductsPerRun" type="number" min={BRAND_LIMITS.maxProductsPerRun.min} max={BRAND_LIMITS.maxProductsPerRun.max} defaultValue={brand.maxProductsPerRun} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-enabled`}>
            <input id={`${p}-enabled`} name="enabled" type="checkbox" value="1" defaultChecked={brand.enabled} /> Enabled
          </label>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${p}-wstart`}>Crawl window start (hour 0–23)</label>
          <input
            id={`${p}-wstart`}
            name="crawlWindowStartHour"
            type="number"
            min={BRAND_LIMITS.crawlWindowStartHour.min}
            max={BRAND_LIMITS.crawlWindowStartHour.max}
            defaultValue={brand.crawlWindowStartHour !== null && brand.crawlWindowHours < 24 ? brand.crawlWindowStartHour : ""}
            placeholder="Any time"
          />
          <p className="field-hint">Blank = any time. Staggers brands across the day.</p>
        </div>
        <div className="field">
          <label htmlFor={`${p}-whours`}>Window length (hours 1–24)</label>
          <input id={`${p}-whours`} name="crawlWindowHours" type="number" min={BRAND_LIMITS.crawlWindowHours.min} max={BRAND_LIMITS.crawlWindowHours.max} defaultValue={brand.crawlWindowHours} />
          <p className="field-hint">A brand that misses its window for longer than its crawl frequency is crawled anyway.</p>
        </div>
        <div className="field">
          <label htmlFor={`${p}-tz`}>Time zone (IANA)</label>
          <input id={`${p}-tz`} name="timezone" maxLength={64} defaultValue={brand.timezone} placeholder={DEFAULT_BRAND_TIMEZONE} />
        </div>
        <div className="field">
          <label htmlFor={`${p}-store`}>Official store URL (optional)</label>
          <input id={`${p}-store`} name="officialStoreUrl" type="url" maxLength={300} defaultValue={brand.officialStoreUrl ?? ""} placeholder="https://www.example.com/shop" />
          <p className="field-hint">{URL_HINT}</p>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${p}-cats`}>Categories, one slug per line</label>
        <textarea id={`${p}-cats`} name="categories" required defaultValue={brand.categories.join("\n")} placeholder="laptops" />
        <p className="field-hint">Made4Buyers category slugs: {CATEGORIES.map((c) => c.slug).join(", ")}.</p>
      </div>
      <UrlList id={`${p}-deal`} name="dealUrls" label="Deal URLs (official sale / deals pages)" hint="Listing pages of discounted products, crawled one link deep." value={brand.dealUrls} placeholder="https://www.example.com/sale" max={BRAND_LIMITS.urlListItems} />
      <UrlList id={`${p}-product`} name="productUrls" label="Product URLs" hint="Single official product pages crawled every run (besides discovery)." value={brand.productUrls} placeholder="https://www.example.com/products/widget" max={BRAND_LIMITS.urlListItems} />
      <UrlList id={`${p}-promo`} name="promoUrls" label="Official promotions pages (coupon codes)" hint="First-party offers pages only." value={brand.promoUrls} placeholder="https://www.example.com/offers" max={BRAND_LIMITS.listItems} />
      <UrlList id={`${p}-disc`} name="discoveryUrls" label="Discovery URLs (sitemaps or listing pages)" hint="Empty: the Sitemap lines in the brand’s robots.txt are used. Paths are never guessed." value={brand.discoveryUrls} placeholder="https://www.example.com/sitemap.xml" max={BRAND_LIMITS.listItems} />
      <div className="field">
        <label htmlFor={`${p}-pat`}>Product URL patterns, one per line</label>
        <textarea id={`${p}-pat`} name="productUrlPatterns" defaultValue={brand.productUrlPatterns.join("\n")} placeholder="https://www.example.com/products/*" />
        <p className="field-hint">Globs that must start with https://&lt;official domain&gt;/. * matches within one path segment, ** across segments. Empty: a conservative product-page heuristic is used.</p>
      </div>
      <div className="field">
        <label htmlFor={`${p}-notes`}>Notes</label>
        <textarea id={`${p}-notes`} name="notes" maxLength={BRAND_LIMITS.notes} defaultValue={brand.notes ?? ""} />
      </div>
      <div className="btnrow">
        <button className="btn primary" type="submit">
          Save brand
        </button>
        <a className="btn" href={returnTo}>
          Cancel
        </a>
      </div>
    </form>
  );
}
