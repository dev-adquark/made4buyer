import { describe, expect, it } from "vitest";
import { classify } from "@/lib/taxonomy/classify";
import { CATEGORIES, DEPARTMENTS } from "@/lib/taxonomy/definitions";
import { THEMES } from "@/lib/taxonomy/themes";

const cat = (title: string, productName = title.replace(/ review.*$/i, "")) => classify({ title, productName, summary: "", body: "" }).category?.slug;

describe("expanded taxonomy", () => {
  it("keeps every existing category, slug and subcategory URL", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(slugs.slice(0, 9)).toEqual(["laptops", "phones", "tablets", "ai-tools", "developer-software", "accessories", "audio", "wearables", "networking"]);
    const acc = CATEGORIES.find((c) => c.slug === "accessories")!;
    for (const s of ["monitors", "keyboards", "mice", "docks-hubs", "chargers-power", "webcams", "cases-protection", "storage-drives"]) expect(acc.subcategories.some((x) => x.slug === s)).toBe(true);
    expect(acc.subcategories.find((x) => x.slug === "monitors")?.legacy).toBe(true);
    expect(CATEGORIES.find((c) => c.slug === "tablets")!.subcategories.some((s) => s.slug === "e-readers")).toBe(true);
  });

  it("has unique slugs and complete metadata for every category", () => {
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(new Set(c.subcategories.map((s) => s.slug)).size, c.slug).toBe(c.subcategories.length);
      expect(DEPARTMENTS.some((d) => d.slug === c.department), c.slug).toBe(true);
      expect(THEMES[c.slug], c.slug).toBeTruthy();
      expect(c.software || c.priceBands, c.slug).toBeTruthy();
    }
    for (const d of DEPARTMENTS) expect(CATEGORIES.some((c) => c.department === d.slug), d.slug).toBe(true);
  });

  it.each([
    ["Dell UltraSharp U2725QE review", "monitors"],
    ["Samsung Odyssey OLED G6 gaming monitor review", "monitors"],
    ["Samsung 990 Pro SSD review", "accessories"],
    ["Sony A7 V review: the best full-frame mirrorless camera", "cameras"],
    ["PS5 Pro review", "gaming"],
    ["Steam Deck OLED review", "gaming"],
    ["Roku Ultra review", "streaming-devices"],
    ["DJI Mini 5 Pro review", "drones-gadgets"],
    ["Garmin Dash Cam X210 review", "automotive-tech"],
    ["Brother HL-L2460DW laser printer review", "printers"],
    ["LG C5 OLED TV review", "tv-home-entertainment"],
    ["Philips Hue Bridge Pro review: smart lighting", "smart-home"],
    ["Nvidia GeForce RTX 5070 Ti graphics card review", "pc-components"],
    ["Microsoft 365 review", "productivity-software"],
    ["1Password review: the best password manager", "productivity-software"],
    ["Mac mini M4 review", "desktops"],
  ])("classifies %s as %s", (title, expected) => {
    expect(cat(title)).toBe(expected);
  });

  it("doesn't steal reviews from existing categories", () => {
    expect(cat("Google Pixel 11 review: the best camera phone")).toBe("phones");
    expect(cat("Asus ROG Zephyrus G16 gaming laptop review with RTX 5080")).toBe("laptops");
    expect(cat("Logitech G Pro X Superlight 2 gaming mouse review")).toBe("accessories");
    expect(cat("Apple Watch Series 11 review: heart rate monitor accuracy")).toBe("wearables");
    expect(cat("Anker Prime 100W USB-C charger review")).toBe("accessories");
  });
});
