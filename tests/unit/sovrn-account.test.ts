import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSovrnCampaignsCache, fetchSovrnCampaigns, parseJsonp, sovrnApprovalStatus } from "@/lib/sovrn/account";
import { withEnv } from "../support/env";

const SECRET = "secret-test-key-0123456789";
const SITE_KEY = "abcdef1234567890site";
const OTHER_KEY = "zzzzzz9999999999other";

type Reply = { status: number; body: string };
let reply: Reply;
let requests: Array<{ url: string; authorization?: string }> = [];
let server: http.Server;
let base: string;

const body = (campaigns: unknown[], extra: Record<string, unknown> = {}) =>
  `NULL(${JSON.stringify({ queryProfile: { accountId: 4242, page: 1, rowsPerPage: 100, name: "PRIMARY" }, totalResults: campaigns.length, campaigns, ...extra })})`;

const thisSite = { campaignId: 111, apiKey: SITE_KEY, name: "made4buyers.com", rawName: "made4buyers.com", approvalStatus: "PENDING", category: "Shopping", platform: "Other", applicationType: "Website", optimize: true };
const otherSite = { campaignId: 222, apiKey: OTHER_KEY, name: "other.example", approvalStatus: "APPROVED", category: "Tech", platform: "WordPress", applicationType: "Blog", optimize: false };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account/campaigns`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let restore: () => void;
beforeEach(() => {
  clearSovrnCampaignsCache();
  requests = [];
  reply = { status: 200, body: body([thisSite, otherSite]) };
  restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", SOVRN_CAMPAIGNS_URL: base, SOVRN_API_KEY: SECRET, SOVRN_SITE_KEY: SITE_KEY, SOVRN_SITE_STATUS: undefined, VERCEL_ENV: undefined });
});
afterEach(() => restore());

const noKeys = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(SITE_KEY);
  expect(s).not.toContain(OTHER_KEY);
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain("apiKey");
};

describe("parseJsonp", () => {
  it("strips NULL(...) and named callback wrappers, and accepts plain JSON", () => {
    expect(parseJsonp('NULL({"a":1})')).toEqual({ a: 1 });
    expect(parseJsonp('  cb_1({"a":[1,2]});\n')).toEqual({ a: [1, 2] });
    expect(parseJsonp('{"a":2}')).toEqual({ a: 2 });
    expect(() => parseJsonp("NULL(not json)")).toThrow();
  });
});

describe("fetchSovrnCampaigns", () => {
  it("parses the JSONP response, sends `secret <key>` and marks this site's campaign", async () => {
    const r = await fetchSovrnCampaigns();
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.accountId).toBe(4242);
    expect(r.campaigns).toHaveLength(2);
    expect(r.campaigns[0]).toMatchObject({ campaignId: 111, name: "made4buyers.com", approvalStatus: "PENDING", applicationType: "Website", isThisSite: true, siteKeyHint: "abcdef…" });
    expect(r.campaigns[1]).toMatchObject({ campaignId: 222, isThisSite: false, siteKeyHint: "zzzzzz…" });
    expect(requests[0].authorization).toBe(`secret ${SECRET}`);
    expect(requests[0].url).toMatch(/^\/api\/account\/campaigns\/PRIMARY\?/);
    expect(requests[0].url).toContain("format=json");
    noKeys(r);
  });

  it("caches successful results for the same secret, and bypassCache refetches", async () => {
    await fetchSovrnCampaigns();
    await fetchSovrnCampaigns();
    expect(requests).toHaveLength(1);
    await fetchSovrnCampaigns({ bypassCache: true });
    expect(requests).toHaveLength(2);
  });

  it("maps 401 to AUTH_FAILED without leaking keys, and does not cache errors", async () => {
    reply = { status: 401, body: `{"error":"bad key ${SECRET}"}` };
    const r = await fetchSovrnCampaigns();
    expect(r).toMatchObject({ status: "AUTH_FAILED", httpStatus: 401 });
    noKeys(r);
    reply = { status: 200, body: body([thisSite]) };
    expect((await fetchSovrnCampaigns()).status).toBe("OK");
    expect(requests).toHaveLength(2);
  });

  it("reports PROVIDER_ERROR on 5xx and INVALID_RESPONSE on garbage", async () => {
    reply = { status: 500, body: "oops" };
    expect((await fetchSovrnCampaigns()).status).toBe("PROVIDER_ERROR");
    reply = { status: 200, body: "NULL(<html>)" };
    expect((await fetchSovrnCampaigns()).status).toBe("INVALID_RESPONSE");
    reply = { status: 200, body: 'NULL({"queryProfile":{}})' };
    expect((await fetchSovrnCampaigns()).status).toBe("INVALID_RESPONSE");
  });

  it("is UNAVAILABLE without a secret key and makes no request", async () => {
    const undo = withEnv({ SOVRN_API_KEY: undefined });
    try {
      const r = await fetchSovrnCampaigns();
      expect(r.status).toBe("UNAVAILABLE");
      expect(requests).toHaveLength(0);
    } finally {
      undo();
    }
  });

  it("uses a supplied fetchImpl", async () => {
    let seenAuth = "";
    const r = await fetchSovrnCampaigns({
      fetchImpl: async (_url, opts) => {
        seenAuth = opts?.headers?.authorization ?? "";
        return { ok: true, status: 200, finalUrl: "", chain: [], headers: {}, body: body([otherSite]) };
      },
    });
    expect(seenAuth).toBe(`secret ${SECRET}`);
    expect(r.status === "OK" && r.campaigns[0].isThisSite).toBe(false);
  });
});

describe("sovrnApprovalStatus", () => {
  it("reads the live status from the campaign that uses SOVRN_SITE_KEY", async () => {
    const undo = withEnv({ SOVRN_SITE_STATUS: "APPROVED" });
    try {
      const a = await sovrnApprovalStatus();
      expect(a).toMatchObject({ status: "PENDING", source: "sovrn-api", campaign: { campaignId: 111 } });
      noKeys(a);
    } finally {
      undo();
    }
  });

  it("normalises case and maps unknown statuses to UNKNOWN, keeping the raw value", async () => {
    reply = { status: 200, body: body([{ ...thisSite, approvalStatus: "Approved" }]) };
    expect((await sovrnApprovalStatus()).status).toBe("APPROVED");
    clearSovrnCampaignsCache();
    reply = { status: 200, body: body([{ ...thisSite, approvalStatus: "UNDER_REVIEW" }]) };
    const a = await sovrnApprovalStatus();
    expect(a).toMatchObject({ status: "UNKNOWN", source: "sovrn-api" });
    expect(a.message).toContain("UNDER_REVIEW");
  });

  it("falls back to SOVRN_SITE_STATUS when no campaign uses the site key", async () => {
    reply = { status: 200, body: body([otherSite]) };
    const undo = withEnv({ SOVRN_SITE_STATUS: "denied" });
    try {
      const a = await sovrnApprovalStatus();
      expect(a).toMatchObject({ status: "DENIED", source: "env" });
      expect(a.message).toContain("no campaign in this Sovrn account uses SOVRN_SITE_KEY");
      noKeys(a);
    } finally {
      undo();
    }
  });

  it("falls back to SOVRN_SITE_STATUS when the API fails", async () => {
    reply = { status: 401, body: "{}" };
    const a = await sovrnApprovalStatus();
    expect(a).toMatchObject({ status: "UNKNOWN", source: "env" });
    expect(a.message).toMatch(/unavailable/i);
    noKeys(a);
  });

  it("falls back without a request when SOVRN_SITE_KEY is missing", async () => {
    const undo = withEnv({ SOVRN_SITE_KEY: undefined, SOVRN_SITE_STATUS: "PENDING" });
    try {
      const a = await sovrnApprovalStatus();
      expect(a).toMatchObject({ status: "PENDING", source: "env" });
      expect(requests).toHaveLength(0);
    } finally {
      undo();
    }
  });
});
