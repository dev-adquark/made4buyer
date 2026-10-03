/**
 * Buyer-focused taxonomy. This file is the single source of truth: it is seeded into
 * category_tags (see lib/taxonomy/seed.ts) and drives the deterministic classifier.
 * Signals are keyword/phrase patterns with weights; they are data, not product lists.
 */

export type Signal = [pattern: string, weight: number];

/** `legacy`: kept so existing URLs and assignments stay valid, but hidden from navigation (superseded). */
export type SubcategoryDef = { slug: string; name: string; signals: Signal[]; legacy?: boolean };

/** Navigation grouping only (Amazon-style departments); not stored in the database. */
export const DEPARTMENTS = [
  { slug: "computing", name: "Computing" },
  { slug: "mobile", name: "Phones, Tablets & Wearables" },
  { slug: "audio-video", name: "Audio, TV & Cameras" },
  { slug: "home", name: "Smart Home & Networking" },
  { slug: "gaming", name: "Gaming" },
  { slug: "software", name: "Software & AI" },
  { slug: "accessories", name: "Accessories, Storage & Power" },
  { slug: "gadgets", name: "Drones, Gadgets & Auto" },
] as const;
export type DepartmentSlug = (typeof DEPARTMENTS)[number]["slug"];

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
  department: DepartmentSlug;
};

export const CATEGORIES: CategoryDef[] = [
  {
    slug: "laptops",
    department: "computing",
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
    department: "mobile",
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
    department: "mobile",
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
    department: "software",
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
    department: "software",
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
    department: "accessories",
    name: "Accessories",
    description: "Keyboards, mice, docks, storage, cables, chargers, power banks, webcams and other peripherals.",
    aliases: ["accessories", "computer accessories", "peripherals", "pc accessories", "phone accessories"],
    deviceType: "accessory",
    priceBands: [50, 150],
    signals: [["keyboard", 3], ["mechanical keyboard", 4], ["mouse", 3], ["webcam", 4], ["docking station", 4], ["dock", 2], ["usb-c hub", 4], ["hub", 1], ["charger", 3], ["power bank", 4], ["cable", 2], ["microsd", 3], ["memory card", 3], ["monitor arm", 4], ["laptop stand", 4], ["phone case", 4], ["screen protector", 4], ["stylus", 3], ["trackpad", 3], ["ssd", 2], ["external drive", 3]],
    subcategories: [
      { slug: "monitors", name: "Monitors", signals: [["monitor", 5], ["ultrawide", 4], ["4k display", 3]], legacy: true },
      { slug: "keyboards", name: "Keyboards", signals: [["keyboard", 5], ["mechanical keyboard", 5], ["keycaps", 3]] },
      { slug: "mice", name: "Mice & trackpads", signals: [["mouse", 5], ["trackpad", 5], ["trackball", 5]] },
      { slug: "docks-hubs", name: "Docks & hubs", signals: [["docking station", 5], ["dock", 4], ["usb-c hub", 5], ["thunderbolt dock", 5]] },
      { slug: "chargers-power", name: "Chargers & power", signals: [["charger", 5], ["power bank", 5], ["gan", 2], ["magsafe", 3]] },
      { slug: "webcams", name: "Webcams", signals: [["webcam", 5]] },
      { slug: "cases-protection", name: "Cases & protection", signals: [["case", 3], ["screen protector", 5], ["sleeve", 3]] },
      { slug: "storage-drives", name: "Storage drives", signals: [["ssd", 4], ["external drive", 5], ["hard drive", 5], ["nvme", 4], ["portable ssd", 5], ["nas", 3]] },
      { slug: "memory-cards", name: "Memory cards & flash drives", signals: [["microsd", 5], ["sd card", 5], ["memory card", 5], ["flash drive", 5], ["usb stick", 4]] },
      { slug: "cables-adapters", name: "Cables & adapters", signals: [["cable", 4], ["usb-c cable", 5], ["thunderbolt cable", 5], ["adapter", 3], ["dongle", 4]] },
      { slug: "stands-mounts", name: "Stands & mounts", signals: [["laptop stand", 5], ["monitor arm", 5], ["phone mount", 4], ["desk mount", 4]] },
    ],
  },
  {
    slug: "audio",
    department: "audio-video",
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
    department: "mobile",
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
    department: "home",
    name: "Networking",
    description: "Wi-Fi routers, mesh systems and network gear.",
    aliases: ["networking", "routers", "wifi", "wi-fi"],
    deviceType: "networking device",
    priceBands: [100, 300],
    signals: [["router", 4], ["mesh wi-fi", 5], ["mesh wifi", 5], ["wi-fi 7", 3], ["wi-fi 6", 3], ["access point", 4], ["modem", 3], ["network switch", 4], ["eero", 4], ["orbi", 4]],
    subcategories: [
      { slug: "routers", name: "Routers", signals: [["router", 5], ["gaming router", 5]] },
      { slug: "mesh-wifi", name: "Mesh Wi-Fi", signals: [["mesh", 5], ["eero", 4], ["orbi", 4], ["deco", 4]] },
      { slug: "switches-modems", name: "Switches & modems", signals: [["network switch", 5], ["modem", 5], ["poe", 3], ["ethernet switch", 5]] },
      { slug: "nas", name: "NAS & home servers", signals: [["nas", 5], ["synology", 5], ["qnap", 5], ["home server", 4]] },
    ],
  },
  {
    slug: "desktops",
    department: "computing",
    name: "Desktops & Mini PCs",
    description: "Desktop computers, all-in-ones, mini PCs and gaming PCs.",
    aliases: ["desktops", "desktop computers", "mini pcs", "all-in-ones", "gaming pcs", "computers"],
    deviceType: "desktop computer",
    priceBands: [700, 1600],
    signals: [["desktop pc", 5], ["mini pc", 5], ["all-in-one pc", 5], ["imac", 5], ["mac mini", 5], ["mac studio", 5], ["mac pro", 4], ["gaming pc", 5], ["desktop computer", 5], ["tower pc", 4], ["nuc", 3]],
    negativeSignals: [["laptop", 4], ["desktop app", 5], ["desktop mode", 4]],
    subcategories: [
      { slug: "mini-pcs", name: "Mini PCs", signals: [["mini pc", 5], ["mac mini", 5], ["nuc", 4]] },
      { slug: "all-in-ones", name: "All-in-ones", signals: [["all-in-one", 5], ["imac", 5]] },
      { slug: "gaming-pcs", name: "Gaming PCs", signals: [["gaming pc", 5], ["gaming desktop", 5]] },
      { slug: "workstations", name: "Workstations", signals: [["workstation", 5], ["mac studio", 4], ["mac pro", 4]] },
    ],
  },
  {
    slug: "pc-components",
    department: "computing",
    name: "PC Components",
    description: "Graphics cards, processors, motherboards, memory, power supplies, cases and cooling.",
    aliases: ["pc components", "components", "pc parts", "pc hardware", "graphics cards", "gpus", "cpus"],
    deviceType: "pc component",
    priceBands: [150, 500],
    signals: [["graphics card", 5], ["gpu", 3], ["geforce rtx", 4], ["radeon rx", 4], ["motherboard", 5], ["cpu cooler", 5], ["aio cooler", 5], ["power supply", 4], ["psu", 4], ["pc case", 5], ["ram kit", 5], ["ddr5", 3], ["desktop cpu", 5], ["processor review", 3]],
    negativeSignals: [["laptop", 5], ["gaming pc", 3], ["mini pc", 4], ["phone", 4]],
    subcategories: [
      { slug: "graphics-cards", name: "Graphics cards", signals: [["graphics card", 5], ["gpu", 4], ["geforce", 4], ["radeon", 4], ["rtx", 3]] },
      { slug: "processors", name: "Processors", signals: [["cpu", 4], ["processor", 3], ["ryzen", 4], ["core ultra", 4]] },
      { slug: "motherboards", name: "Motherboards", signals: [["motherboard", 5], ["chipset", 3]] },
      { slug: "memory", name: "Memory (RAM)", signals: [["ram kit", 5], ["ddr5", 4], ["memory kit", 5]] },
      { slug: "power-supplies", name: "Power supplies", signals: [["power supply", 5], ["psu", 5]] },
      { slug: "cases-cooling", name: "Cases & cooling", signals: [["pc case", 5], ["cpu cooler", 5], ["aio", 4], ["case fan", 4]] },
    ],
  },
  {
    slug: "monitors",
    department: "computing",
    name: "Monitors & Displays",
    description: "Computer monitors: office, gaming, ultrawide, OLED and portable displays.",
    aliases: ["monitors", "displays", "computer monitors", "monitors & displays", "screens"],
    deviceType: "monitor",
    priceBands: [250, 700],
    signals: [["monitor", 4], ["gaming monitor", 5], ["ultrawide", 4], ["oled monitor", 5], ["portable monitor", 5], ["4k monitor", 5], ["ultrasharp", 5], ["odyssey", 3], ["refresh rate", 1]],
    negativeSignals: [["heart rate monitor", 6], ["baby monitor", 6], ["monitor arm", 5], ["sleep monitor", 5], ["laptop", 3]],
    subcategories: [
      { slug: "gaming-monitors", name: "Gaming monitors", signals: [["gaming monitor", 5], ["240hz", 3], ["360hz", 4], ["480hz", 4]] },
      { slug: "office-monitors", name: "Office & productivity monitors", signals: [["office monitor", 5], ["usb-c monitor", 4], ["ultrasharp", 4], ["productivity", 2]] },
      { slug: "ultrawide-monitors", name: "Ultrawide monitors", signals: [["ultrawide", 5], ["21:9", 4], ["32:9", 4]] },
      { slug: "oled-monitors", name: "OLED monitors", signals: [["oled monitor", 5], ["qd-oled", 5], ["woled", 4]] },
      { slug: "portable-monitors", name: "Portable monitors", signals: [["portable monitor", 5], ["travel monitor", 5]] },
    ],
  },
  {
    slug: "printers",
    department: "computing",
    name: "Printers & Scanners",
    description: "Inkjet and laser printers, all-in-ones, photo printers and document scanners.",
    aliases: ["printers", "scanners", "printers & scanners"],
    deviceType: "printer",
    priceBands: [150, 400],
    signals: [["printer", 5], ["laser printer", 5], ["inkjet", 5], ["ink tank", 5], ["document scanner", 5], ["photo printer", 5], ["scanner", 3]],
    negativeSignals: [["3d printer", 8], ["fingerprint scanner", 6], ["barcode scanner", 3]],
    subcategories: [
      { slug: "laser-printers", name: "Laser printers", signals: [["laser printer", 5], ["laser", 3]] },
      { slug: "inkjet-printers", name: "Inkjet & ink-tank printers", signals: [["inkjet", 5], ["ink tank", 5], ["ecotank", 5], ["megatank", 5]] },
      { slug: "photo-printers", name: "Photo printers", signals: [["photo printer", 5], ["instax", 3]] },
      { slug: "scanners", name: "Scanners", signals: [["scanner", 5], ["document scanner", 5], ["scansnap", 5]] },
    ],
  },
  {
    slug: "smart-home",
    department: "home",
    name: "Smart Home",
    description: "Smart speakers and displays, lighting, plugs, security cameras, doorbells, locks, thermostats and robot vacuums.",
    aliases: ["smart home", "home automation", "smart-home"],
    deviceType: "smart home device",
    priceBands: [60, 200],
    signals: [["smart home", 4], ["smart plug", 5], ["smart bulb", 5], ["smart lighting", 5], ["philips hue", 5], ["smart speaker", 4], ["smart display", 4], ["video doorbell", 5], ["security camera", 4], ["smart lock", 5], ["thermostat", 4], ["robot vacuum", 5], ["homekit", 3], ["matter", 2], ["alexa", 2], ["google home", 3]],
    negativeSignals: [["phone", 3], ["laptop", 3]],
    subcategories: [
      { slug: "smart-speakers-displays", name: "Smart speakers & displays", signals: [["smart speaker", 5], ["smart display", 5], ["echo", 3], ["nest hub", 5], ["homepod", 5]] },
      { slug: "smart-lighting", name: "Smart lighting & plugs", signals: [["smart bulb", 5], ["philips hue", 5], ["smart plug", 5], ["smart lighting", 5]] },
      { slug: "home-security", name: "Security cameras & doorbells", signals: [["security camera", 5], ["video doorbell", 5], ["ring", 3], ["arlo", 5], ["wyze", 4]] },
      { slug: "smart-locks-thermostats", name: "Locks & thermostats", signals: [["smart lock", 5], ["thermostat", 5], ["nest learning", 5]] },
      { slug: "robot-vacuums", name: "Robot vacuums", signals: [["robot vacuum", 5], ["roomba", 5], ["roborock", 5]] },
    ],
  },
  {
    slug: "cameras",
    department: "audio-video",
    name: "Cameras & Photography",
    description: "Mirrorless and DSLR cameras, compact and action cameras, lenses and camera gear.",
    aliases: ["cameras", "photography", "cameras & photography", "camera"],
    deviceType: "camera",
    priceBands: [500, 1500],
    signals: [["mirrorless", 5], ["dslr", 5], ["action camera", 5], ["gopro", 5], ["instant camera", 5], ["compact camera", 5], ["camera lens", 4], ["full-frame", 4], ["aps-c", 4], ["canon eos", 5], ["nikon z", 5], ["fujifilm x", 4], ["sony a7", 5], ["sony alpha", 5], ["osmo action", 5], ["insta360", 5], ["vlogging camera", 5]],
    negativeSignals: [["phone", 4], ["smartphone", 5], ["security camera", 5], ["dash cam", 6], ["webcam", 5], ["camera phone", 6]],
    subcategories: [
      { slug: "mirrorless-cameras", name: "Mirrorless cameras", signals: [["mirrorless", 5], ["full-frame", 3], ["aps-c", 3]] },
      { slug: "dslr-cameras", name: "DSLR cameras", signals: [["dslr", 5]] },
      { slug: "action-cameras", name: "Action & 360 cameras", signals: [["action camera", 5], ["gopro", 5], ["insta360", 5], ["osmo action", 5]] },
      { slug: "compact-cameras", name: "Compact & instant cameras", signals: [["compact camera", 5], ["point-and-shoot", 5], ["instant camera", 5], ["instax", 4]] },
      { slug: "lenses", name: "Lenses", signals: [["lens", 4], ["camera lens", 5], ["prime lens", 5], ["zoom lens", 5]] },
    ],
  },
  {
    slug: "gaming",
    department: "gaming",
    name: "Gaming",
    description: "Consoles, handheld gaming PCs, controllers, VR headsets and gaming gear.",
    aliases: ["gaming", "video games", "consoles", "game consoles"],
    deviceType: "gaming device",
    priceBands: [100, 500],
    signals: [["console", 4], ["playstation", 5], ["ps5", 5], ["xbox", 5], ["nintendo switch", 5], ["switch 2", 4], ["steam deck", 5], ["rog ally", 5], ["legion go", 5], ["handheld gaming", 5], ["controller", 3], ["gamepad", 4], ["vr headset", 5], ["meta quest", 5]],
    negativeSignals: [["gaming laptop", 6], ["gaming monitor", 6], ["gaming mouse", 5], ["gaming keyboard", 5], ["gaming router", 5], ["gaming headset", 3], ["gaming pc", 5], ["graphics card", 5]],
    subcategories: [
      { slug: "consoles", name: "Consoles", signals: [["console", 5], ["ps5", 5], ["playstation", 5], ["xbox", 5], ["nintendo switch", 5]] },
      { slug: "handhelds", name: "Handheld gaming PCs", signals: [["steam deck", 5], ["rog ally", 5], ["legion go", 5], ["handheld", 4]] },
      { slug: "controllers", name: "Controllers", signals: [["controller", 5], ["gamepad", 5], ["dualsense", 5]] },
      { slug: "vr-headsets", name: "VR & mixed reality", signals: [["vr headset", 5], ["meta quest", 5], ["vision pro", 5], ["mixed reality", 4]] },
    ],
  },
  {
    slug: "tv-home-entertainment",
    department: "audio-video",
    name: "TV & Home Entertainment",
    description: "TVs, projectors and home-theater gear.",
    aliases: ["tv", "tvs", "televisions", "home entertainment", "home theater", "projectors"],
    deviceType: "television",
    priceBands: [500, 1500],
    signals: [["oled tv", 5], ["qled", 4], ["mini-led tv", 5], ["4k tv", 5], ["8k tv", 5], ["smart tv", 4], ["television", 4], ["projector", 5], ["home theater", 4], ["av receiver", 5]],
    negativeSignals: [["apple tv", 5], ["fire tv stick", 6], ["streaming stick", 6], ["chromecast", 5]],
    subcategories: [
      { slug: "tvs", name: "TVs", signals: [["oled tv", 5], ["qled", 5], ["mini-led", 4], ["4k tv", 5], ["smart tv", 4], ["television", 5]] },
      { slug: "projectors", name: "Projectors", signals: [["projector", 5], ["short throw", 4]] },
      { slug: "home-theater", name: "Home theater", signals: [["home theater", 5], ["av receiver", 5], ["surround sound", 4]] },
    ],
  },
  {
    slug: "streaming-devices",
    department: "audio-video",
    name: "Streaming Devices",
    description: "Streaming sticks and boxes: Roku, Fire TV, Apple TV, Google TV and more.",
    aliases: ["streaming devices", "streaming sticks", "media streamers"],
    deviceType: "streaming device",
    priceBands: [40, 120],
    signals: [["roku", 5], ["fire tv stick", 5], ["fire tv cube", 5], ["apple tv 4k", 5], ["chromecast", 5], ["google tv streamer", 5], ["streaming stick", 5], ["streaming device", 5], ["nvidia shield", 5], ["media streamer", 5]],
    negativeSignals: [["roku tv", 4], ["smart tv", 3]],
    subcategories: [
      { slug: "streaming-sticks", name: "Streaming sticks", signals: [["stick", 4], ["fire tv stick", 5], ["roku streaming stick", 5]] },
      { slug: "streaming-boxes", name: "Streaming boxes", signals: [["apple tv 4k", 5], ["fire tv cube", 5], ["google tv streamer", 5], ["nvidia shield", 5], ["roku ultra", 5]] },
    ],
  },
  {
    slug: "productivity-software",
    department: "software",
    name: "Office & Productivity",
    description: "Office suites, note-taking, project management, password managers and VPNs.",
    aliases: ["productivity", "productivity software", "office software", "office & productivity", "office"],
    deviceType: "productivity software",
    software: true,
    signals: [["microsoft 365", 5], ["office suite", 5], ["google workspace", 5], ["notion", 4], ["evernote", 5], ["obsidian", 4], ["onenote", 5], ["password manager", 5], ["1password", 5], ["bitwarden", 5], ["vpn", 4], ["nordvpn", 5], ["project management", 4], ["todoist", 5], ["trello", 5], ["asana", 5], ["clickup", 5], ["monday.com", 5]],
    negativeSignals: [["laptop", 3], ["phone", 3]],
    subcategories: [
      { slug: "office-suites", name: "Office suites", signals: [["microsoft 365", 5], ["office suite", 5], ["google workspace", 5], ["libreoffice", 5]] },
      { slug: "note-taking", name: "Note-taking", signals: [["note-taking", 5], ["notion", 4], ["evernote", 5], ["obsidian", 5], ["onenote", 5]] },
      { slug: "project-management", name: "Project management", signals: [["project management", 5], ["trello", 5], ["asana", 5], ["clickup", 5], ["monday.com", 5], ["todoist", 4]] },
      { slug: "password-managers", name: "Password managers", signals: [["password manager", 5], ["1password", 5], ["bitwarden", 5], ["dashlane", 5]] },
      { slug: "vpns", name: "VPNs", signals: [["vpn", 5], ["nordvpn", 5], ["expressvpn", 5], ["surfshark", 5], ["proton vpn", 5]] },
    ],
  },
  {
    slug: "drones-gadgets",
    department: "gadgets",
    name: "Drones & Tech Gadgets",
    description: "Drones, gimbals, 3D printers, item trackers, and other tech gadgets.",
    aliases: ["drones", "gadgets", "tech gadgets", "drones & gadgets", "3d printers"],
    deviceType: "gadget",
    priceBands: [150, 600],
    signals: [["drone", 5], ["dji mini", 5], ["dji air", 5], ["dji mavic", 5], ["gimbal", 4], ["3d printer", 5], ["bambu lab", 5], ["prusa", 5], ["item tracker", 5], ["airtag", 4], ["tile tracker", 5], ["gadget", 2], ["e-bike", 3], ["electric scooter", 3]],
    negativeSignals: [["phone", 3]],
    subcategories: [
      { slug: "drones", name: "Drones", signals: [["drone", 5], ["dji mini", 5], ["dji air", 5], ["dji mavic", 5], ["fpv", 4]] },
      { slug: "gimbals", name: "Gimbals & stabilizers", signals: [["gimbal", 5], ["stabilizer", 4], ["osmo mobile", 5]] },
      { slug: "3d-printers", name: "3D printers", signals: [["3d printer", 5], ["bambu lab", 5], ["prusa", 5], ["filament", 3]] },
      { slug: "trackers", name: "Item trackers", signals: [["airtag", 5], ["item tracker", 5], ["tile tracker", 5], ["smarttag", 5]] },
    ],
  },
  {
    slug: "automotive-tech",
    department: "gadgets",
    name: "Automotive Tech",
    description: "Dash cams, CarPlay and Android Auto units, car chargers and EV chargers.",
    aliases: ["automotive", "car tech", "automotive tech", "car electronics"],
    deviceType: "car electronics",
    priceBands: [100, 400],
    signals: [["dash cam", 5], ["dashcam", 5], ["carplay", 4], ["android auto", 4], ["head unit", 5], ["car charger", 5], ["ev charger", 5], ["home ev charger", 5], ["obd", 4], ["car mount", 4], ["jump starter", 5]],
    negativeSignals: [["phone", 2]],
    subcategories: [
      { slug: "dash-cams", name: "Dash cams", signals: [["dash cam", 5], ["dashcam", 5]] },
      { slug: "car-infotainment", name: "CarPlay & Android Auto", signals: [["carplay", 5], ["android auto", 5], ["head unit", 5]] },
      { slug: "ev-chargers", name: "EV chargers", signals: [["ev charger", 5], ["home ev charger", 5], ["level 2 charger", 5]] },
      { slug: "car-accessories", name: "Car chargers & mounts", signals: [["car charger", 5], ["car mount", 5], ["jump starter", 5]] },
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
