import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

type Redirect = { source: string; destination: string; permanent: boolean; has?: Array<{ type: string; value: string }> };

describe("one public host: https://made4buyers.com", () => {
  it("redirects www and the vercel.app alias to the apex (pages only; /api and /_next stay on every host)", async () => {
    const all = (await nextConfig.redirects!()) as Redirect[];
    const hosts = all.filter((r) => r.has?.some((h) => h.type === "host"));
    expect(hosts.map((r) => r.has![0].value).sort()).toEqual(["made4buyers.vercel.app", "www.made4buyers.com"]);
    for (const r of hosts) {
      expect(r).toMatchObject({ destination: "https://made4buyers.com/:path", permanent: true });
      const re = new RegExp(`^/${r.source.slice(r.source.indexOf("(") + 1, r.source.lastIndexOf(")"))}$`);
      for (const p of ["/", "/deals", "/review/x", "/coupons?page=2".split("?")[0]]) expect(re.test(p), p).toBe(true);
      for (const p of ["/api/cron/feedico-coupons", "/api/health", "/_next/static/chunks/a.js"]) expect(re.test(p), p).toBe(false);
    }
  });
});
