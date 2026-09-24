const base = process.env.AUDIT_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL;
if (!base) throw new Error("AUDIT_BASE_URL or NEXT_PUBLIC_SITE_URL is required");
const origin = new URL(base);
if (!["http:","https:"].includes(origin.protocol)) throw new Error("Audit base URL must use http or https");

const seeds = ["/","/about","/privacy","/disclosure","/search","/compare","/robots.txt","/sitemap.xml"];
const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS || 10000);
const maxUrls = Number(process.env.AUDIT_MAX_URLS || 300);

async function request(url, method="GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {method, redirect:"manual", signal:controller.signal, headers:{accept:"text/html,application/xml,text/plain,*/*"}});
    return res;
  } finally { clearTimeout(timer); }
}
async function check(url) {
  let res;
  try { res = await request(url, "HEAD"); } catch (e) { return {url,status:0,error:String(e?.message || e)}; }
  if ([403,405,429].includes(res.status) || res.status >= 500) {
    try { res = await request(url, "GET"); } catch (e) { return {url,status:0,error:String(e?.message || e)}; }
  }
  return {url,status:res.status,ok:res.status >= 200 && res.status < 400};
}
function internal(raw) {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin.origin) return null;
    if (!["http:","https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.href;
  } catch { return null; }
}
function extractLinks(html) {
  const out = new Set();
  const re = /(?:href|src)\\s*=\\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) { const u = internal(m[1]); if (u) out.add(u); }
  return [...out];
}
async function read(url) {
  const res = await request(url, "GET");
  const text = await res.text();
  return {res,text};
}

const checked = new Map();
const errors = [];
for (const path of seeds) {
  const url = new URL(path, origin).href;
  const result = await check(url);
  checked.set(url,result);
  if (!result.ok) errors.push(result);
}

const sitemapUrl = new URL("/sitemap.xml", origin).href;
try {
  const {res,text} = await read(sitemapUrl);
  if (res.ok) {
    const locs = [...text.matchAll(/<loc>\\s*([^<]+?)\\s*<\\/loc>/gi)].map(m=>m[1].trim()).slice(0,maxUrls);
    for (const raw of locs) {
      const u = internal(raw);
      if (u && !checked.has(u)) checked.set(u, await check(u));
    }
  }
} catch {}

const crawl = [...checked.keys()].filter(u=>/text\\/html/i.test(checked.get(u)?.contentType || ""));
for (const url of crawl.slice(0,50)) {
  try {
    const {res,text} = await read(url);
    if (!res.ok || !/text\\/html/i.test(res.headers.get("content-type")||"")) continue;
    for (const link of extractLinks(text)) {
      if (checked.size >= maxUrls && !checked.has(link)) continue;
      if (!checked.has(link)) checked.set(link, await check(link));
    }
  } catch {}
}

for (const r of checked.values()) if (!r.ok) errors.push(r);
const uniqueErrors = [...new Map(errors.map(x=>[x.url,x])).values()];
const summary = {base:origin.href,checked:checked.size,broken:uniqueErrors.length,errors:uniqueErrors};
console.log(JSON.stringify(summary,null,2));
if (uniqueErrors.length) process.exit(1);
