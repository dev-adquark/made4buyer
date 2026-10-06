/**
 * Coupon evidence page function for apify/web-scraper (runs in the crawled page, browser context).
 *
 * It returns raw evidence only: the code candidates the page explicitly marks as promo codes, the
 * text around each one, and the page's offer-like JSON-LD. It decides nothing: whether a candidate
 * is a real code, what the discount is and when it ends are settled server-side by
 * lib/commerce/coupons.ts from this evidence, and nothing missing is ever filled in.
 *
 * The text patterns are shared with the server (findCodesInText) so both sides agree on what
 * "Use code XYZ" looks like.
 */

/** "Use code XYZ", "Promo code: XYZ", "Coupon code XYZ", "Code: XYZ". The label is matched case-insensitively; the code itself is validated case-sensitively. */
export const CODE_TEXT_PATTERN = String.raw`(?:\b(?:use|enter|apply|with)\s+(?:the\s+)?(?:promo(?:tional)?\s+|coupon\s+|discount\s+|offer\s+)?code|\b(?:promo(?:tional)?|coupon|discount|offer)\s+code|\bcode)\s*(?::|-|–|is)?\s*["“'‘]?([A-Za-z0-9][A-Za-z0-9-]{2,24})`;

/** A promo code as Made4Buyers accepts it: 4–20 uppercase letters, digits or dashes, containing a letter. */
export const CODE_SHAPE = /^(?=[A-Z0-9-]*[A-Z])[A-Z0-9](?:[A-Z0-9-]{2,18})[A-Z0-9]$/;

/** Codes named in a run of text (server-side twin of the page function's text scan). */
export function findCodesInText(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(CODE_TEXT_PATTERN, "gi");
  for (const m of text.matchAll(re)) {
    const code = m[1];
    if (CODE_SHAPE.test(code) && !out.includes(code)) out.push(code);
    if (out.length >= 50) break;
  }
  return out;
}

export const MAX_CANDIDATES = 50;

export const COUPON_PAGE_FUNCTION = `async function pageFunction(context) {
  const { request } = context;
  const url = request.loadedUrl || request.url;
  const MAX = ${MAX_CANDIDATES};
  const SHAPE = ${CODE_SHAPE.toString()};
  const TEXT_RE = new RegExp(${JSON.stringify(CODE_TEXT_PATTERN)}, "gi");
  const LABEL_RE = /promo|coupon|discount|code|offer/i;
  const clean = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const BLOCK = "p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, section, article, aside, div, label, span, button, a";
  // The element's own text, widened to its parents only while it is short and the parent stays local (<= 300 chars).
  const around = (el) => {
    let node = el;
    let t = clean(node.innerText || node.textContent);
    for (let i = 0; i < 3 && t.length < 40 && node.parentElement && node.parentElement !== document.body; i++) {
      const pt = clean(node.parentElement.innerText || node.parentElement.textContent);
      if (pt.length > 300) break;
      node = node.parentElement;
      t = pt;
    }
    return t.slice(0, 300);
  };
  const describe = (el) => {
    const attrs = [];
    for (const a of el.attributes || []) {
      if (/^(id|class|name|type|role|aria-label|placeholder|data-[a-z0-9-]*)$/i.test(a.name)) attrs.push(a.name + '="' + clean(a.value).slice(0, 60) + '"');
      if (attrs.length >= 8) break;
    }
    return (el.tagName.toLowerCase() + (attrs.length ? " " + attrs.join(" ") : "")).slice(0, 300);
  };
  const near = (text, re) => { const m = text.match(re); return m ? clean(m[0]).slice(0, 120) : undefined; };
  const EXPIRES_RE = /\\b(?:expires?|exp\\.|ends?|valid\\s+(?:through|thru|until|till)|good\\s+(?:through|thru|until)|through|until)\\s*:?\\s*[^.;|]{3,40}/i;
  const DISCOUNT_RE = /(?:\\d{1,3}(?:\\.\\d+)?\\s?%\\s*off|[$£€]\\s?\\d[\\d,]*(?:\\.\\d{2})?\\s*off|free\\s+(?:standard\\s+|ground\\s+|express\\s+)?shipping|save\\s+(?:up\\s+to\\s+)?(?:\\d{1,3}\\s?%|[$£€]\\s?\\d[\\d,]*(?:\\.\\d{2})?))/i;
  const candidates = [];
  const seen = new Set();
  const add = (code, el, ctx) => {
    code = clean(code).replace(/^["“'‘]+|["”'’.,;:!]+$/g, "");
    if (!SHAPE.test(code) || candidates.length >= MAX) return;
    const context = clean(ctx).slice(0, 300);
    const key = code + "|" + context;
    if (seen.has(key)) return;
    seen.add(key);
    const c = { code, context, element: el ? describe(el) : "text" };
    const exp = near(context, EXPIRES_RE);
    const disc = near(context, DISCOUNT_RE);
    if (exp) c.expiresText = exp;
    if (disc) c.discountText = disc;
    candidates.push(c);
  };
  // 1. Elements explicitly marked as promo codes.
  const ATTRS = ["data-code", "data-promo", "data-promo-code", "data-promocode", "data-coupon", "data-coupon-code", "data-couponcode", "data-discount-code"];
  for (const el of document.querySelectorAll(ATTRS.map((a) => "[" + a + "]").join(","))) {
    if (candidates.length >= MAX) break;
    let value = "";
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v && SHAPE.test(clean(v))) { value = v; break; } }
    if (!value) value = clean(el.textContent);
    add(value, el, around(el));
  }
  // 2. Read-only inputs holding a code next to a "code"/"promo" label.
  for (const el of document.querySelectorAll("input[value]")) {
    if (candidates.length >= MAX) break;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (!["text", "hidden", "search"].includes(type)) continue;
    const id = el.getAttribute("id");
    const label = clean([
      el.getAttribute("aria-label"), el.getAttribute("name"), el.getAttribute("placeholder"),
      id ? (document.querySelector('label[for="' + CSS.escape(id) + '"]') || {}).textContent : "",
      el.closest("label") ? el.closest("label").textContent : "",
      el.previousElementSibling ? el.previousElementSibling.textContent : "",
    ].join(" "));
    if (!LABEL_RE.test(label)) continue;
    const v = el.getAttribute("value");
    add(v, el, label + " " + around(el));
  }
  // 3. Text that names a code: "Use code XYZ", "Promo code: XYZ", "Code: XYZ".
  const skip = "script, style, noscript, template, nav, footer";
  for (const el of document.querySelectorAll(BLOCK)) {
    if (candidates.length >= MAX) break;
    if (el.closest(skip)) continue;
    // Only the innermost block holding the phrase, so a code is reported once with its own context.
    const t = clean(el.innerText || el.textContent);
    if (!t || t.length > 2000) continue;
    TEXT_RE.lastIndex = 0;
    if (!TEXT_RE.test(t)) continue;
    if ([...el.children].some((ch) => { TEXT_RE.lastIndex = 0; return TEXT_RE.test(clean(ch.innerText || ch.textContent)); })) continue;
    TEXT_RE.lastIndex = 0;
    for (const m of t.matchAll(TEXT_RE)) {
      if (!SHAPE.test(m[1])) continue;
      const at = m.index || 0;
      const start = Math.max(0, at - 120);
      add(m[1], el, t.slice(start, start + 300));
    }
  }
  // Offer-like JSON-LD, kept whole (bounded) as raw evidence.
  const jsonLd = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 8 || jsonLd.length >= 20) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const types = [].concat(v["@type"] || []).map((t) => String(t).toLowerCase());
    if (types.some((t) => /offer|promotion|saleevent|discount/.test(t))) {
      const s = JSON.stringify(v);
      if (s.length <= 10000) { jsonLd.push(v); return; }
    }
    for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], depth + 1);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(s.textContent), 0); } catch (e) {} }
  return { m4bCoupon: 1, url, title: clean(document.title) || null, candidates, jsonLd };
}`;
