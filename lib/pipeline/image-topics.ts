import { tokenize } from "@/lib/util/text";

/**
 * Illustrative image topics. When no photo shows the reviewed product itself (always the case
 * for software), the page may use a photo of the product's subject: a VPN review gets a
 * network-security photo, a database comparison a server photo. Such images are stored with
 * subject ILLUSTRATIVE and labelled on the page, so they are never presented as the product.
 *
 * A Pexels result qualifies only if its own description contains one of the topic's `accept`
 * words, so an off-topic photo is never used just because the search returned it.
 */
export type ImageTopic = {
  key: string;
  label: string;
  queries: string[];
  accept: string[];
  /** Other product types: a photo naming one of these before an accepted word is about that other object. */
  competing?: string[];
};

type Rule = ImageTopic & { match: string[] };

// Ordered: the first matching rule wins, so specific topics come before broad ones.
const RULES: Rule[] = [
  { key: "vpn", label: "online privacy and network security", match: ["vpn", "nordvpn", "expressvpn", "surfshark", "proton vpn", "vpns"], queries: ["cybersecurity network privacy", "data security padlock"], accept: ["vpn", "security", "cybersecurity", "privacy", "padlock", "lock", "encryption", "network", "hacker", "secure", "protection"] },
  { key: "cloud-storage", label: "cloud storage and file sync", match: ["cloud storage", "pcloud", "sync.com", "icedrive", "dropbox", "onedrive", "google drive", "cloud-storage"], queries: ["cloud storage data server", "data center servers"], accept: ["cloud", "server", "servers", "storage", "data", "datacenter", "rack", "drive"] },
  { key: "database", label: "databases and data infrastructure", match: ["postgres", "postgresql", "database", "databases", "supabase", "neon", "mysql", "sql"], queries: ["database server room", "data center servers"], accept: ["server", "servers", "data", "database", "datacenter", "rack", "network"] },
  { key: "deployment", label: "cloud hosting and deployment", match: ["vercel", "cloudflare", "netlify", "hosting", "deploy", "deployment", "serverless", "cdn"], queries: ["cloud computing server network", "data center network cables"], accept: ["server", "servers", "cloud", "network", "data", "datacenter", "cables", "rack"] },
  { key: "auth-secrets", label: "authentication and secrets management", match: ["auth", "auth0", "clerk", "authentication", "login", "secrets", "doppler", "infisical", "password manager", "1password", "bitwarden"], queries: ["password login security", "cyber security lock"], accept: ["password", "login", "security", "lock", "padlock", "secure", "cybersecurity", "authentication"] },
  { key: "code-security", label: "software supply-chain security", match: ["snyk", "dependabot", "renovate", "vulnerability", "dependency", "dependencies", "supply chain"], queries: ["cybersecurity code screen", "programming code security"], accept: ["security", "cybersecurity", "code", "hacker", "programming", "lock"] },
  { key: "terminal", label: "the command line", match: ["terminal", "tmux", "zellij", "wezterm", "iterm", "iterm2", "ghostty"], queries: ["programming code terminal screen", "computer code dark screen"], accept: ["code", "coding", "programming", "terminal", "programmer", "developer", "screen", "computer"] },
  { key: "ai-coding", label: "AI-assisted programming", match: ["cursor", "windsurf", "copilot", "ide", "code editor", "ai editor", "coding assistant"], queries: ["programming code on screen", "developer coding laptop"], accept: ["code", "coding", "programming", "programmer", "developer", "software", "computer", "laptop"] },
  { key: "dev-platform", label: "software development", match: ["launchdarkly", "unleash", "growthbook", "posthog", "feature flag", "feature flags", "temporal", "inngest", "trigger.dev", "bullmq", "workflow", "queue"], queries: ["software developer team code", "programming code on screen"], accept: ["code", "coding", "programming", "developer", "software", "computer", "laptop", "team"] },
  { key: "website", label: "websites and online stores", match: ["website builder", "wix", "squarespace", "shopify", "woocommerce", "bigcommerce", "ecommerce", "online store", "web hosting", "wordpress hosting", "bluehost", "hostinger", "siteground", "domain registrar"], queries: ["website design on laptop", "online shopping ecommerce"], accept: ["website", "web", "laptop", "online", "shopping", "ecommerce", "computer", "design"] },
  { key: "creative", label: "design and creative work", match: ["photoshop", "lightroom", "figma", "canva", "video editor", "video editing", "photo editor", "graphic design", "davinci resolve", "premiere pro"], queries: ["graphic designer workspace", "video editing workstation"], accept: ["design", "designer", "creative", "editing", "video", "photo", "artist", "drawing", "computer"] },
  { key: "project-management", label: "project planning and teamwork", match: ["project management", "clickup", "monday.com", "zoho", "asana", "trello", "kanban", "todoist"], queries: ["team planning project board", "office team meeting laptop"], accept: ["team", "planning", "meeting", "office", "board", "notes", "work", "laptop", "colleagues", "business"] },
];

const SOFTWARE_CATEGORIES = new Set(["developer-software", "productivity-software", "ai-tools", "security-software", "business-software", "website-ecommerce", "creative-software"]);

/** Per-category fallback topic, used when no specific rule matches. */
const CATEGORY_TOPICS: Record<string, Omit<ImageTopic, "key">> = {
  laptops: { label: "laptops", queries: ["laptop on desk"], accept: ["laptop", "notebook", "computer", "macbook"] },
  phones: { label: "smartphones", queries: ["smartphone in hand"], accept: ["smartphone", "phone", "iphone", "mobile"] },
  tablets: { label: "tablets", queries: ["tablet device"], accept: ["tablet", "ipad"] },
  "ai-tools": { label: "artificial intelligence", queries: ["artificial intelligence technology"], accept: ["artificial", "intelligence", "robot", "technology", "computer", "code"] },
  "developer-software": { label: "software development", queries: ["programming code on screen"], accept: ["code", "coding", "programming", "developer", "computer", "software"] },
  "productivity-software": { label: "work and productivity", queries: ["laptop office work"], accept: ["laptop", "office", "work", "desk", "computer", "business"] },
  "security-software": { label: "online security and privacy", queries: ["cybersecurity network privacy", "data security padlock"], accept: ["security", "cybersecurity", "privacy", "padlock", "lock", "encryption", "network", "secure", "protection"] },
  "business-software": { label: "business teams at work", queries: ["team planning project board", "office team meeting laptop"], accept: ["team", "planning", "meeting", "office", "business", "work", "laptop", "colleagues"] },
  "website-ecommerce": { label: "websites and online stores", queries: ["website design on laptop", "online shopping ecommerce"], accept: ["website", "web", "laptop", "online", "shopping", "ecommerce", "computer", "design"] },
  "creative-software": { label: "design and creative work", queries: ["graphic designer workspace", "video editing workstation"], accept: ["design", "designer", "creative", "editing", "video", "photo", "artist", "drawing", "tablet", "computer"] },
  accessories: { label: "computer accessories", queries: ["keyboard mouse desk"], accept: ["keyboard", "mouse", "desk", "accessories", "computer"] },
  audio: { label: "headphones and audio", queries: ["headphones close up"], accept: ["headphones", "headphone", "earbuds", "speaker", "audio", "music"] },
  wearables: { label: "wearables", queries: ["smartwatch on wrist"], accept: ["smartwatch", "watch", "wrist", "fitness", "tracker"] },
  networking: { label: "home networking", queries: ["wifi router"], accept: ["router", "wifi", "network", "cables", "internet", "modem"] },
  desktops: { label: "desktop computers", queries: ["desktop computer workspace"], accept: ["desktop", "computer", "pc", "workspace", "monitor"] },
  "pc-components": { label: "PC hardware", queries: ["computer hardware components"], accept: ["hardware", "graphics", "motherboard", "processor", "cpu", "computer", "components", "chip"] },
  monitors: { label: "computer monitors", queries: ["computer monitor desk"], accept: ["monitor", "screen", "display", "desk", "computer"] },
  printers: { label: "printers", queries: ["office printer"], accept: ["printer", "printing", "paper"] },
  "smart-home": { label: "smart home devices", queries: ["smart home device"], accept: ["smart", "home", "speaker", "device", "thermostat", "light"] },
  cameras: { label: "cameras", queries: ["camera photography"], accept: ["camera", "lens", "photography", "photographer"] },
  gaming: { label: "gaming", queries: ["video game controller"], accept: ["game", "gaming", "controller", "console", "gamer"] },
  "tv-home-entertainment": { label: "home entertainment", queries: ["living room television"], accept: ["television", "tv", "living", "screen"] },
  "streaming-devices": { label: "streaming", queries: ["tv remote streaming"], accept: ["television", "tv", "remote", "streaming", "screen"] },
  "drones-gadgets": { label: "drones and gadgets", queries: ["drone flying"], accept: ["drone", "gadget", "quadcopter"] },
  "automotive-tech": { label: "in-car technology", queries: ["car dashboard"], accept: ["car", "dashboard", "vehicle", "driving"] },
  mattresses: { label: "sleep and bedrooms", queries: ["bedroom bed mattress"], accept: ["bed", "bedroom", "mattress", "pillow", "sleep"] },
  furniture: { label: "furniture", queries: ["ergonomic office chair"], accept: ["chair", "desk", "furniture", "sofa", "table"] },
  "kitchen-appliances": { label: "kitchen appliances", queries: ["kitchen countertop appliances"], accept: ["kitchen", "appliance", "coffee", "blender", "cooking"] },
  "home-appliances": { label: "home appliances", queries: ["home appliance interior"], accept: ["appliance", "washing", "vacuum", "home", "laundry"] },
  "fitness-equipment": { label: "fitness equipment", queries: ["home gym equipment"], accept: ["gym", "fitness", "dumbbell", "exercise", "workout", "treadmill"] },
  "personal-care": { label: "personal care", queries: ["grooming products bathroom"], accept: ["grooming", "bathroom", "skincare", "razor", "hair", "care"] },
  "outdoor-garden": { label: "outdoor and garden", queries: ["garden backyard"], accept: ["garden", "backyard", "outdoor", "lawn", "grill", "plants"] },
  "tools-diy": { label: "tools and DIY", queries: ["power tools workshop"], accept: ["tools", "tool", "drill", "workshop", "diy"] },
  "baby-kids": { label: "babies and kids", queries: ["baby nursery"], accept: ["baby", "child", "kids", "nursery", "stroller", "toddler"] },
  "pet-supplies": { label: "pets", queries: ["dog at home"], accept: ["dog", "cat", "pet", "puppy", "kitten"] },
  "luggage-travel": { label: "travel", queries: ["suitcase travel"], accept: ["suitcase", "luggage", "travel", "airport", "backpack"] },
};

/** Every search query the topic rules can issue (used by the test stub). */
export const ALL_TOPIC_QUERIES: string[] = [...new Set([...RULES.flatMap((r) => r.queries), ...Object.values(CATEGORY_TOPICS).flatMap((c) => c.queries)])];

export function imageTopic(input: { title: string; productName: string; categorySlug?: string | null; subcategorySlug?: string | null }): ImageTopic | null {
  const text = ` ${tokenize(`${input.title} ${input.productName} ${input.subcategorySlug ?? ""}`).join(" ")} `;
  // Software topics only apply to software reviews: "cursor" or "terminal" in a mouse or
  // charger review must not pull in a programming photo.
  const software = !input.categorySlug || SOFTWARE_CATEGORIES.has(input.categorySlug);
  if (software) for (const r of RULES) if (r.match.some((m) => text.includes(` ${tokenize(m).join(" ")} `))) return { key: r.key, label: r.label, queries: r.queries, accept: r.accept };
  const c = input.categorySlug ? CATEGORY_TOPICS[input.categorySlug] : undefined;
  return c ? { key: `category:${input.categorySlug}`, ...c } : null;
}

/** True when a photo's own description is about the topic. */
export function photoMatchesTopic(alt: string, topic: ImageTopic): boolean {
  const words = tokenize(alt);
  const first = words.findIndex((w) => topic.accept.includes(w));
  if (first < 0) return false;
  // "Compact white drone … surrounded by flashlight" is a photo of a drone, not of a flashlight.
  if (topic.competing?.length && words.slice(0, first).some((w) => topic.competing!.includes(w))) return false;
  return true;
}
