/**
 * Runs inside each crawled page (browser context) via apify/web-scraper.
 *
 * Raw only: it collects what the page itself publishes (every JSON-LD block, og:/product: meta,
 * h1, breadcrumbs, spec tables, images, the main price block, and on a Shopify store the public
 * product JSON) and interprets nothing. Normalization happens server-side in
 * lib/commerce/normalize.ts. Returns null for any page that is not a product page of the brand.
 *
 * Labels (request.userData.label): PRODUCT (a start product URL; must match
 * customData.productPatterns), LISTING (an official deal page; links are followed by the actor,
 * the page itself yields nothing unless it is a product page), and no label in a deal run = a page
 * reached by following a link (it must be on customData.officialHost, match
 * customData.followPatterns and be a US storefront path when customData.usOnly).
 *
 * Shopify: on a store page (window.Shopify) whose path has /products/, the same-origin
 * `<path>.js` product JSON is fetched (one request) only when robots.txt (customData.robotsRules,
 * from the server) allows that path; when the rules are unknown (null) nothing is fetched.
 */
export const PRODUCT_PAGE_FUNCTION = `async function pageFunction(context) {
  const { request, customData } = context;
  const cd = customData || {};
  const url = request.loadedUrl || request.url;
  const label = (request.userData && request.userData.label) || (cd.dealCrawl ? "LINKED" : "PRODUCT");
  // Only listing pages may have their links followed (depth 1); product pages never enqueue.
  if (label !== "LISTING" && typeof context.skipLinks === "function") { try { await context.skipLinks(); } catch (e) {} }
  const test = (sources, u) => (sources || []).some((p) => { try { return new RegExp(p, "i").test(u); } catch (e) { return false; } });
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch (e) { return ""; } };
  const localeCodes = new Set(cd.localeCodes || []);
  const usPath = (u) => {
    if (!cd.usOnly) return true;
    let segs = [];
    try { segs = new URL(u).pathname.split("/").filter(Boolean).slice(0, 2); } catch (e) { return false; }
    for (const seg of segs) {
      const s = seg.toLowerCase();
      if (/^[a-z]{2}[-_][a-z]{2}$/.test(s) && (localeCodes.has(s.slice(0, 2)) || localeCodes.has(s.slice(3)))) return /[-_]us$/.test(s);
      if (localeCodes.has(s)) return s === "us" || s === "en";
    }
    return true;
  };
  const followable = (u) => hostOf(u) === cd.officialHost && test(cd.followPatterns, u) && usPath(u);
  function robotsOk(rules, path) {
    let best = null;
    for (const r of rules) {
      const anchored = r.path.endsWith("$");
      const src = (anchored ? r.path.slice(0, -1) : r.path).split("*").map((x) => x.replace(/[.*+?^$\{}()|[\\]\\\\]/g, "\\\\$&")).join(".*");
      let re;
      try { re = new RegExp("^" + src + (anchored ? "$" : "")); } catch (e) { return false; }
      if (!re.test(path)) continue;
      if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) best = { allow: r.allow, len: r.path.length };
    }
    return best ? best.allow : true;
  }
  // The requested URL decides (a product URL that redirects, e.g. to add a trailing slash, still counts).
  const candidates = [request.url, url];
  const isProduct = label === "PRODUCT" ? candidates.some((u) => test(cd.productPatterns, u)) : candidates.some((u) => followable(u));
  if (label === "LISTING" && !isProduct) {
    // Shopify listings often link products inside a collection (/collections/x/products/y): the
    // product's own URL (/products/y) is enqueued instead, only when followable and allowed by robots.txt.
    try {
      if (window.Shopify && Array.isArray(cd.robotsRules) && typeof context.enqueueRequest === "function") {
        const queued = new Set();
        for (const a of document.querySelectorAll('a[href*="/products/"]')) {
          if (queued.size >= (cd.followCap || 20)) break;
          let u;
          try { u = new URL(a.getAttribute("href"), url); } catch (e) { continue; }
          const m = /^(.*?)\\/collections\\/[^/]+\\/products\\/([^/?#]+)/.exec(u.pathname);
          if (!m) continue;
          const variant = u.searchParams.get("variant");
          const target = u.origin + m[1] + "/products/" + m[2] + (variant && /^\\d+$/.test(variant) ? "?variant=" + variant : "");
          if (queued.has(target) || !followable(target) || !robotsOk(cd.robotsRules, m[1] + "/products/" + m[2])) continue;
          queued.add(target);
          await context.enqueueRequest({ url: target });
        }
      }
    } catch (e) {}
    return null;
  }
  if (!isProduct) return null;
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

  // Shopify product JSON (same origin, one request, only when robots.txt allows the path).
  let shopifyProduct = null;
  let shopifyCurrency = null;
  let shopifyCountry = null;
  let shopifyNote = null;
  try {
    if (window.Shopify && /\\/products\\//.test(location.pathname)) {
      shopifyCurrency = (window.Shopify.currency && window.Shopify.currency.active) || null;
      shopifyCountry = window.Shopify.country || null;
      const jsPath = location.pathname.replace(/\\/$/, "") + ".js";
      if (!Array.isArray(cd.robotsRules)) shopifyNote = "robots rules unknown: product JSON not fetched";
      else if (!robotsOk(cd.robotsRules, jsPath)) shopifyNote = "robots.txt disallows " + jsPath;
      else {
        const ctl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
        const res = await fetch(location.origin + jsPath, { credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
        if (timer) clearTimeout(timer);
        if (res.ok) {
          const p = await res.json();
          if (p && typeof p === "object" && Array.isArray(p.variants)) {
            if (JSON.stringify(p).length > 1000000) { delete p.description; delete p.media; }
            shopifyProduct = p;
          } else shopifyNote = "product JSON has no variants";
        } else shopifyNote = "product JSON HTTP " + res.status;
      }
    }
  } catch (e) { shopifyNote = "product JSON failed: " + String(e).slice(0, 100); }

  // The main price block: near the primary h1 / product form, showing a structured current price.
  const priceBlocks = [];
  try {
    const amounts = new Set();
    const addAmount = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, "")); if (isFinite(n) && n > 0 && amounts.size < 12) amounts.add(Math.round(n * 100) / 100); };
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 10) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
      for (const k of ["price", "lowPrice"]) if (typeof v[k] === "number" || typeof v[k] === "string") addAmount(v[k]);
      for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], d + 1);
    };
    walk(jsonLd.filter((x) => x && typeof x === "object"), 0);
    addAmount(meta["product:price:amount"] || meta["og:price:amount"]);
    if (shopifyProduct) {
      const want = new URL(url).searchParams.get("variant");
      const v = shopifyProduct.variants.find((x) => (want ? String(x.id) === want : x.available)) || null;
      if (v && Number.isInteger(v.price)) addAmount(v.price / 100);
    }
    const visible = (el) => { if (!el || !el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
    const h1 = [...document.querySelectorAll("h1")].find((h) => visible(h) && !h.closest("header, nav, footer"));
    if (amounts.size && h1) {
      const hasCartForm = (el) => !!el.querySelector('form[action*="/cart/add"], form[action*="cart" i], [name="add"], [data-product-form], button[type=submit]');
      let root = h1.parentElement;
      let found = false;
      for (let i = 0; root && i < 8; i++) {
        if (hasCartForm(root)) { found = true; break; }
        if (!root.parentElement || root.parentElement === document.body) break;
        root = root.parentElement;
      }
      // No product form near the h1: stay close to it (3 levels up).
      if (!found) { root = h1; for (let i = 0; i < 3 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement; }
      const noise = "nav, header, footer, [class*=recommend i], [class*=related i], [class*=upsell i], [class*=cross-sell i], [class*=crosssell i], [class*=you-may i], [class*=complementary i], [class*=bundle i], [class*=review i]";
      const fmt = [];
      for (const a of amounts) {
        const fixed = a.toFixed(2);
        const int = Math.floor(a);
        fmt.push(int.toLocaleString("en-US") + "." + fixed.slice(-2), fixed);
        if (a === int) fmt.push(int.toLocaleString("en-US"), String(int));
      }
      const res = fmt.map((f) => new RegExp("(^|[^0-9.,])" + f.replace(/[.,]/g, "\\\\$&") + "(?![0-9]|[.,][0-9])"));
      const showsPrice = (t) => res.some((re) => re.test(t));
      const hits = [];
      for (const el of root.querySelectorAll("*")) {
        if (hits.length >= 3) break;
        if (el.children.length > 4 || el.closest(noise)) continue;
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!t || t.length > 40 || !showsPrice(t) || !visible(el)) continue;
        if (hits.some((h) => h.contains(el) || el.contains(h))) continue;
        hits.push(el);
      }
      const marker = /\\b(was|reg|regular|original|compare|list[ _-]?price|msrp|m\\.s\\.r\\.p|retail|suggested|rrp)\\b/i;
      const done = new Set();
      for (const hit of hits) {
        let block = hit;
        for (let i = 0; i < 4 && block.parentElement && block.parentElement !== root && root.contains(block.parentElement); i++) {
          if ((block.parentElement.innerText || "").trim().length > 400) break;
          block = block.parentElement;
        }
        if (done.has(block)) continue;
        done.add(block);
        const comparisons = [];
        for (const el of block.querySelectorAll("*")) {
          if (comparisons.length >= 8) break;
          if (!visible(el)) continue;
          const tag = el.tagName.toLowerCase();
          const t = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          if (!t || t.length > 80 || !/\\d/.test(t)) continue;
          const cls = (typeof el.className === "string" ? el.className : "").slice(0, 200);
          const aria = (el.getAttribute("aria-label") || "").slice(0, 200);
          // Struck through by markup (<s>, <del>, <strike>) or by style (text-decoration: line-through).
          const struck = tag === "s" || tag === "del" || tag === "strike" || /line-through/.test(getComputedStyle(el).textDecorationLine || "");
          if (!struck && !marker.test(cls + " " + aria + " " + t)) continue;
          if (!struck && el.querySelector("s, del, strike")) continue;
          const prev = el.previousElementSibling ? (el.previousElementSibling.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60) : "";
          const parent = el.parentElement ? (el.parentElement.textContent || "").replace(/\\s+/g, " ").trim() : "";
          comparisons.push({ tag, struck, text: t, cls, aria, label: [prev, parent.length <= 100 ? parent : ""].filter(Boolean).join(" ").slice(0, 160) });
        }
        priceBlocks.push({ text: (block.innerText || "").trim().slice(0, 800), comparisons });
      }
    }
  } catch (e) {}

  return {
    m4bCommerce: 1,
    url,
    requestUrl: request.url,
    crawlLabel: label,
    canonicalUrl: abs(canonicalEl && canonicalEl.getAttribute("href")) || null,
    title: document.title || null,
    jsonLd,
    meta,
    h1: text(document.querySelector("h1")) || null,
    breadcrumbs,
    specTables,
    images,
    priceBlocks,
    shopifyProduct,
    shopifyCurrency,
    shopifyCountry,
    shopifyNote,
    lang: document.documentElement.lang || null,
  };
}`;
