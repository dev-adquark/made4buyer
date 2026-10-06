import { describe, expect, it } from "vitest";
import { fileTitleMatches } from "@/lib/images/commons-search";
import { productTypeTopic } from "@/lib/images/product-type";
import { photoMatchesTopic } from "@/lib/pipeline/image-topics";

const type = (productName: string, title = "", categorySlug: string | null = null) => productTypeTopic({ productName, title, categorySlug })?.key ?? null;

describe("product type from the product's own name (never the category)", () => {
  it("reads the real audit cases correctly, whatever category they were filed under", () => {
    expect(type("16 oz All Around Tumbler", "Hydro Flask 16 oz All Around Tumbler Review", "luggage-travel")).toBe("product-type:tumbler");
    expect(type("imini 2", "Olight imini 2 Review", "luggage-travel")).toBe("product-type:flashlight");
    expect(type("City Crescent 6L", "Peak Design City Crescent 6L Review", "luggage-travel")).toBe("product-type:sling");
    expect(type("Packing Cubes", "Westbreeze Packing Cubes Review")).toBe("product-type:packing-cubes");
    expect(type("MagSafe Car Mount", "Ugreen MagSafe Car Mount Review", "automotive-tech")).toBe("product-type:car-mount");
    expect(type("Galaxy Watch 9")).toBe("product-type:smartwatch");
    expect(type("Galaxy Z Fold 8")).toBe("product-type:foldable-phone");
    expect(type("Pixel 11 Pro")).toBe("product-type:smartphone");
    expect(type("Sports Duffel Max")).toBe("product-type:duffel");
    expect(type("Airmega ProX")).toBe("product-type:air-purifier");
    expect(type("Beam Ultra", "Sonos Beam Ultra Review")).toBe("product-type:soundbar");
    expect(type("Adept Roll-Top Backpack")).toBe("product-type:backpack");
  });

  it("software uses its subject topic; an unreadable type gives no topic (neutral image)", () => {
    expect(type("NordVPN", "NordVPN Review", "security-software")).toBe("product-type:vpn");
    expect(type("Zx-9", "Zx-9 review", "luggage-travel")).toBeNull();
  });

  it("a photo qualifies only when its own description names the product type", () => {
    const tumbler = productTypeTopic({ productName: "16 oz All Around Tumbler" })!;
    expect(photoMatchesTopic("Stainless steel tumbler on a desk", tumbler)).toBe(true);
    expect(photoMatchesTopic("Street market with bags and luggage", tumbler)).toBe(false);
    const flashlight = productTypeTopic({ productName: "imini 2", title: "Olight imini 2 flashlight" })!;
    expect(photoMatchesTopic("Man packing clothes into a suitcase", flashlight)).toBe(false);
  });
});

describe("Commons file title must name the exact product", () => {
  it("accepts the exact model and rejects other versions and brands", () => {
    expect(fileTitleMatches("File:Google Pixel 9 Pro Fold - front.jpg", "Pixel 9 Pro Fold", "Google")).toBe(true);
    expect(fileTitleMatches("File:Google Pixel 8 Pro Fold.jpg", "Pixel 9 Pro Fold", "Google")).toBe(false);
    expect(fileTitleMatches("File:Google Pixel 9.jpg", "Pixel 9 Pro Fold", "Google")).toBe(false);
    expect(fileTitleMatches("File:Pixel 9 Pro Fold.jpg", "Pixel 9 Pro Fold", "Google")).toBe(false);
    expect(fileTitleMatches("File:Hydro_Flask_bottle.jpg", "16 oz All Around Tumbler", "Hydro Flask")).toBe(false);
    expect(fileTitleMatches("File:Breville Barista Express.jpg", "Barista Express", null)).toBe(false);
  });
});

describe("regressions from the live audit", () => {
  it("rejects the drone-for-flashlight and living-room-for-purifier photos; guides read their type from the title", () => {
    const flashlight = productTypeTopic({ productName: "imini 2", title: "Olight imini 2 Review" })!;
    expect(photoMatchesTopic("Compact white drone on camouflage gear with light", flashlight)).toBe(false);
    expect(photoMatchesTopic("Small LED flashlight in hand", flashlight)).toBe(true);
    const purifier = productTypeTopic({ productName: "Airmega ProX" })!;
    expect(photoMatchesTopic("Interior of modern living room with fresh air", purifier)).toBe(false);
    expect(type("6 Best Panasonic Electric Shavers for Every Budget", "6 Best Panasonic Electric Shavers for Every Budget", "personal-care")).toBe("product-type:shaver");
    expect(type("Coffee & espresso machines", "Selecting the Right Coffee or Espresso Machine for Your Needs", "kitchen-appliances")).toBe("product-type:espresso");
    expect(type("9 Best Carry-On Luggage to Upgrade Your Airport Aesthetic")).toBe("product-type:suitcase");
  });
});

describe("stored stock photos are re-checked before being kept", () => {
  it("a photo that fails today's rule is no longer worth keeping", async () => {
    const { stockPhotoStillRelevant } = await import("@/lib/pipeline/images");
    const olight = { productName: "imini 2", title: "Olight imini 2 Review", categorySlug: "luggage-travel", singleProduct: true };
    expect(stockPhotoStillRelevant("Compact white drone on camouflage gear, surrounded by flashlights", olight)).toBe(false);
    expect(stockPhotoStillRelevant("Small flashlight held in hand", olight)).toBe(true);
    const shavers = { productName: "6 Best Panasonic Electric Shavers for Every Budget", title: "6 Best Panasonic Electric Shavers for Every Budget", categorySlug: "personal-care", singleProduct: false };
    expect(stockPhotoStillRelevant("A collection of skincare products arranged stylishly", shavers)).toBe(false);
    expect(stockPhotoStillRelevant("Electric shaver on a bathroom shelf", shavers)).toBe(true);
    expect(stockPhotoStillRelevant(null, shavers)).toBe(false);
  });
});
