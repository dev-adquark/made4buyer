/**
 * Buyer-focused taxonomy. This file is the single source of truth: it is seeded into
 * category_tags (see lib/taxonomy/seed.ts) and drives the deterministic classifier.
 * Signals are keyword/phrase patterns with weights; they are data, not product lists.
 */

export type Signal = [pattern: string, weight: number];

export type SubcategoryDef = { slug: string; name: string; signals: Signal[] };

export type CategoryDef = {
  slug: string;
  name: string;
  description: string;
  /** Source-field values (Content API category/tags) that map directly to this category. */
  aliases: string[];
  signals: Signal[];
  /** Signals that indicate a product is an accessory *for* this category, not the category itself. */
  negativeSignals?: Signal[];
  subcategories: SubcategoryDef[];
  /** Price-tier boundaries in USD: [budgetMax, midRangeMax]. Omitted for software. */
  priceBands?: [number, number];
  software?: boolean;
  deviceType: string;
};

export const CATEGORIES: CategoryDef[] = [
  {
    slug: "laptops",
    name: "Laptops",
    description: "Laptops, ultrabooks, Chromebooks and mobile workstations.",
    aliases: ["laptop", "laptops", "notebooks", "computers", "notebook computers"],
    deviceType: "laptop",
    priceBands: [700, 1500],
    signals: [["laptop", 3], ["notebook", 2], ["macbook", 4], ["chromebook", 4], ["ultrabook", 4], ["thinkpad", 4], ["zenbook", 4], ["vivobook", 4], ["xps", 3], ["spectre", 3], ["envy x360", 3], ["surface laptop", 4], ["yoga slim", 4], ["rog zephyrus", 4], ["legion", 2], ["alienware m", 3], ["2-in-1", 2], ["mobile workstation", 4]],
    negativeSignals: [["laptop stand", 5], ["laptop bag", 5], ["laptop sleeve", 5], ["laptop backpack", 5], ["laptop dock", 4]],
    subcategories: [
      { slug: "macbooks", name: "MacBooks", signals: [["macbook", 5]] },
      { slug: "chromebooks", name: "Chromebooks", signals: [["chromebook", 5], ["chromeos", 3]] },
      { slug: "gaming-laptops", name: "Gaming laptops", signals: [["gaming laptop", 5], ["rtx", 2], ["zephyrus", 3], ["legion", 3], ["alienware", 3], ["144hz", 1], ["240hz", 1]] },
      { slug: "business-laptops", name: "Business laptops", signals: [["business laptop", 5], ["thinkpad", 3], ["latitude", 3], ["elitebook", 3], ["vpro", 2]] },
      { slug: "2-in-1-laptops", name: "2-in-1 laptops", signals: [["2-in-1", 5], ["convertible", 3], ["x360", 3], ["detachable", 3]] },
      { slug: "ultrabooks", name: "Ultrabooks", signals: [["ultrabook", 5], ["thin and light", 3], ["ultraportable", 4]] },
    ],
  },
  {
    slug: "phones",
    name: "Phones",
    description: "Smartphones, foldables and mobile phones.",
    aliases: ["phone", "phones", "smartphone", "smartphones", "mobile", "mobile phones"],
    deviceType: "smartphone",
    priceBands: [400, 900],
    signals: [["smartphone", 4], ["phone", 2], ["iphone", 4], ["pixel", 3], ["galaxy s", 4], ["galaxy z", 4], ["galaxy a", 3], ["oneplus", 3], ["xperia", 3], ["moto g", 3], ["foldable", 2], ["nothing phone", 4]],
    negativeSignals: [["phone case", 5], ["screen protector", 5], ["phone charger", 4], ["phone mount", 5], ["phone stand", 5], ["magsafe charger", 4]],
    subcategories: [
      { slug: "iphones", name: "iPhones", signals: [["iphone", 5]] },
      { slug: "android-phones", name: "Android phones", signals: [["android", 3], ["pixel", 3], ["galaxy", 3], ["oneplus", 3]] },
      { slug: "foldable-phones", name: "Foldable phones", signals: [["foldable", 5], ["galaxy z fold", 5], ["galaxy z flip", 5], ["pixel fold", 5], ["razr", 3]] },
      { slug: "budget-phones", name: "Budget phones", signals: [["budget phone", 5], ["galaxy a", 3], ["moto g", 3], ["pixel a", 2]] },
    ],
  },
  {
    slug: "tablets",
    name: "Tablets",
    description: "Tablets and e-readers.",
    aliases: ["tablet", "tablets", "e-readers"],
    deviceType: "tablet",
    priceBands: [300, 800],
    signals: [["tablet", 3], ["ipad", 4], ["galaxy tab", 4], ["kindle", 3], ["e-reader", 3], ["surface pro", 3], ["fire hd", 3]],
    negativeSignals: [["tablet case", 5], ["ipad case", 5], ["tablet stand", 5]],
    subcategories: [
      { slug: "ipads", name: "iPads", signals: [["ipad", 5]] },
      { slug: "android-tablets", name: "Android tablets", signals: [["galaxy tab", 5], ["android tablet", 5]] },
      { slug: "e-readers", name: "E-readers", signals: [["kindle", 4], ["e-reader", 5], ["kobo", 4]] },
    ],
  },
  {
    slug: "ai-tools",
    name: "AI Tools",
    description: "AI assistants, generative AI apps and AI productivity tools.",
    aliases: ["ai", "ai tools", "artificial intelligence", "generative ai", "ai software"],
    deviceType: "ai software",
    software: true,
    signals: [["ai assistant", 4], ["chatbot", 3], ["chatgpt", 4], ["claude", 3], ["gemini", 2], ["copilot", 2], ["llm", 3], ["large language model", 4], ["generative ai", 4], ["midjourney", 4], ["dall-e", 4], ["stable diffusion", 4], ["perplexity", 3], ["ai writing", 4], ["ai image", 4], ["ai tool", 4], ["prompt", 1]],
    subcategories: [
      { slug: "ai-assistants", name: "AI assistants", signals: [["ai assistant", 5], ["chatbot", 4], ["chatgpt", 3], ["claude", 3], ["gemini", 3]] },
      { slug: "ai-image-generators", name: "AI image generators", signals: [["image generator", 5], ["midjourney", 5], ["dall-e", 5], ["stable diffusion", 5], ["ai image", 4]] },
      { slug: "ai-writing-tools", name: "AI writing tools", signals: [["ai writing", 5], ["copywriting", 3], ["ai writer", 5], ["grammar", 2]] },
      { slug: "ai-coding-assistants", name: "AI coding assistants", signals: [["coding assistant", 5], ["github copilot", 5], ["code completion", 4], ["cursor", 3]] },
      { slug: "ai-productivity", name: "AI productivity", signals: [["meeting notes", 3], ["ai productivity", 5], ["summarize", 2], ["summaries", 2], ["transcription", 3]] },
    ],
  },
  {
    slug: "developer-software",
    name: "Developer Software",
    description: "IDEs, developer tools, DevOps, databases and cloud platforms.",
    aliases: ["developer tools", "developer software", "dev tools", "software development", "devops", "programming"],
    deviceType: "developer software",
    software: true,
    signals: [["ide", 3], ["code editor", 4], ["vs code", 4], ["visual studio", 4], ["jetbrains", 4], ["intellij", 4], ["github", 3], ["gitlab", 3], ["docker", 4], ["kubernetes", 4], ["ci/cd", 4], ["devops", 4], ["sdk", 2], ["api client", 3], ["postgres", 3], ["database", 2], ["terminal", 2], ["git ", 2], ["developer tool", 4], ["hosting platform", 3], ["serverless", 3], ["observability", 3]],
    subcategories: [
      { slug: "ides-editors", name: "IDEs & code editors", signals: [["ide", 4], ["code editor", 5], ["vs code", 5], ["jetbrains", 5], ["intellij", 5], ["neovim", 5], ["zed", 3]] },
      { slug: "devops-ci", name: "DevOps & CI/CD", signals: [["ci/cd", 5], ["devops", 5], ["github actions", 5], ["jenkins", 5], ["kubernetes", 4], ["docker", 4]] },
      { slug: "databases", name: "Databases", signals: [["database", 4], ["postgres", 5], ["mysql", 5], ["mongodb", 5], ["redis", 4], ["sqlite", 4]] },
      { slug: "cloud-hosting", name: "Cloud & hosting", signals: [["hosting", 4], ["serverless", 4], ["cloud platform", 5], ["vercel", 4], ["netlify", 4], ["aws", 3]] },
      { slug: "api-tools", name: "API tools", signals: [["api client", 5], ["postman", 5], ["insomnia", 4], ["api testing", 5]] },
    ],
  },
  {
    slug: "accessories",
    name: "Accessories",
    description: "Monitors, keyboards, mice, docks, chargers, webcams and other peripherals.",
    aliases: ["accessories", "computer accessories", "peripherals", "pc accessories", "phone accessories"],
    deviceType: "accessory",
    priceBands: [50, 150],
    signals: [["monitor", 3], ["keyboard", 3], ["mechanical keyboard", 4], ["mouse", 3], ["webcam", 4], ["docking station", 4], ["dock", 2], ["usb-c hub", 4], ["hub", 1], ["charger", 3], ["power bank", 4], ["cable", 2], ["laptop stand", 4], ["phone case", 4], ["screen protector", 4], ["stylus", 3], ["trackpad", 3], ["ssd", 2], ["external drive", 3]],
    subcategories: [
      { slug: "monitors", name: "Monitors", signals: [["monitor", 5], ["ultrawide", 4], ["4k display", 3]] },
      { slug: "keyboards", name: "Keyboards", signals: [["keyboard", 5], ["mechanical keyboard", 5], ["keycaps", 3]] },
      { slug: "mice", name: "Mice & trackpads", signals: [["mouse", 5], ["trackpad", 5], ["trackball", 5]] },
      { slug: "docks-hubs", name: "Docks & hubs", signals: [["docking station", 5], ["dock", 4], ["usb-c hub", 5], ["thunderbolt dock", 5]] },
      { slug: "chargers-power", name: "Chargers & power", signals: [["charger", 5], ["power bank", 5], ["gan", 2], ["magsafe", 3]] },
      { slug: "webcams", name: "Webcams", signals: [["webcam", 5]] },
      { slug: "cases-protection", name: "Cases & protection", signals: [["case", 3], ["screen protector", 5], ["sleeve", 3]] },
      { slug: "storage-drives", name: "Storage drives", signals: [["ssd", 4], ["external drive", 5], ["hard drive", 5], ["nvme", 4]] },
    ],
  },
  {
    slug: "audio",
    name: "Audio",
    description: "Headphones, earbuds, speakers and microphones.",
    aliases: ["audio", "headphones", "earbuds", "speakers"],
    deviceType: "audio device",
    priceBands: [100, 250],
    signals: [["headphones", 4], ["headphone", 4], ["earbuds", 4], ["airpods", 4], ["speaker", 3], ["soundbar", 4], ["microphone", 3], ["noise cancelling", 3], ["anc", 2]],
    subcategories: [
      { slug: "headphones", name: "Headphones", signals: [["headphones", 5], ["over-ear", 4], ["on-ear", 4]] },
      { slug: "earbuds", name: "Earbuds", signals: [["earbuds", 5], ["airpods", 5], ["in-ear", 4]] },
      { slug: "speakers", name: "Speakers", signals: [["speaker", 5], ["soundbar", 5], ["bluetooth speaker", 5]] },
      { slug: "microphones", name: "Microphones", signals: [["microphone", 5], ["usb mic", 5]] },
    ],
  },
  {
    slug: "wearables",
    name: "Wearables",
    description: "Smartwatches, fitness trackers and smart rings.",
    aliases: ["wearables", "smartwatches", "fitness trackers"],
    deviceType: "wearable",
    priceBands: [150, 400],
    signals: [["smartwatch", 4], ["apple watch", 5], ["galaxy watch", 5], ["pixel watch", 5], ["fitness tracker", 4], ["fitbit", 4], ["garmin", 3], ["smart ring", 4], ["oura", 4], ["wearable", 3]],
    subcategories: [
      { slug: "smartwatches", name: "Smartwatches", signals: [["smartwatch", 5], ["apple watch", 5], ["galaxy watch", 5], ["pixel watch", 5]] },
      { slug: "fitness-trackers", name: "Fitness trackers", signals: [["fitness tracker", 5], ["fitbit", 5], ["whoop", 4]] },
      { slug: "smart-rings", name: "Smart rings", signals: [["smart ring", 5], ["oura", 5]] },
    ],
  },
  {
    slug: "networking",
    name: "Networking",
    description: "Wi-Fi routers, mesh systems and network gear.",
    aliases: ["networking", "routers", "wifi", "wi-fi"],
    deviceType: "networking device",
    priceBands: [100, 300],
    signals: [["router", 4], ["mesh wi-fi", 5], ["mesh wifi", 5], ["wi-fi 7", 3], ["wi-fi 6", 3], ["access point", 4], ["modem", 3], ["network switch", 4], ["eero", 4], ["orbi", 4]],
    subcategories: [
      { slug: "routers", name: "Routers", signals: [["router", 5], ["gaming router", 5]] },
      { slug: "mesh-wifi", name: "Mesh Wi-Fi", signals: [["mesh", 5], ["eero", 4], ["orbi", 4], ["deco", 4]] },
    ],
  },
];

export const INTENTS: Array<{ slug: string; name: string; signals: Signal[] }> = [
  { slug: "buy-now", name: "Buy now", signals: [["best price", 3], ["deal", 2], ["discount", 2], ["on sale", 3], ["buy", 1], ["worth buying", 3], ["should you buy", 4], ["verdict", 1]] },
  { slug: "comparison", name: "Comparison", signals: [[" vs ", 5], ["versus", 5], ["compared", 3], ["comparison", 4], ["alternatives", 3]] },
  { slug: "setup", name: "Setup", signals: [["how to", 3], ["setup", 3], ["set up", 3], ["install", 3], ["configure", 3], ["getting started", 4], ["step-by-step", 3]] },
  { slug: "productivity", name: "Productivity", signals: [["productivity", 4], ["workflow", 3], ["multitasking", 3], ["office", 2], ["note-taking", 3]] },
  { slug: "developer", name: "Developer", signals: [["developer", 4], ["programming", 4], ["coding", 3], ["software engineer", 4], ["compile", 2]] },
  { slug: "gaming", name: "Gaming", signals: [["gaming", 4], ["gamer", 4], ["fps", 2], ["esports", 4], ["frame rate", 3]] },
  { slug: "creator", name: "Creator", signals: [["creator", 4], ["video editing", 4], ["photo editing", 4], ["content creation", 4], ["streaming", 2], ["color accurate", 3]] },
  { slug: "business", name: "Business", signals: [["business", 3], ["enterprise", 4], ["professional", 2], ["team", 1], ["security features", 2], ["fleet", 2]] },
];

export const PLATFORMS: Array<{ slug: string; name: string; signals: Signal[] }> = [
  { slug: "windows", name: "Windows", signals: [["windows 11", 5], ["windows 10", 5], ["windows", 3]] },
  { slug: "macos", name: "macOS", signals: [["macos", 5], ["mac os", 5], ["macbook", 4], ["imac", 4]] },
  { slug: "chromeos", name: "ChromeOS", signals: [["chromeos", 5], ["chrome os", 5], ["chromebook", 4]] },
  { slug: "ios", name: "iOS / iPadOS", signals: [["ios", 4], ["ipados", 5], ["iphone", 4], ["ipad", 3]] },
  { slug: "android", name: "Android", signals: [["android", 5], ["pixel", 2], ["galaxy", 2]] },
  { slug: "linux", name: "Linux", signals: [["linux", 5], ["ubuntu", 5], ["fedora", 5], ["debian", 5]] },
  { slug: "web", name: "Web", signals: [["web app", 5], ["browser-based", 5], ["saas", 3], ["in the browser", 4]] },
];

export const PRICE_TIERS: Array<{ slug: string; name: string; signals: Signal[] }> = [
  { slug: "budget", name: "Budget", signals: [["budget", 4], ["affordable", 3], ["cheap", 3], ["entry-level", 3], ["under $", 3]] },
  { slug: "mid-range", name: "Mid-range", signals: [["mid-range", 5], ["midrange", 5], ["value", 1]] },
  { slug: "premium", name: "Premium", signals: [["premium", 3], ["flagship", 4], ["high-end", 4], ["luxury", 3]] },
  { slug: "free", name: "Free", signals: [["free plan", 4], ["free tier", 4], ["open source", 3], ["free and open", 4]] },
  { slug: "subscription", name: "Subscription", signals: [["per month", 3], ["/month", 3], ["subscription", 3], ["per seat", 3], ["pro plan", 2]] },
];

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export function categoryName(slug: string | null | undefined): string | undefined {
  return slug ? CATEGORY_BY_SLUG.get(slug)?.name : undefined;
}

export function subcategoryName(categorySlug: string | null | undefined, slug: string | null | undefined): string | undefined {
  if (!categorySlug || !slug) return undefined;
  return CATEGORY_BY_SLUG.get(categorySlug)?.subcategories.find((s) => s.slug === slug)?.name;
}
