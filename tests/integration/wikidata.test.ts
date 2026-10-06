import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { enrichProduct, type FactSummary } from "@/lib/products/enrich";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
const body = "The Breville Barista Express is a semi-automatic espresso machine with a built-in conical burr grinder. We pulled shots daily for two weeks to test temperature stability and steam power.";
const item = (id: string, label: string, brandId = "Q2", extra: Record<string, unknown[]> = {}) => ({
  labels: { en: { value: label } },
  claims: {
    P31: [{ mainsnak: { datavalue: { value: { id: "Q100" } } } }],
    P176: [{ mainsnak: { datavalue: { value: { id: brandId } } } }],
    P577: [{ mainsnak: { datavalue: { value: { time: "+2012-09-01T00:00:00Z", precision: 10 } } } }],
    P18: [{ mainsnak: { datavalue: { value: "Barista Express.jpg" } } }],
    ...extra,
  },
  id,
});

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ WIKIDATA_ENABLED: "true", WIKIDATA_API_URL: `${stub.base}/wikidata/api.php`, COMMONS_API_URL: `${stub.base}/commons/api.php`, CONTENT_API_URL: undefined, SOVRN_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  stub.wikidata.search = [];
  stub.wikidata.entities = { Q2: { labels: { en: { value: "Breville" } }, claims: {} }, Q3: { labels: { en: { value: "Sage" } }, claims: {} }, Q100: { labels: { en: { value: "espresso machine" } }, claims: {} } };
  stub.wikidata.commons = {};
});

async function product() {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "bes870", title: "Breville Barista Express review", body, summary: "A capable all-in-one espresso machine.", url: "https://reviews.example.test/reviews/barista-express", productName: "Breville Barista Express", brand: "Breville", category: "Coffee machines", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
  const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "bes870" }, include: { contentEntities: true } });
  return r.contentEntities.find((c) => c.role === "PRIMARY")!.productEntityId;
}

describe("Wikidata / Commons free fallback", () => {
  it("adds stable facts and a licensed photo for the exact item, never prices", async () => {
    stub.wikidata.search = ["Q10"];
    stub.wikidata.entities.Q10 = item("Q10", "Breville Barista Express");
    stub.wikidata.commons["Barista Express.jpg"] = { url: `${stub.base}/img/be.jpg`, descriptionurl: "https://commons.wikimedia.org/wiki/File:Barista_Express.jpg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href='x'>Jane Doe</a>" } } };
    const entityId = await product();
    const r = await enrichProduct(entityId);
    expect(r.outcomes.some((o) => o.startsWith("WIKIDATA_MATCHED Q10"))).toBe(true);
    const facts = await db.productFact.findMany({ where: { productEntityId: entityId, source: "WIKIDATA" } });
    expect(facts.map((x) => x.field).sort()).toEqual(["image", "manufacturer", "releaseDate"]);
    expect(facts.find((x) => x.field === "releaseDate")?.value).toBe("2012-09"); // month precision, never invented day
    expect(facts.find((x) => x.field === "image")).toMatchObject({ unit: "CC BY-SA 4.0", sourceName: "Jane Doe / Wikimedia Commons" });
    expect(facts.some((x) => ["price", "availability", "listPrice"].includes(x.field))).toBe(false);
    const s = (await db.productEntity.findUniqueOrThrow({ where: { id: entityId } })).factSummary as unknown as FactSummary;
    expect(s.quality?.parts.image).toBe(10);
    expect(s.identityBasis).toBeTruthy();
    expect(s.nextRefreshAt).toBeTruthy();
  });

  it("rejects a different variant, a different brand, an ambiguous result and an unlicensed photo", async () => {
    stub.wikidata.search = ["Q11", "Q12"];
    stub.wikidata.entities.Q11 = item("Q11", "Breville Barista Pro");
    stub.wikidata.entities.Q12 = item("Q12", "Barista Express", "Q3");
    const entityId = await product();
    expect((await enrichProduct(entityId)).outcomes).toContain("WIKIDATA_NO_EXACT_MATCH");
    expect(await db.productFact.count({ where: { productEntityId: entityId, source: "WIKIDATA" } })).toBe(0);

    await db.productEntity.update({ where: { id: entityId }, data: { factSummary: undefined, enrichedAt: null } });
    await db.productEntity.update({ where: { id: entityId }, data: { factSummary: {} } });
    stub.wikidata.search = ["Q13", "Q14"];
    stub.wikidata.entities.Q13 = item("Q13", "Breville Barista Express");
    stub.wikidata.entities.Q14 = item("Q14", "Breville Barista Express");
    expect((await enrichProduct(entityId)).outcomes).toContain("WIKIDATA_AMBIGUOUS");

    await db.productEntity.update({ where: { id: entityId }, data: { factSummary: {} } });
    stub.wikidata.search = ["Q13"];
    stub.wikidata.commons["Barista Express.jpg"] = { url: `${stub.base}/img/be.jpg`, descriptionurl: "https://commons.wikimedia.org/wiki/File:x", extmetadata: { LicenseShortName: { value: "Fair use" } } };
    await enrichProduct(entityId);
    expect(await db.productFact.count({ where: { productEntityId: entityId, field: "image" } })).toBe(0);
    expect(await db.productFact.count({ where: { productEntityId: entityId, source: "WIKIDATA", field: "manufacturer" } })).toBe(1);
  });
});
