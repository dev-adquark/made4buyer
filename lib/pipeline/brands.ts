/** Brand dictionary used for deterministic brand detection and product-key normalisation. */
export const KNOWN_BRANDS: string[] = [
  "Apple", "Samsung", "Google", "Microsoft", "Dell", "HP", "Lenovo", "Asus", "Acer", "MSI", "Razer", "Alienware",
  "Framework", "LG", "Sony", "Huawei", "Xiaomi", "OnePlus", "Oppo", "Vivo", "Motorola", "Nokia", "Nothing", "Fairphone",
  "Honor", "Realme", "Logitech", "Corsair", "SteelSeries", "HyperX", "Keychron", "Anker", "Belkin", "Ugreen", "Satechi",
  "CalDigit", "Plugable", "Elgato", "Bose", "Sennheiser", "Jabra", "Beats", "JBL", "Sonos", "Audio-Technica", "Shure",
  "Rode", "Garmin", "Fitbit", "Oura", "Whoop", "Amazfit", "Withings", "Netgear", "TP-Link", "Eero", "Linksys", "Ubiquiti",
  "Synology", "Western Digital", "Seagate", "Crucial", "SanDisk", "Kingston", "Intel", "AMD", "Nvidia", "Qualcomm",
  "Amazon", "Kobo", "reMarkable", "Wacom", "BenQ", "ViewSonic", "Gigabyte", "Philips", "OpenAI", "Anthropic", "Perplexity",
  "Midjourney", "GitHub", "GitLab", "JetBrains", "Docker", "Atlassian", "Notion", "Figma", "Adobe", "Canva", "Vercel",
  "Netlify", "Postman", "Supabase", "MongoDB", "Cursor", "Replit", "Grammarly", "Otter.ai", "Zoom", "Slack", "Chrome",
  "Mozilla", "Proton", "1Password", "Bitwarden", "NordVPN", "Surfshark",
];

/** Product families that imply a brand when the brand itself is not written. */
export const PRODUCT_FAMILY_BRANDS: Array<[RegExp, string]> = [
  [/\b(iphone|ipad|macbook|imac|mac mini|mac studio|airpods|apple watch|vision pro)\b/i, "Apple"],
  [/\b(galaxy)\b/i, "Samsung"],
  [/\bpixel\b/i, "Google"],
  [/\b(surface|xbox)\b/i, "Microsoft"],
  [/\b(xps|inspiron|latitude|precision)\b/i, "Dell"],
  [/\b(spectre|envy|elitebook|omen|pavilion)\b/i, "HP"],
  [/\b(thinkpad|ideapad|legion|yoga)\b/i, "Lenovo"],
  [/\b(zenbook|vivobook|rog|tuf)\b/i, "Asus"],
  [/\b(swift|predator|aspire)\b/i, "Acer"],
  [/\b(chatgpt|dall-e|sora)\b/i, "OpenAI"],
  [/\bclaude\b/i, "Anthropic"],
  [/\bgemini\b/i, "Google"],
  [/\bcopilot\b/i, "Microsoft"],
  [/\b(kindle|echo|fire hd)\b/i, "Amazon"],
  [/\b(intellij|pycharm|webstorm|rider)\b/i, "JetBrains"],
  [/\bvs code\b|\bvisual studio\b/i, "Microsoft"],
];

const lowerBrands = KNOWN_BRANDS.map((b) => b.toLowerCase());

export function canonicalBrand(value: string): string | undefined {
  const idx = lowerBrands.indexOf(value.trim().toLowerCase());
  return idx >= 0 ? KNOWN_BRANDS[idx] : undefined;
}

/** Finds the first known brand token in text (word-boundary match, earliest position wins). */
export function findBrand(text: string): string | undefined {
  const lower = text.toLowerCase();
  let best: { brand: string; index: number } | undefined;
  for (let i = 0; i < lowerBrands.length; i++) {
    const escaped = lowerBrands[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).exec(lower);
    if (match && (!best || match.index < best.index)) best = { brand: KNOWN_BRANDS[i], index: match.index };
  }
  return best?.brand;
}

export function familyBrand(text: string): string | undefined {
  return PRODUCT_FAMILY_BRANDS.find(([re]) => re.test(text))?.[1];
}

/** Removes a leading brand token so "Apple MacBook Air" and "MacBook Air" share a product key. */
export function stripLeadingBrand(productName: string, brand?: string | null): string {
  let out = productName.trim();
  const candidates = [brand, findBrand(out)].filter((b): b is string => Boolean(b));
  for (const b of candidates) {
    const re = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
    out = out.replace(re, "");
  }
  return out.trim() || productName.trim();
}
