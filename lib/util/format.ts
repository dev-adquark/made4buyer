/** Formats a stored price; returns null when there is no real price to show. */
export function money(price: number | null | undefined, currency: string | null | undefined) {
  if (price === null || price === undefined) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(price);
  } catch {
    return `${price} ${currency ?? ""}`.trim();
  }
}

export const AVAILABILITY: Record<string, string> = { in_stock: "In stock", out_of_stock: "Out of stock", preorder: "Pre-order", unknown: "Availability not reported" };

export function availabilityLabel(v: string | null | undefined) {
  return AVAILABILITY[v ?? "unknown"] ?? v ?? AVAILABILITY.unknown;
}

export function shortDate(d: Date | string | null | undefined) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Dateline style for mono labels: "01 OCT 2026". */
export function dateline(d: Date | string | null | undefined) {
  if (!d) return null;
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, "0")} ${x.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()} ${x.getUTCFullYear()}`;
}
