/**
 * Post-deploy smoke test (read-only): health + schema status, then every sitemap URL, every
 * category page and the key hubs must return 200 without an error boundary.
 * Usage: npx tsx scripts/smoke-prod.ts [https://made4buyers.vercel.app]
 */
import { CATEGORIES } from "../lib/taxonomy/definitions";

const base = (process.argv[2] ?? "https://made4buyers.vercel.app").replace(
  /\/+$/,
  "",
);
const ERROR_TEXT =
  /couldn.t load|Something went wrong|Application error|Internal Server Error/i;

async function main() {
  const failures: string[] = [];
  const health = (await fetch(`${base}/api/health`).then((r) => r.json())) as {
    status: string;
    database: string;
    schema?: string;
    commit?: string;
  };
  console.log(
    `health: ${health.status} · database ${health.database} · schema ${health.schema ?? "n/a"} · commit ${health.commit?.slice(0, 7)}`,
  );
  if (health.database !== "ok" || health.schema !== "ok")
    failures.push(
      `health: database=${health.database} schema=${health.schema}`,
    );
  const sitemap = await fetch(`${base}/sitemap.xml`).then((r) => r.text());
  const urls = new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
  );
  for (const p of [
    "/",
    "/reviews",
    "/guides",
    "/deals",
    "/compare",
    "/match",
    "/search?q=vpn",
    "/reviews?type=comparison",
    ...CATEGORIES.map((c) => `/category/${c.slug}`),
  ])
    urls.add(base + p);
  let ok = 0;
  const list = [...urls];
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(
      list.slice(i, i + 6).map(async (u) => {
        const res = await fetch(u, { redirect: "manual" });
        const body = res.status === 200 ? await res.text() : "";
        if (res.status !== 200 || ERROR_TEXT.test(body))
          failures.push(`${res.status} ${u}`);
        else ok++;
      }),
    );
  }
  console.log(`routes: ${ok}/${list.length} OK`);
  if (failures.length) {
    console.error(
      `SMOKE FAILED (${failures.length}):\n  ${failures.join("\n  ")}`,
    );
    process.exitCode = 1;
  } else console.log("SMOKE OK");
}
main().catch((e) => {
  console.error(`SMOKE FAILED: ${e}`);
  process.exitCode = 1;
});
