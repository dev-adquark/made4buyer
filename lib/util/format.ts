import { displayDate, displayPrice, displayText } from "@/lib/public/display";

/**
 * Formats a stored price; null unless the amount is a positive finite number and the currency a
 * valid ISO 4217 code (never a guessed currency, never "$0"). See lib/public/display.ts.
 */
export function money(price: number | null | undefined, currency: string | null | undefined): string | null {
  return displayPrice(price, currency);
}

export const AVAILABILITY: Record<string, string> = { instock: "In stock", outofstock: "Out of stock", soldout: "Out of stock", preorder: "Pre-order", presale: "Pre-order", backorder: "Back-order", limitedavailability: "Limited availability", onlineonly: "Online only", instoreonly: "In store only", discontinued: "Discontinued" };

/** A reader-facing availability label, or null when the seller didn't state one (the caller leaves it out). */
export function availabilityLabel(v: string | null | undefined): string | null {
  const t = displayText(v);
  if (!t) return null;
  const k = t.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/[\s_-]/g, "");
  return AVAILABILITY[k] ?? (/^[a-z][a-z ]{2,40}$/i.test(t) && !/unknown|not reported/i.test(t) ? t : null);
}

export function shortDate(d: Date | string | null | undefined): string | null {
  const x = displayDate(d);
  if (!x) return null;
  return x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Dateline style for mono labels: "01 OCT 2026". Null for a missing or invalid date. */
export function dateline(d: Date | string | null | undefined): string | null {
  const x = displayDate(d);
  if (!x) return null;
  return `${String(x.getUTCDate()).padStart(2, "0")} ${x.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()} ${x.getUTCFullYear()}`;
}
