import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { publicLogo } from "@/lib/commerce/brand-logo-public";
import { logoDueWhere, overrideBrandLogo, runBrandLogos } from "@/lib/commerce/brand-logos";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/** Official brand logos job (lib/commerce/brand-logos.ts) against a local stub site + Wikidata/Commons stubs. SAMPLE data. */

const DAY = 86_400_000;
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><path fill="#123456" d="M0 0h120v40H0z"/></svg>`;
type Site = { status: number; html: string };
let site: Site;
let wikidata: { search: string[]; entities: Record<string, unknown>; up: boolean };
let server: http.Server;
let base = "";
let host = "";
let restore: () => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (status: number, type: string, body: string) => void (res.writeHead(status, { "Content-Type": type }), res.end(body));
    if (url.pathname === "/robots.txt") return send(200, "text/plain", "User-agent: *\nAllow: /\n");
    if (url.pathname === "/") return send(site.status, "text/html", site.html);
    if (url.pathname === "/logo.svg" || url.pathname === "/commons-file/Acme_logo.svg") return send(200, "image/svg+xml", LOGO_SVG);
    if (url.pathname === "/evil.svg") return send(200, "image/svg+xml", `<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>`);
    if (url.pathname === "/wikidata/api.php") {
      if (!wikidata.up) return send(503, "text/plain", "down");
      if (url.searchParams.get("action") === "wbsearchentities") return send(200, "application/json", JSON.stringify({ search: wikidata.search.map((id) => ({ id })) }));
      return send(200, "application/json", JSON.stringify({ entities: wikidata.entities }));
    }
    if (url.pathname === "/commons/api.php") {
      return send(200, "application/json", JSON.stringify({ query: { pages: { "1": { imageinfo: [{ url: `${base}/commons-file/Acme_logo.svg`, mime: "image/svg+xml", width: 120, height: 40, size: LOGO_SVG.length, descriptionurl: "https://commons.wikimedia.org/wiki/File:Acme_logo.svg", extmetadata: { LicenseShortName: { value: "Public domain" }, Categories: { value: "Logos of companies" } } }] } } } }));
    }
    return send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host = base.replace("http://", "");
  restore = withEnv({ WIKIDATA_ENABLED: "true", COMMONS_SEARCH_ENABLED: "true", WIKIDATA_API_URL: `${base}/wikidata/api.php`, COMMONS_API_URL: `${base}/commons/api.php`, BRAND_LOGOS_PACE_MS: "0", BRAND_LOGOS_PER_RUN: undefined });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  await resetDb();
  site = { status: 200, html: "<html><head><title>Acme</title></head></html>" };
  wikidata = { search: [], entities: {}, up: true };
});

const jsonLdPage = (logo: string, name = "Acme") => `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name, url: `${base}/`, logo })}</script></head></html>`;
const brand = (data: Record<string, unknown> = {}) => db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: host, categories: [], ...data } });
const events = (id: string) => db.commerceVerificationEvent.findMany({ where: { entityType: "brand", entityId: id, kind: "LOGO" }, orderBy: { checkedAt: "asc" } });

describe("brand-logos job", () => {
  it("stores an official JSON-LD logo with provenance, writes a LOGO event and audits the change", async () => {
    site.html = jsonLdPage("/logo.svg");
    const b = await brand();
    const r = await runBrandLogos("test", { paceMs: 0 });
    expect(r).toMatchObject({ status: "OK", checked: 1, verified: 1, changed: 1 });
    const row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ logoStatus: "VERIFIED", logoUrl: `${base}/logo.svg`, logoSource: "official-jsonld", logoSourceUrl: `${base}/`, logoWidth: 120, logoHeight: 40, logoMime: "image/svg+xml", logoLicense: null, logoLocked: false });
    expect(row.logoVerifiedAt).toBeTruthy();
    expect(publicLogo(row)).toMatchObject({ src: `${base}/logo.svg`, width: 120, height: 40 });
    expect((await events(b.id)).map((e) => e.result)).toEqual(["VERIFIED"]);
    expect(await db.auditLog.count({ where: { action: "BRAND_LOGO_UPDATED", entityId: b.id } })).toBe(1);
    // Idempotent: not due again for 30 days.
    expect(await runBrandLogos("test", { paceMs: 0 })).toMatchObject({ checked: 0 });
  });

  it("falls back to the Wikidata item with the brand's domain and name, with the Commons licence", async () => {
    wikidata.search = ["Q1", "Q2"];
    wikidata.entities = {
      Q1: { id: "Q1", labels: { en: { value: "Acme Inc." } }, claims: { P856: [{ mainsnak: { datavalue: { value: `${base}/` } } }], P154: [{ mainsnak: { datavalue: { value: "Acme_logo.svg" } } }] } },
      Q2: { id: "Q2", labels: { en: { value: "Acme Parent Widgets" } }, claims: { P856: [{ mainsnak: { datavalue: { value: `${base}/` } } }], P154: [{ mainsnak: { datavalue: { value: "Other.svg" } } }] } },
    };
    const b = await brand();
    await runBrandLogos("test", { paceMs: 0 });
    const row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ logoStatus: "VERIFIED", logoSource: "wikidata-commons", logoSourceUrl: "https://www.wikidata.org/wiki/Q1", logoLicense: "Public domain", logoUrl: `${base}/commons-file/Acme_logo.svg` });
  });

  it("NOT_FOUND and REJECTED keep the monogram (no logo stored), with the reason", async () => {
    const b = await brand();
    await runBrandLogos("test", { paceMs: 0 });
    let row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.logoStatus).toBe("NOT_FOUND");
    expect(row.logoUrl).toBeNull();
    expect(publicLogo(row)).toBeNull();

    site.html = jsonLdPage("/evil.svg");
    await db.commerceBrand.update({ where: { id: b.id }, data: { logoCheckedAt: new Date(Date.now() - 31 * DAY) } });
    await runBrandLogos("test", { paceMs: 0 });
    row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.logoStatus).toBe("REJECTED");
    expect(row.logoReason).toMatch(/script/);
    expect(publicLogo(row)).toBeNull();
    expect((await events(b.id)).map((e) => e.result)).toEqual(["NOT_FOUND", "REJECTED"]);
  });

  it("FAILED keeps a previously verified logo; with none it stores FAILED and retries after a day", async () => {
    site.status = 500;
    wikidata.up = false;
    const kept = await brand({ logoStatus: "VERIFIED", logoUrl: `${base}/logo.svg`, logoWidth: 120, logoHeight: 40, logoMime: "image/svg+xml", logoSource: "official-jsonld", logoVerifiedAt: new Date(Date.now() - 40 * DAY), logoCheckedAt: new Date(Date.now() - 31 * DAY) });
    const none = await brand({ name: "Bolt", slug: "bolt" });
    const r = await runBrandLogos("test", { paceMs: 0 });
    expect(r.failed).toBe(2);
    const k = await db.commerceBrand.findUniqueOrThrow({ where: { id: kept.id } });
    expect(k).toMatchObject({ logoStatus: "VERIFIED", logoUrl: `${base}/logo.svg` });
    expect(k.logoReason).toMatch(/Re-check failed/);
    const n = await db.commerceBrand.findUniqueOrThrow({ where: { id: none.id } });
    expect(n).toMatchObject({ logoStatus: "FAILED", logoUrl: null });
    const now = new Date();
    const due = async () => (await db.commerceBrand.findMany({ where: logoDueWhere(now), select: { slug: true } })).map((x) => x.slug);
    expect(await due()).toEqual([]);
    await db.commerceBrand.update({ where: { id: none.id }, data: { logoCheckedAt: new Date(now.getTime() - 25 * 3_600_000) } });
    expect(await due()).toEqual(["bolt"]);
    await db.commerceBrand.update({ where: { id: kept.id }, data: { logoCheckedAt: new Date(now.getTime() - 31 * DAY) } });
    expect((await due()).sort()).toEqual(["acme", "bolt"]);
  });

  it("never overwrites an admin-locked logo; the override itself is validated", async () => {
    site.html = jsonLdPage("/logo.svg");
    const b = await brand();
    expect(await overrideBrandLogo(b.id, "https://cdn.example.net/acme.svg")).toMatchObject({ ok: false });
    expect(await overrideBrandLogo(b.id, `${base}/evil.svg`)).toMatchObject({ ok: false, error: expect.stringMatching(/script/) });
    expect(await overrideBrandLogo(b.id, `${base}/logo.svg`)).toMatchObject({ ok: true });
    let row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ logoLocked: true, logoSource: "admin-url", logoStatus: "VERIFIED" });
    await db.commerceBrand.update({ where: { id: b.id }, data: { logoCheckedAt: new Date(Date.now() - 60 * DAY) } });
    site.html = "<html></html>";
    expect(await runBrandLogos("test", { paceMs: 0 })).toMatchObject({ checked: 0 });
    row = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ logoLocked: true, logoSource: "admin-url", logoStatus: "VERIFIED" });
  });

  it("is paused by the commerce_engine switch", async () => {
    await db.automationSetting.create({ data: { key: "commerce_engine", value: "off" } });
    await brand();
    expect(await runBrandLogos("test", { paceMs: 0 })).toMatchObject({ status: "PAUSED", checked: 0 });
  });
});
