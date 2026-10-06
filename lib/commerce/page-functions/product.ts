/**
 * Runs inside each crawled product page (browser context) via apify/web-scraper.
 *
 * Raw only: it collects what the page itself publishes (every JSON-LD block, og:/product: meta,
 * h1, breadcrumbs, spec tables, images) and interprets nothing. Normalization happens server-side
 * in lib/commerce/normalize.ts with the same extractor as HTML pages. Returns null for any URL that
 * is not a product page of the brand (customData.productPatterns are anchored regex sources).
 */
export const PRODUCT_PAGE_FUNCTION = `async function pageFunction(context) {
  const { request, customData } = context;
  const url = request.loadedUrl || request.url;
  const patterns = (customData && customData.productPatterns) || [];
  if (!patterns.some((p) => { try { return new RegExp(p).test(url); } catch (e) { return false; } })) return null;
  const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");
  const abs = (v) => { try { return v ? new URL(v, url).toString() : null; } catch (e) { return null; } };
  // Every ld+json block: parsed as-is, or its raw text when the browser cannot parse it.
  const jsonLd = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json" i]')) {
    const raw = s.textContent || "";
    if (!raw.trim()) continue;
    try { jsonLd.push(JSON.parse(raw)); } catch (e) { jsonLd.push(raw.slice(0, 200000)); }
  }
  const meta = {};
  for (const el of document.querySelectorAll("meta[property], meta[name]")) {
    const key = (el.getAttribute("property") || el.getAttribute("name") || "").trim().toLowerCase();
    const content = (el.getAttribute("content") || "").trim();
    if (!key || !content || key in meta) continue;
    if (/^(og|product):/.test(key) || key === "twitter:title") meta[key] = content.slice(0, 2000);
  }
  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const skip = "nav, footer, header, [role=navigation], [class*=cookie i], [class*=newsletter i]";
  const crumbRoot = document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i]');
  const breadcrumbs = crumbRoot ? [...crumbRoot.querySelectorAll("li, a")].filter((el) => el.tagName !== "A" || !el.closest("li")).map(text).filter(Boolean).slice(0, 20) : [];
  const specTables = [];
  const addRow = (name, value) => { if (specTables.length < 200 && name && value) specTables.push({ name: name.slice(0, 200), value: value.slice(0, 1000) }); };
  for (const table of document.querySelectorAll("table")) {
    if (table.closest(skip)) continue;
    for (const tr of table.querySelectorAll("tr")) {
      const cells = [...tr.querySelectorAll("th, td")];
      if (cells.length === 2) addRow(text(cells[0]), text(cells[1]));
    }
  }
  for (const dl of document.querySelectorAll("dl")) {
    if (dl.closest(skip)) continue;
    let name = null;
    for (const el of dl.children) {
      if (el.tagName === "DT") name = text(el);
      else if (el.tagName === "DD" && name) { addRow(name, text(el)); name = null; }
    }
  }
  const images = [];
  const seen = new Set();
  for (const img of document.querySelectorAll("img")) {
    if (images.length >= 12) break;
    if (img.closest(skip)) continue;
    const src = abs(img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src"));
    if (!src || src.startsWith("data:") || seen.has(src)) continue;
    seen.add(src);
    images.push({ src, alt: img.getAttribute("alt") || null });
  }
  return {
    m4bCommerce: 1,
    url,
    canonicalUrl: abs(canonicalEl && canonicalEl.getAttribute("href")) || null,
    title: document.title || null,
    jsonLd,
    meta,
    h1: text(document.querySelector("h1")) || null,
    breadcrumbs,
    specTables,
    images,
    lang: document.documentElement.lang || null,
  };
}`;
