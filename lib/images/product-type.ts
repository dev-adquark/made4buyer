import { tokenize } from "@/lib/util/text";
import { imageTopic, type ImageTopic } from "@/lib/pipeline/image-topics";

/**
 * The kind of product a single-product page is about, read from the product's own name and the
 * review's title (never from the category, which can be wrong: a tumbler filed under travel must
 * not get a suitcase photo). Used to find a relevant, labelled illustrative photo of that kind of
 * product when no licensed photo of the exact product exists. A photo qualifies only if its own
 * description names the product type (`accept`), so an off-topic photo is never used.
 */
type TypeRule = { key: string; label: string; match: string[]; queries: string[]; accept: string[] };

// Ordered: specific types first ("galaxy watch" before "galaxy", "car mount" before "car").
const TYPES: TypeRule[] = [
  { key: "smartwatch", label: "a smartwatch", match: ["smartwatch", "galaxy watch", "apple watch", "pixel watch", "fitness tracker", "watch"], queries: ["smartwatch on wrist", "smart watch close up"], accept: ["smartwatch", "watch", "wrist"] },
  { key: "foldable-phone", label: "a foldable smartphone", match: ["fold", "flip", "foldable"], queries: ["foldable smartphone", "smartphone in hand"], accept: ["smartphone", "phone", "mobile", "cellphone"] },
  { key: "smartphone", label: "a smartphone", match: ["smartphone", "phone", "iphone", "pixel", "galaxy", "motorola", "oneplus", "xiaomi", "moto"], queries: ["smartphone in hand", "modern smartphone on table"], accept: ["smartphone", "phone", "mobile", "cellphone", "iphone"] },
  { key: "car-mount", label: "a car phone mount", match: ["car mount", "magsafe car", "phone mount", "dashboard mount", "vent mount"], queries: ["phone holder car dashboard", "smartphone car mount"], accept: ["car", "dashboard", "holder", "mount", "driving"] },
  { key: "tumbler", label: "an insulated tumbler", match: ["tumbler", "travel mug", "insulated mug", "water bottle", "bottle", "flask", "mug"], queries: ["insulated tumbler cup", "stainless steel water bottle"], accept: ["tumbler", "bottle", "flask", "mug", "cup", "thermos"] },
  { key: "flashlight", label: "a flashlight", match: ["flashlight", "torch", "headlamp", "imini", "keychain light", "edc light"], queries: ["small flashlight", "flashlight in hand"], accept: ["flashlight", "torch", "light", "lamp"] },
  { key: "packing-cubes", label: "packing cubes", match: ["packing cube", "packing cubes", "packing organizer"], queries: ["packing cubes suitcase", "organized packing clothes"], accept: ["packing", "cubes", "suitcase", "clothes", "luggage", "organizer"] },
  { key: "duffel", label: "a duffel bag", match: ["duffel", "duffle", "weekender", "holdall"], queries: ["duffel bag", "travel duffle bag"], accept: ["duffel", "duffle", "bag", "holdall"] },
  { key: "sling", label: "a sling bag", match: ["sling", "crescent", "crossbody", "hip pack", "waist pack", "fanny pack"], queries: ["sling bag", "crossbody bag"], accept: ["sling", "crossbody", "bag", "pack"] },
  { key: "messenger", label: "a messenger bag", match: ["messenger", "briefcase", "laptop bag", "tote"], queries: ["messenger bag", "leather laptop bag"], accept: ["messenger", "bag", "briefcase", "tote"] },
  { key: "backpack", label: "a backpack", match: ["backpack", "daypack", "rucksack", "roll top", "rolltop"], queries: ["backpack", "travel backpack"], accept: ["backpack", "rucksack", "bag", "daypack"] },
  { key: "suitcase", label: "a suitcase", match: ["suitcase", "carry on", "carry-on", "luggage", "spinner", "check in"], queries: ["suitcase", "carry on luggage"], accept: ["suitcase", "luggage", "baggage", "trolley"] },
  { key: "air-purifier", label: "an air purifier", match: ["air purifier", "purifier", "airmega"], queries: ["air purifier in living room", "air purifier"], accept: ["purifier", "air"] },
  { key: "shaver", label: "an electric shaver", match: ["shaver", "shavers", "razor", "trimmer", "groomer"], queries: ["electric shaver", "electric razor"], accept: ["shaver", "razor", "shaving", "trimmer"] },
  { key: "espresso", label: "a coffee or espresso machine", match: ["espresso", "coffee machine", "coffee maker", "barista", "nespresso", "coffee"], queries: ["espresso machine", "coffee machine kitchen"], accept: ["espresso", "coffee", "machine", "barista", "cappuccino"] },
  { key: "soundbar", label: "a soundbar", match: ["soundbar", "sound bar", "beam", "arc"], queries: ["soundbar tv living room", "soundbar speaker"], accept: ["soundbar", "speaker", "tv", "television"] },
  { key: "headphones", label: "headphones", match: ["headphones", "headphone", "earbuds", "earphones", "airpods", "buds"], queries: ["headphones close up", "wireless earbuds"], accept: ["headphones", "headphone", "earbuds", "earphones", "audio"] },
  { key: "speaker", label: "a speaker", match: ["speaker", "bluetooth speaker", "smart speaker"], queries: ["bluetooth speaker", "speaker on table"], accept: ["speaker", "audio", "music"] },
  { key: "laptop", label: "a laptop", match: ["laptop", "notebook", "macbook", "chromebook", "ultrabook"], queries: ["laptop on desk", "open laptop"], accept: ["laptop", "notebook", "macbook", "computer"] },
  { key: "tablet", label: "a tablet", match: ["tablet", "ipad"], queries: ["tablet device", "tablet in hands"], accept: ["tablet", "ipad"] },
  { key: "camera", label: "a camera", match: ["camera", "mirrorless", "dslr", "action cam", "gopro"], queries: ["camera photography", "mirrorless camera"], accept: ["camera", "lens", "photography"] },
  { key: "router", label: "a wifi router", match: ["router", "mesh wifi", "wifi system", "access point"], queries: ["wifi router"], accept: ["router", "wifi", "modem", "network"] },
  { key: "monitor", label: "a computer monitor", match: ["monitor", "display"], queries: ["computer monitor desk"], accept: ["monitor", "screen", "display"] },
  { key: "keyboard", label: "a keyboard", match: ["keyboard"], queries: ["mechanical keyboard"], accept: ["keyboard", "keys"] },
  { key: "mouse", label: "a computer mouse", match: ["mouse"], queries: ["computer mouse on desk"], accept: ["mouse"] },
  { key: "charger", label: "a charger", match: ["charger", "power bank", "powerbank", "charging"], queries: ["phone charger cable", "power bank"], accept: ["charger", "charging", "cable", "battery", "power"] },
  { key: "vacuum", label: "a vacuum cleaner", match: ["vacuum", "robot vacuum", "hoover"], queries: ["vacuum cleaner", "robot vacuum cleaner"], accept: ["vacuum", "cleaner", "cleaning"] },
  { key: "mattress", label: "a mattress", match: ["mattress"], queries: ["bedroom bed mattress"], accept: ["mattress", "bed", "bedroom"] },
  { key: "chair", label: "an office chair", match: ["office chair", "gaming chair", "chair"], queries: ["ergonomic office chair"], accept: ["chair"] },
  { key: "air-fryer", label: "an air fryer", match: ["air fryer", "airfryer"], queries: ["air fryer kitchen"], accept: ["fryer", "kitchen", "cooking"] },
  { key: "blender", label: "a blender", match: ["blender", "mixer"], queries: ["kitchen blender smoothie"], accept: ["blender", "smoothie", "mixer"] },
  { key: "drone", label: "a drone", match: ["drone", "quadcopter"], queries: ["drone flying"], accept: ["drone", "quadcopter"] },
  { key: "stroller", label: "a stroller", match: ["stroller", "pram", "pushchair"], queries: ["baby stroller"], accept: ["stroller", "pram", "baby"] },
  { key: "sunscreen", label: "sunscreen", match: ["sunscreen", "sunblock", "spf"], queries: ["sunscreen lotion"], accept: ["sunscreen", "lotion", "cream", "sun"] },
];

const SOFTWARE_CATEGORIES = new Set(["developer-software", "productivity-software", "ai-tools", "security-software", "business-software", "website-ecommerce", "creative-software"]);

function contains(text: string, phrase: string): boolean {
  return text.includes(` ${tokenize(phrase).join(" ")} `);
}

/**
 * The image topic for a single-product page, or null when the product type can't be read from
 * its name or title. Software products use the subject topics (a VPN review gets a network
 * security photo); physical products use their product type. Never a category guess.
 */
export function productTypeTopic(input: { productName: string; title?: string | null; categorySlug?: string | null }): ImageTopic | null {
  if (input.categorySlug && SOFTWARE_CATEGORIES.has(input.categorySlug)) {
    const t = imageTopic({ title: input.title ?? "", productName: input.productName, categorySlug: input.categorySlug });
    return t ? { ...t, key: `product-type:${t.key}` } : null;
  }
  // The product name decides first; the title only when the name alone is not enough.
  for (const text of [input.productName, `${input.productName} ${input.title ?? ""}`]) {
    const padded = ` ${tokenize(text).join(" ")} `;
    const rule = TYPES.find((r) => r.match.some((m) => contains(padded, m)));
    if (rule) return { key: `product-type:${rule.key}`, label: rule.label, queries: rule.queries, accept: rule.accept };
  }
  return null;
}

/** Every query the product-type topics can issue (for the test stub). */
export const PRODUCT_TYPE_QUERIES: string[] = [...new Set(TYPES.flatMap((t) => t.queries))];
