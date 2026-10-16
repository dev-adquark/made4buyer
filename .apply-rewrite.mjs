// Usage (from the repo root, copied in as .apply-rewrite.mjs): MODE=check|apply SP=<scratchpad>/rewrite DB_URL=... npx tsx .apply-rewrite.mjs
import fs from "node:fs";
const SP = process.env.SP;
const MODE = process.env.MODE ?? "check";
process.env.DATABASE_URL = process.env.DB_URL;
process.env.DIRECT_URL = process.env.DB_URL;
const { shingleSimilarity } = await import("./lib/pipeline/rewrite.ts");

const originals = new Map(JSON.parse(fs.readFileSync(`${SP}/backup-originals.json`, "utf8")).map((r) => [r.id, r]));
const outs = [];
for (const f of fs.readdirSync(SP).filter((f) => /^out-\d+\.json$/.test(f)).sort()) {
  try {
    outs.push(...JSON.parse(fs.readFileSync(`${SP}/${f}`, "utf8")).map((o) => ({ ...o, file: f })));
  } catch (e) {
    console.log(`BAD JSON ${f}: ${String(e).slice(0, 150)}`);
  }
}

const PUBLISHERS = /pack hacker|packhacker|android authority|androidauthority|cloudwards|man of many|manofmany|housefresh|dev tool reviews|devtoolreviews|https?:\/\/|www\./i;
const FIRST_PERSON = /(^|[\s"(])(I|I'm|I've|I'd|I'll|me|my|mine|we|we're|we've|our|ours|us)(?=[\s,.!?;:")]|$)/;

const good = [];
const bad = [];
for (const o of outs) {
  const orig = originals.get(o.id);
  const why = [];
  if (!orig) why.push("unknown id");
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (summary.length < 20 || summary.length > 300) why.push(`summary length ${summary.length}`);
  if (body.length < 120) why.push(`body length ${body.length}`);
  if (orig) {
    const sim = shingleSimilarity(body, orig.body);
    o.similarity = sim;
    if (sim > 0.35) why.push(`similarity ${(sim * 100).toFixed(0)}%`);
    const names = [orig.author, orig.source?.replace(/^apify:/, "")].filter((x) => x && x.length > 3);
    for (const n of names) if (`${summary} ${body}`.toLowerCase().includes(n.toLowerCase())) why.push(`names "${n}"`);
  }
  if (PUBLISHERS.test(`${summary} ${body}`)) why.push(`publisher/url: "${`${summary} ${body}`.match(PUBLISHERS)[0]}"`);
  const fp = `${summary}\n${body}`.match(FIRST_PERSON);
  if (fp) why.push(`first person "${fp[2]}"`);
  (why.length ? bad : good).push({ ...o, summary, body, why, slug: orig?.slug ?? "?" });
}

const missing = [...originals.keys()].filter((id) => !outs.some((o) => o.id === id));
console.log(`rewrites ${outs.length} / ${originals.size}; pass ${good.length}; fail ${bad.length}; missing ${missing.length}`);
for (const b of bad) console.log(`FAIL ${b.file} ${b.slug}: ${b.why.join("; ")}`);
for (const id of missing) console.log(`MISSING ${originals.get(id).slug}`);
const sims = good.map((g) => g.similarity).sort((a, b) => b - a);
if (sims.length) console.log(`similarity of passing rewrites: max ${(sims[0] * 100).toFixed(1)}%, median ${(sims[Math.floor(sims.length / 2)] * 100).toFixed(1)}%`);

if (MODE === "apply") {
  const { db } = await import("./lib/db.ts");
  const { persistPageRenderModel } = await import("./lib/pipeline/render-model.ts");
  const now = new Date();
  let applied = 0;
  for (const g of good) {
    await db.normalizedReview.update({ where: { id: g.id }, data: { body: g.body, summary: g.summary, contentRewritten: true, rewrittenAt: now, rewriteAttempts: { increment: 1 } } });
    await persistPageRenderModel(g.id);
    applied++;
  }
  console.log(`APPLIED ${applied}`);
}
process.exit(0);
