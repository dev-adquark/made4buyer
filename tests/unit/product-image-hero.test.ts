import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inferImageType } from "@/lib/images/provenance";
import { enrichImage } from "@/lib/pipeline/images";
import { imageRank } from "@/lib/pipeline/stages";
import { checkImageFact, commonsFilePage, isCommonsFileUrl, isFreeLicence, matchBasisConfidence, type CommonsImage, type ImageFactRow } from "@/lib/products/commons-image";
import { startStubServer } from "../../scripts/support/stub-server";
import { withEnv } from "../support/env";

// SAMPLE data only: a local stub serves the Pexels API and image files; never the real APIs.
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
let local: (() => void) | undefined;
beforeAll(async () => {
  stub = await startStubServer({});
  restore = withEnv({
    PEXELS_API_KEY: "test-pexels-key",
    PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`,
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    IMAGE_ENRICHMENT_URL: undefined,
    IMAGE_REQUIRE_LICENSE: "true",
    CONTENT_API_IMAGES_LICENSED: undefined,
  });
});
afterAll(async () => {
  restore();
  await stub.close();
});
afterEach(() => {
  local?.();
  local = undefined;
});

const COMMONS = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Hydro_Flask_tumbler.jpg";
const fact = (over: Partial<ImageFactRow> = {}): ImageFactRow => ({
  field: "image",
  value: COMMONS,
  unit: "CC BY-SA 4.0",
  source: "WIKIDATA",
  sourceName: "Jane Doe",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Hydro_Flask_tumbler.jpg",
  observedAt: new Date("2026-10-01T00:00:00Z"),
  matchBasis: "gtin",
  ...over,
});
const pexelsCalls = () => stub.requests.filter((r) => r.path.startsWith("/pexels/")).length;

describe("Commons image facts", () => {
  it("accepts a licensed Commons file matched by identifier or exact brand+name", () => {
    const ok = checkImageFact(fact());
    expect(ok).toMatchObject({ ok: true, image: { url: COMMONS, license: "CC BY-SA 4.0", attribution: "Jane Doe / Wikimedia Commons, CC BY-SA 4.0", filePageUrl: "https://commons.wikimedia.org/wiki/File:Hydro_Flask_tumbler.jpg", matchConfidence: 1 } });
    expect(checkImageFact(fact({ matchBasis: "brand+name" }))).toMatchObject({ ok: true, image: { matchConfidence: 0.9 } });
    expect(checkImageFact(fact({ matchBasis: "wikidata-id" })).ok).toBe(true);
    // HTML author markup is reduced to text; a missing file page is derived from the file URL.
    expect(checkImageFact(fact({ sourceName: '<a href="//x">J. Doe</a>', sourceUrl: null }))).toMatchObject({ ok: true, image: { attribution: "J. Doe / Wikimedia Commons, CC BY-SA 4.0", filePageUrl: "https://commons.wikimedia.org/wiki/File:Hydro_Flask_tumbler.jpg" } });
  });

  it("rejects unlicensed, non-free, off-Commons, SVG and loosely matched image facts", () => {
    const reasons = [
      fact({ unit: null }),
      fact({ unit: "" }),
      fact({ unit: "CC BY-NC 4.0" }),
      fact({ unit: "All rights reserved" }),
      fact({ value: "https://www.hydroflask.com/media/tumbler.jpg" }),
      fact({ value: "http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg" }),
      fact({ value: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.svg" }),
      fact({ matchBasis: "name" }),
      fact({ matchBasis: "fuzzy" }),
      fact({ matchBasis: "" }),
      fact({ source: "RETAILER" }),
      fact({ value: 42 }),
    ].map((f) => checkImageFact(f));
    for (const r of reasons) expect(r.ok).toBe(false);
    expect(reasons[0]).toMatchObject({ reason: "image fact has no licence" });
  });

  it("helpers: licence, host, identity basis, file page", () => {
    expect(isFreeLicence("CC0")).toBe(true);
    expect(isFreeLicence("Public domain")).toBe(true);
    expect(isFreeLicence("CC BY-ND 2.0")).toBe(false);
    expect(isFreeLicence(undefined)).toBe(false);
    expect(isCommonsFileUrl(COMMONS)).toBe(true);
    expect(isCommonsFileUrl("https://upload.wikimedia.org/wikipedia/en/a/ab/Fair_use.jpg")).toBe(false);
    expect(matchBasisConfidence("GTIN:00012345")).toBe(1);
    expect(matchBasisConfidence("brand")).toBeNull();
    expect(commonsFilePage("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Name.jpg/1200px-Name.jpg")).toBe("https://commons.wikimedia.org/wiki/File:Name.jpg");
  });
});

describe("hero image for a single-product review", () => {
  const commons = (url: string): CommonsImage => ({ url, license: "CC BY 4.0", attribution: "Jane Doe / Wikimedia Commons, CC BY 4.0", filePageUrl: "https://commons.wikimedia.org/wiki/File:Olight.jpg", matchBasis: "mpn", matchConfidence: 1, productEntityId: "p1", productName: "Olight Warrior 3S", observedAt: new Date() });

  it("uses the licensed exact-product photo, with provenance and attribution", async () => {
    const d = await enrichImage({ productName: "Olight Warrior 3S", brand: "Olight", categorySlug: "tools-diy", kind: "REVIEW", productImages: [commons(`${stub.base}/image/olight.png`)] });
    expect(d).toMatchObject({
      sourceType: "WIKIMEDIA_COMMONS",
      licenseState: "VERIFIED",
      license: "CC BY 4.0",
      attribution: "Jane Doe / Wikimedia Commons, CC BY 4.0",
      attributionUrl: "https://commons.wikimedia.org/wiki/File:Olight.jpg",
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Olight.jpg",
      subject: "PRODUCT",
      imageType: "commons-product",
      matchConfidence: 1,
      isFallback: false,
    });
  });

  it("never uses a product-matched stock photo: with no readable type, the category's representative photo", async () => {
    // "Sony WH-1000XM6" is a product the Pexels stub has a matching "product" photo for: never used.
    const d = await enrichImage({ productName: "WH-1000XM6", brand: "Sony", title: "Sony WH-1000XM6 review", categorySlug: "audio", kind: "REVIEW" });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", isFallback: false, searchQuery: "headphones close up", matchBasis: "pexels:category" });
    expect(d.altText).not.toMatch(/sony/i);
    // Same when the kind is unknown: the safe default is single-product.
    expect(await enrichImage({ productName: "WH-1000XM6", brand: "Sony", categorySlug: "audio" })).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-category" });
  });

  it("only when no photo provider can answer at all: the neutral category image, without calling Pexels", async () => {
    local = withEnv({ PEXELS_API_KEY: undefined });
    const before = pexelsCalls();
    const d = await enrichImage({ productName: "WH-1000XM6", brand: "Sony", title: "Sony WH-1000XM6 review", categorySlug: "audio", kind: "REVIEW" });
    expect(d).toMatchObject({ sourceType: "PLACEHOLDER", sourceUrl: "/placeholders/audio.svg", imageType: "neutral-category", isFallback: true, licenseState: "OWNED_PLACEHOLDER" });
    expect(pexelsCalls()).toBe(before);
  });

  it("when the Commons file does not load: reported, and the next relevant photo is used (never a placeholder)", async () => {
    const d = await enrichImage({ productName: "Olight Warrior 3S", categorySlug: "tools-diy", kind: "REVIEW", productImages: [commons(`${stub.base}/pexels-img/broken.jpeg`)] });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", isFallback: false });
    expect(d.issues[0].message).toMatch(/Commons product image unusable/);
  });

  it("ignores an unlicensed or off-Commons candidate even if a caller passes one", async () => {
    const bad = { ...commons("https://www.olight.com/img/warrior.jpg") };
    const unlicensed = { ...commons(`${stub.base}/image/olight.png`), license: "" };
    const d = await enrichImage({ productName: "Olight Warrior 3S", categorySlug: "tools-diy", kind: "REVIEW", productImages: [bad, unlicensed] });
    expect(d.sourceType).not.toBe("WIKIMEDIA_COMMONS");
    expect(d).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-category" });
  });

  it("keeps the source's explicitly licensed image as the product image when there is no Commons photo", async () => {
    const d = await enrichImage({ productName: "Pixel 10", categorySlug: "phones", kind: "REVIEW", imageUrl: `${stub.base}/image/src.png`, imageLicense: "Licensed", imageLicenseVerified: true });
    expect(d).toMatchObject({ sourceType: "CONTENT_API", subject: "PRODUCT", imageType: "source-product", licenseState: "VERIFIED" });
  });
});

describe("illustrative photos for category-level content", () => {
  it("allows a labelled, on-topic Pexels photo for a buying guide", async () => {
    const d = await enrichImage({ productName: "VPNs", title: "Best VPNs for 2026", categorySlug: "security-software", kind: "BUYING_GUIDE" });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", licenseState: "VERIFIED", isFallback: false });
    expect(d.attribution).toMatch(/on Pexels$/);
  });

  it("never labels a guide's stock photo as a product, even when Pexels has a product match", async () => {
    const d = await enrichImage({ productName: "WH-1000XM6", brand: "Sony", title: "Best noise cancelling headphones", categorySlug: "audio", kind: "AI_GUIDE", singleProduct: false });
    if (d.sourceType === "ENRICHMENT_SERVICE") expect(d).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-category" });
    else expect(d).toMatchObject({ sourceType: "PLACEHOLDER", imageType: "neutral-category" });
  });

  it("a guide about one product (PRIMARY link) follows the single-product rule: never a product-matched stock photo", async () => {
    const d = await enrichImage({ productName: "NordVPN", title: "NordVPN guide", categorySlug: "security-software", kind: "AI_GUIDE", singleProduct: true });
    expect(d.subject).not.toBe("PRODUCT");
    if (d.sourceType === "ENRICHMENT_SERVICE") expect(d).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-product-type" });
    else expect(d).toMatchObject({ sourceType: "PLACEHOLDER", imageType: "neutral-category" });
  });

  it("single-product pages without a readable product type get the category's photo (its description names the category topic)", async () => {
    const d = await enrichImage({ productName: "Zx-9", title: "Zx-9 review", categorySlug: "luggage-travel", kind: "REVIEW" });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", searchQuery: "suitcase travel" });
  });
});

describe("image rank and provenance", () => {
  const pexels = { isFallback: false, licenseState: "VERIFIED", sourceType: "ENRICHMENT_SERVICE" };
  it("a stock photo is worthless on a single-product page and as a 'product' photo anywhere", () => {
    // A category photo on a single-product page beats only the placeholder; a product-type photo beats it.
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: "illustrative-category" }, { singleProduct: true })).toBe(0.5);
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: "illustrative-product-type" }, { singleProduct: true })).toBe(1);
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: null }, { singleProduct: true })).toBe(0);
    expect(imageRank({ ...pexels, subject: "PRODUCT", imageType: null }, { singleProduct: false })).toBe(0);
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: "illustrative-category" }, { singleProduct: false })).toBe(1);
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: "illustrative-category" })).toBe(1);
  });

  it("a legacy stock photo (no provenance) is re-checked when the page context is unknown", () => {
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: null })).toBe(0);
    expect(imageRank({ ...pexels, subject: "ILLUSTRATIVE", imageType: null }, { singleProduct: false })).toBe(1);
  });

  it("an exact-product Commons photo outranks everything; placeholders rank 0", () => {
    expect(imageRank({ isFallback: false, licenseState: "VERIFIED", sourceType: "WIKIMEDIA_COMMONS", subject: "PRODUCT", imageType: "commons-product" }, { singleProduct: true })).toBe(3);
    expect(imageRank({ isFallback: false, licenseState: "VERIFIED", sourceType: "CONTENT_API", subject: "PRODUCT" })).toBe(2);
    expect(imageRank({ isFallback: true, sourceType: "PLACEHOLDER" })).toBe(0);
    // The brand's own photo > an identity-matched retailer's > Commons.
    expect(imageRank({ isFallback: false, licenseState: "PROVIDER_ASSERTED", sourceType: "OFFICIAL_SITE", subject: "PRODUCT", imageType: "official-product" }, { singleProduct: true })).toBe(3.2);
    expect(imageRank({ isFallback: false, licenseState: "PROVIDER_ASSERTED", sourceType: "RETAILER_SITE", subject: "PRODUCT", imageType: "retailer-product" }, { singleProduct: true })).toBe(3.1);
  });

  it("infers provenance for rows stored before it existed", () => {
    expect(inferImageType({ sourceType: "PLACEHOLDER" })).toBe("neutral-category");
    expect(inferImageType({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE" })).toBe("illustrative-category");
    expect(inferImageType({ sourceType: "ENRICHMENT_SERVICE", subject: "PRODUCT" })).toBeNull();
    expect(inferImageType({ sourceType: "CONTENT_API", subject: "PRODUCT" })).toBe("source-product");
    expect(inferImageType({ sourceType: "OFFICIAL_SITE" })).toBe("official-product");
    expect(inferImageType({ sourceType: "RETAILER_SITE" })).toBe("retailer-product");
  });
});
