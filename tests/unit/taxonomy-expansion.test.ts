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
    ["1Password review: the best password manager", "security-software"],
    ["NordVPN review", "security-software"],
    ["Shopify review: the best ecommerce platform", "website-ecommerce"],
    ["Hostinger web hosting review", "website-ecommerce"],
    ["HubSpot CRM review", "business-software"],
    ["ClickUp review: project management for teams", "business-software"],
    ["DaVinci Resolve review: free video editing software", "creative-software"],
    ["Mac mini M4 review", "desktops"],
    ["Purple Restore hybrid mattress review", "mattresses"],
    ["Tempur-Pedic memory foam mattress topper review", "mattresses"],
    ["Herman Miller Aeron office chair review", "furniture"],
    ["Secretlab Titan Evo gaming chair review", "furniture"],
    ["Ninja Foodi dual-zone air fryer review", "kitchen-appliances"],
    ["Breville Barista Express espresso machine review", "kitchen-appliances"],
    ["Dyson V15 Detect cordless vacuum review", "home-appliances"],
    ["Coway Airmega air purifier review", "home-appliances"],
    ["Peloton Bike+ exercise bike review", "fitness-equipment"],
    ["Dyson Supersonic hair dryer review", "personal-care"],
    ["Oral-B iO Series 10 electric toothbrush review", "personal-care"],
    ["Ooni Koda 16 pizza oven review", "outdoor-garden"],
    ["Husqvarna robotic lawn mower review", "outdoor-garden"],
    ["DeWalt 20V cordless drill review", "tools-diy"],
    ["UPPAbaby Vista V3 stroller review", "baby-kids"],
    ["Nanit Pro baby monitor review", "baby-kids"],
    ["Furbo 360 dog camera review", "pet-supplies"],
    ["Away The Bigger Carry-On suitcase review", "luggage-travel"],
  ])("classifies %s as %s", (title, expected) => {
    expect(cat(title)).toBe(expected);
  });

  it("doesn't steal reviews from existing categories", () => {
    expect(cat("Google Pixel 11 review: the best camera phone")).toBe("phones");
    expect(cat("Asus ROG Zephyrus G16 gaming laptop review with RTX 5080")).toBe("laptops");
    expect(cat("Logitech G Pro X Superlight 2 gaming mouse review")).toBe("accessories");
    expect(cat("Apple Watch Series 11 review: heart rate monitor accuracy")).toBe("wearables");
    expect(cat("Anker Prime 100W USB-C charger review")).toBe("accessories");
    expect(cat("Roborock Saros 10 robot vacuum review")).toBe("smart-home");
    expect(cat("Oura Ring 4 review: sleep tracking accuracy")).toBe("wearables");
    expect(cat("Fitbit Charge 7 fitness tracker review")).toBe("wearables");
    expect(cat("Claude review: the best AI tool for long documents")).toBe("ai-tools");
    expect(cat("Visual Studio Code review: the developer tool every coder uses")).toBe("developer-software");
  });
});

describe("cloud storage", () => {
  it("files cloud storage reviews under Security & Privacy → Cloud storage, not NAS", async () => {
    for (const title of ["pCloud Review: Is the Cloud Storage Provider Any Good?", "Sync.com Review - Free & Secure Storage", "Icedrive Review in 2026: Cloud Storage Pricing & Features"]) {
      const r = classify({ title, productName: title.split(/ review/i)[0], summary: "", body: `${title}. We test the cloud storage service's pricing, sync speed and security.` });
      expect(r.category?.slug, title).toBe("security-software");
      expect(r.subcategory?.slug, title).toBe("cloud-storage");
    }
    const nas = classify({ title: "Synology DS224+ NAS review", productName: "Synology DS224+", summary: "", body: "A two-bay NAS for home backups and a personal cloud." });
    expect(nas.category?.slug).not.toBe("security-software");
  });
});
