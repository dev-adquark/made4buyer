import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkGscAccess, gscVerificationMetadata, listSitemaps, querySearchConsole, resetGscTokenCache, runGscMaintenance, sitemapUrl, submitSitemap } from "@/lib/gsc";
import { withEnv } from "../support/env";
import { miniStub, type StubReply, type StubRequest } from "../support/mini-stub";

const SITE = "https://made4buyers.vercel.app/";
const claims = (r: StubRequest) => JSON.parse(Buffer.from(new URLSearchParams(r.body).get("assertion")!.split(".")[1], "base64url").toString()) as { scope: string; iss: string };

let route: (r: StubRequest) => StubReply = () => ({ status: 404 });
let stub: Awaited<ReturnType<typeof miniStub>>;
let restore: () => void;
let sitemaps: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  stub = await miniStub((r) => route(r));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  restore = withEnv({
    GSC_SITE_URL: SITE,
    GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "m4b-gsc@example-project.iam.gserviceaccount.com", private_key: privateKey }),
    GSC_TOKEN_URL: `${stub.base}/token`,
    GSC_API_BASE_URL: `${stub.base}/webmasters/v3`,
    GSC_INSPECTION_URL: `${stub.base}/inspect`,
    NEXT_PUBLIC_SITE_URL: "https://made4buyers.vercel.app",
    DATABASE_URL: undefined,
  });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => {
  resetGscTokenCache();
  stub.requests.length = 0;
  sitemaps = [];
  const prop = `/webmasters/v3/sites/${encodeURIComponent(SITE)}`;
  route = (r) => {
    if (r.path === "/token") return { body: { access_token: claims(r).scope.endsWith("readonly") ? "ro-token" : "full-token", expires_in: 3600 } };
    if (r.path === prop) return { body: { siteUrl: SITE, permissionLevel: "siteFullUser" } };
    if (r.path === `${prop}/sitemaps` && r.method === "GET") return { body: { sitemap: sitemaps } };
    if (r.path.startsWith(`${prop}/sitemaps/`) && r.method === "PUT") return r.headers.authorization === "Bearer full-token" ? { status: 204 } : { status: 403 };
    if (r.path === `${prop}/searchAnalytics/query`) {
      const q = JSON.parse(r.body) as { dimensions: string[] };
      return { body: q.dimensions.length ? { rows: [{ keys: ["2026-10-01"], clicks: 3, impressions: 40 }, { keys: ["2026-10-02"], clicks: 2, impressions: 60 }] } : { rows: [{ clicks: 5, impressions: 100, ctr: 0.05, position: 7.5 }] } };
    }
    if (r.path === "/inspect") return { body: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } } };
    return { status: 404 };
  };
});

describe("Search Console (stub Google APIs)", () => {
  it("checks property access with a read-only token", async () => {
    expect(await checkGscAccess()).toEqual({ ok: true, siteUrl: SITE, permissionLevel: "siteFullUser" });
    const tok = stub.requests.find((r) => r.path === "/token")!;
    expect(claims(tok)).toMatchObject({ scope: "https://www.googleapis.com/auth/webmasters.readonly", iss: "m4b-gsc@example-project.iam.gserviceaccount.com" });
  });

  it("reports the API's own clicks/impressions", async () => {
    expect(await querySearchConsole("2026-09-01", "2026-09-28")).toMatchObject({ clicks: 5, impressions: 100, ctr: 0.05, position: 7.5 });
  });

  it("lists sitemaps and submits with the full scope only for the PUT", async () => {
    sitemaps = [{ path: "https://made4buyers.vercel.app/sitemap.xml", lastSubmitted: "2026-10-01T00:00:00Z", errors: "0", contents: [{ submitted: "120", indexed: "80" }] }];
    expect(await listSitemaps()).toEqual([expect.objectContaining({ path: sitemapUrl(), submitted: 120, indexed: 80, errors: 0 })]);
    expect(await submitSitemap()).toEqual({ ok: true });
    const put = stub.requests.find((r) => r.method === "PUT")!;
    expect(decodeURIComponent(put.path)).toContain("/sitemaps/https://made4buyers.vercel.app/sitemap.xml");
    expect(stub.requests.filter((r) => r.path === "/token").map((r) => claims(r).scope)).toEqual(["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/webmasters"]);
  });

  it("explains a 403 on submit (service account needs FULL permission)", async () => {
    route = ((orig) => (r: StubRequest) => (r.method === "PUT" ? { status: 403 } : orig(r)))(route);
    expect(await submitSitemap()).toMatchObject({ ok: false, httpStatus: 403, reason: expect.stringMatching(/FULL permission/) });
  });

  it("maintenance submits a sitemap that was never submitted, then snapshots analytics", async () => {
    const r = await runGscMaintenance(new Date("2026-10-07T12:00:00Z"));
    expect(r.status).toBe("OK");
    expect(r.sitemap).toMatchObject({ action: "submitted", url: "https://made4buyers.vercel.app/sitemap.xml" });
    expect(r.analytics).toMatchObject({ clicks: 5, impressions: 100, startDate: "2026-09-08", endDate: "2026-10-05" });
  });

  it("maintenance leaves a recently submitted sitemap alone", async () => {
    sitemaps = [{ path: "https://made4buyers.vercel.app/sitemap.xml", lastSubmitted: "2026-10-05T00:00:00Z" }];
    const r = await runGscMaintenance(new Date("2026-10-07T12:00:00Z"));
    expect(r.sitemap).toMatchObject({ action: "already_current" });
    expect(stub.requests.some((q) => q.method === "PUT")).toBe(false);
  });

  it("is NOT_AVAILABLE_IN_ENVIRONMENT without credentials", async () => {
    const r2 = withEnv({ GSC_SERVICE_ACCOUNT_JSON: undefined });
    expect(await runGscMaintenance()).toEqual({ status: "NOT_AVAILABLE_IN_ENVIRONMENT" });
    expect(await checkGscAccess()).toMatchObject({ ok: false });
    r2();
  });
});

describe("site verification meta tag", () => {
  it("is emitted only for a well-formed GOOGLE_SITE_VERIFICATION", () => {
    const r = withEnv({ GOOGLE_SITE_VERIFICATION: "abcDEF123_-xyz789" });
    expect(gscVerificationMetadata()).toEqual({ verification: { google: "abcDEF123_-xyz789" } });
    r();
    const r2 = withEnv({ GOOGLE_SITE_VERIFICATION: '"><script>' });
    expect(gscVerificationMetadata()).toEqual({});
    r2();
  });
});
