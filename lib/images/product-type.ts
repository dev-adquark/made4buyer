import { tokenize } from "@/lib/util/text";
import { imageTopic, type ImageTopic } from "@/lib/pipeline/image-topics";

/**
 * The kind of product a single-product page is about, read from the product's own name and the
 * review's title (never from the category, which can be wrong: a tumbler filed under travel must
 * not get a suitcase photo). Used to find a relevant, labelled illustrative photo of that kind of
 * product when no licensed photo of the exact product exists. A photo qualifies only if its own
 * description names the product type (`accept`), so an off-topic photo is never used.
 */
type TypeRule = { key: string; label: string; match: string[]; queries: string[]; accept: string[]; allowWith?: string[] };

// Ordered: specific types first ("galaxy watch" before "galaxy", "car mount" before "car").
const TYPES: TypeRule[] = [
  { key: "smartwatch", label: "a smartwatch", match: ["smartwatch", "galaxy watch", "apple watch", "pixel watch", "fitness tracker", "watch"], queries: ["smartwatch on wrist", "smart watch close up", "fitness tracker wrist"], accept: ["smartwatch", "watch", "wrist"] },
  { key: "headphones", label: "headphones", match: ["headphones", "headphone", "headset", "headsets", "gaming headset", "earbuds", "earphones", "airpods", "buds"], queries: ["headphones close up", "wireless earbuds"], accept: ["headphones", "headphone", "headset", "earbuds", "earphones", "audio"] },
  { key: "foldable-phone", label: "a foldable smartphone", match: ["fold", "flip", "foldable"], queries: ["foldable smartphone", "smartphone in hand", "mobile phone close up", "person holding smartphone"], accept: ["smartphone", "phone", "mobile", "cellphone"] },
  { key: "smartphone", label: "a smartphone", match: ["smartphone", "phone", "iphone", "pixel", "galaxy", "motorola", "oneplus", "xiaomi", "moto"], queries: ["smartphone in hand", "modern smartphone on table", "mobile phone close up", "person holding smartphone"], accept: ["smartphone", "phone", "mobile", "cellphone", "iphone"] },
  { key: "car-mount", label: "a car phone mount", match: ["car mount", "magsafe car", "phone mount", "dashboard mount", "vent mount"], queries: ["phone holder car dashboard", "smartphone car mount"], accept: ["car", "dashboard", "holder", "mount", "driving"], allowWith: ["smartphone", "phone", "iphone", "mobile"] },
  { key: "tumbler", label: "an insulated tumbler", match: ["tumbler", "travel mug", "insulated mug", "water bottle", "bottle", "flask", "mug"], queries: ["insulated tumbler cup", "stainless steel water bottle"], accept: ["tumbler", "bottle", "flask", "mug", "cup", "thermos"] },
  { key: "flashlight", label: "a flashlight", match: ["flashlight", "torch", "headlamp", "imini", "keychain light", "edc light"], queries: ["small flashlight", "flashlight in hand"], accept: ["flashlight", "torch", "headlamp"] },
  { key: "packing-cubes", label: "packing cubes", match: ["packing cube", "packing cubes", "packing organizer"], queries: ["packing cubes suitcase", "organized packing clothes"], accept: ["packing", "cubes", "suitcase", "clothes", "luggage", "organizer"] },
  { key: "duffel", label: "a duffel bag", match: ["duffel", "duffle", "weekender", "holdall"], queries: ["duffel bag", "travel duffle bag"], accept: ["duffel", "duffle", "bag", "holdall"] },
  { key: "sling", label: "a sling bag", match: ["sling", "crescent", "crossbody", "hip pack", "waist pack", "fanny pack"], queries: ["sling bag", "crossbody bag", "crossbody bag street style"], accept: ["sling", "crossbody", "bag", "pack"] },
  { key: "messenger", label: "a messenger bag", match: ["messenger", "briefcase", "laptop bag", "tote"], queries: ["messenger bag", "leather laptop bag"], accept: ["messenger", "bag", "briefcase", "tote"] },
  { key: "backpack", label: "a backpack", match: ["backpack", "daypack", "rucksack", "roll top", "rolltop"], queries: ["backpack", "travel backpack"], accept: ["backpack", "rucksack", "bag", "daypack"] },
  { key: "suitcase", label: "a suitcase", match: ["suitcase", "carry on", "carry-on", "luggage", "spinner", "check in"], queries: ["suitcase", "carry on luggage"], accept: ["suitcase", "luggage", "baggage", "trolley"] },
  { key: "air-purifier", label: "an air purifier", match: ["air purifier", "purifier", "airmega"], queries: ["air purifier in living room", "air purifier", "air purifier machine"], accept: ["purifier"] },
  { key: "shaver", label: "an electric shaver", match: ["shaver", "shavers", "razor", "trimmer", "groomer"], queries: ["electric shaver", "electric razor"], accept: ["shaver", "razor", "shaving", "trimmer"] },
  { key: "espresso", label: "a coffee or espresso machine", match: ["espresso", "coffee machine", "coffee maker", "barista", "nespresso", "coffee"], queries: ["espresso machine", "coffee machine kitchen"], accept: ["espresso", "coffee", "machine", "barista", "cappuccino"] },
  { key: "soundbar", label: "a soundbar", match: ["soundbar", "sound bar", "beam", "arc"], queries: ["soundbar tv living room", "soundbar speaker"], accept: ["soundbar", "speaker", "tv", "television"] },
  { key: "speaker", label: "a speaker", match: ["speaker", "bluetooth speaker", "smart speaker"], queries: ["bluetooth speaker", "speaker on table"], accept: ["speaker", "audio", "music"] },
  { key: "laptop", label: "a laptop", match: ["laptop", "notebook", "macbook", "chromebook", "ultrabook"], queries: ["laptop on desk", "open laptop"], accept: ["laptop", "notebook", "macbook", "computer"] },
  { key: "tablet", label: "a tablet", match: ["tablet", "ipad"], queries: ["tablet device", "tablet in hands"], accept: ["tablet", "ipad"] },
  { key: "doorbell", label: "a video doorbell", match: ["doorbell", "video doorbell"], queries: ["video doorbell front door"], accept: ["doorbell", "door"] },
  { key: "security-camera", label: "a security camera", match: ["security camera", "indoor camera", "outdoor camera", "cam pan", "floodlight cam", "spotlight cam"], queries: ["home security camera"], accept: ["camera", "security", "surveillance", "cctv"] },
  { key: "webcam", label: "a webcam", match: ["webcam", "web camera"], queries: ["webcam on monitor"], accept: ["webcam", "camera"] },
  { key: "camera", label: "a camera", match: ["camera", "mirrorless", "dslr", "action cam", "gopro"], queries: ["camera photography", "mirrorless camera"], accept: ["camera", "lens", "photography"] },
  { key: "router", label: "a wifi router", match: ["router", "mesh wifi", "wifi system", "access point"], queries: ["wifi router"], accept: ["router", "wifi", "modem", "network"] },
  { key: "projector", label: "a projector", match: ["projector", "home cinema", "home theater projector", "laser tv"], queries: ["home cinema projector", "projector"], accept: ["projector", "projection", "cinema"] },
  { key: "streaming-device", label: "a TV streaming device", match: ["apple tv", "fire tv", "roku", "chromecast", "streaming stick", "streaming player", "streaming device"], queries: ["tv remote streaming", "living room television"], accept: ["tv", "television", "remote", "streaming"] },
  { key: "tv", label: "a television", match: ["television", "smart tv", "oled tv", "qled tv", "4k tv", "uhd tv", "tv"], queries: ["living room television", "tv in living room"], accept: ["television", "tv"] },
  { key: "monitor", label: "a computer monitor", match: ["monitor", "display"], queries: ["computer monitor desk"], accept: ["monitor", "screen", "display"] },
  { key: "keyboard", label: "a keyboard", match: ["keyboard"], queries: ["mechanical keyboard"], accept: ["keyboard", "keys"] },
  { key: "mouse", label: "a computer mouse", match: ["mouse"], queries: ["computer mouse on desk"], accept: ["mouse"] },
  { key: "power-station", label: "a portable power station", match: ["power station", "portable power", "solar generator", "home battery"], queries: ["portable power station camping", "solar panel battery"], accept: ["power", "battery", "generator", "solar"] },
  { key: "charger", label: "a charger", match: ["charger", "power bank", "powerbank", "charging"], queries: ["phone charger cable", "power bank"], accept: ["charger", "charging", "cable", "battery", "power"] },
  { key: "vacuum", label: "a vacuum cleaner", match: ["vacuum", "robot vacuum", "hoover"], queries: ["vacuum cleaner", "robot vacuum cleaner"], accept: ["vacuum", "cleaner", "cleaning"] },
  { key: "mattress", label: "a mattress", match: ["mattress"], queries: ["bedroom bed mattress"], accept: ["mattress", "bed", "bedroom"] },
  { key: "chair", label: "an office chair", match: ["office chair", "gaming chair", "chair"], queries: ["ergonomic office chair"], accept: ["chair"] },
  { key: "air-fryer", label: "an air fryer", match: ["air fryer", "airfryer"], queries: ["air fryer kitchen"], accept: ["fryer", "kitchen", "cooking"] },
  { key: "blender", label: "a blender", match: ["blender", "mixer"], queries: ["kitchen blender smoothie"], accept: ["blender", "smoothie", "mixer"] },
  { key: "drone", label: "a drone", match: ["drone", "quadcopter"], queries: ["drone flying"], accept: ["drone", "quadcopter"] },
  { key: "stroller", label: "a stroller", match: ["stroller", "pram", "pushchair"], queries: ["baby stroller"], accept: ["stroller", "pram", "baby"] },
  { key: "pouch", label: "a pouch or organizer", match: ["pouch", "tech pouch", "tech kit", "cable organizer", "wallet", "card holder", "toiletry kit", "dopp kit"], queries: ["leather pouch", "travel pouch organizer", "leather wallet"], accept: ["pouch", "wallet", "organizer", "purse", "case", "bag"] },
  { key: "printer", label: "a printer", match: ["printer", "all in one printer", "supertank", "ecotank", "inkjet", "laser printer", "photo lab", "label maker"], queries: ["office printer", "printer printing paper", "home printer"], accept: ["printer", "printing", "print"] },
  { key: "scanner", label: "a document scanner", match: ["scanner", "document scanner", "photo scanning", "scanning system"], queries: ["document scanner office", "scanner"], accept: ["scanner", "scanning", "scan"] },
  { key: "pillow", label: "a pillow", match: ["pillow", "pillows", "backrest pillow"], queries: ["bed pillows bedroom", "pillow on bed"], accept: ["pillow", "pillows", "cushion"] },
  { key: "storage-drive", label: "a storage drive", match: ["ssd", "hard drive", "portable drive", "external drive", "nas", "microsd", "memory card", "flash drive", "usb drive"], queries: ["external hard drive", "ssd storage drive"], accept: ["drive", "ssd", "storage", "disk", "hard", "memory"] },
  { key: "thermostat", label: "a smart thermostat", match: ["thermostat"], queries: ["smart thermostat wall"], accept: ["thermostat"] },
  { key: "smart-light", label: "a smart light", match: ["smart bulb", "light bulb", "light strip", "lightstrip", "smart light"], queries: ["smart light bulb", "led light bulb"], accept: ["bulb", "light", "lamp", "led"] },
  { key: "e-reader", label: "an e-reader", match: ["e reader", "ereader", "kindle", "kobo"], queries: ["e-reader reading", "ebook reader"], accept: ["reader", "ebook", "kindle", "reading", "book"] },
  { key: "game-controller", label: "a game controller", match: ["controller", "gamepad", "game console", "console"], queries: ["video game controller", "gaming controller"], accept: ["controller", "gamepad", "console", "game", "gaming", "joystick"] },
  { key: "microphone", label: "a microphone", match: ["microphone", "usb mic", "podcast mic", "wireless mic"], queries: ["podcast microphone", "studio microphone"], accept: ["microphone", "mic"] },
  { key: "massage-gun", label: "a massage gun", match: ["massage gun", "theragun", "percussive massager", "massager"], queries: ["massage gun therapy"], accept: ["massage", "massager"] },
  { key: "power-tool", label: "a power tool", match: ["drill", "impact driver", "circular saw", "sander", "power tool", "multi tool", "jigsaw"], queries: ["power drill tool", "power tools workshop"], accept: ["drill", "tool", "tools", "saw", "workshop"] },
  { key: "grill", label: "a grill", match: ["grill", "smoker", "griddle", "barbecue", "bbq", "pellet grill"], queries: ["barbecue grill", "outdoor grill cooking"], accept: ["grill", "barbecue", "bbq", "grilling", "smoker"] },
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
    if (rule) return { key: `product-type:${rule.key}`, label: rule.label, queries: rule.queries, accept: rule.accept, competing: competingWords(rule) };
  }
  return null;
}

/** Single words that name OTHER product types (minus this type's own words and allowed companions). */
function competingWords(rule: TypeRule): string[] {
  const own = new Set([...rule.accept, ...rule.match.flatMap((m) => tokenize(m)), ...(rule.allowWith ?? [])]);
  const generic = new Set(["bag", "light", "air", "machine", "pack", "watch", "display", "beam", "arc", "buds", "flip", "fold", "s", "edge"]);
  return [...new Set(TYPES.filter((t) => t.key !== rule.key).flatMap((t) => t.match.filter((m) => !m.includes(" ")).map((m) => m.toLowerCase())))].filter((w) => !own.has(w) && !generic.has(w));
}

/** Every query the product-type topics can issue (for the test stub). */
export const PRODUCT_TYPE_QUERIES: string[] = [...new Set(TYPES.flatMap((t) => t.queries))];

/** Words too ambiguous to name a product type when read from free text (a description). */
const AMBIGUOUS_IN_PROSE = new Set(["watch", "display", "monitor", "phone", "mouse", "light", "beam", "arc", "buds", "fold", "flip", "bottle", "mug", "coffee", "tote", "sling", "spinner", "console", "controller", "tv", "wallet", "drill", "mixer", "pillow", "smoker", "spf", "nas", "galaxy", "pixel", "moto", "crescent", "flask"]);

/** The product type a piece of prose names first (earliest mention), ignoring ambiguous words. */
function typeNamedFirst(text: string): TypeRule | null {
  const padded = ` ${tokenize(text).join(" ")} `;
  let best: { rule: TypeRule; at: number } | null = null;
  for (const rule of TYPES) {
    for (const m of rule.match) {
      if (AMBIGUOUS_IN_PROSE.has(m)) continue;
      const at = padded.indexOf(` ${tokenize(m).join(" ")} `);
      if (at >= 0 && (!best || at < best.at)) best = { rule, at };
    }
  }
  return best?.rule ?? null;
}

const topicOf = (rule: TypeRule): ImageTopic => ({ key: `product-type:${rule.key}`, label: rule.label, queries: rule.queries, accept: rule.accept, competing: competingWords(rule) });

/** A product type named by a category label or breadcrumbs ("Headsets", "Blenders", "flashlights"); plurals are read too. */
export function typeTopicFromCrumbs(text: string | null | undefined): ImageTopic | null {
  if (!text?.trim()) return null;
  const words = tokenize(text.replace(/[-_]/g, " "));
  const padded = ` ${words.join(" ")} `;
  const singular = ` ${words.map((w) => (w.length > 3 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).join(" ")} `;
  const rule = TYPES.find((r) => r.match.some((m) => contains(padded, m) || contains(singular, m)));
  return rule ? topicOf(rule) : null;
}

/** The first product type a text names (ambiguous words such as "watch", "phone" or "display" ignored). */
export function typeTopicFromProse(text: string | null | undefined): ImageTopic | null {
  if (!text?.trim()) return null;
  const rule = typeNamedFirst(text.slice(0, 1500));
  return rule ? topicOf(rule) : null;
}

/** For a single-product page whose name and title state no type: its subcategory, else its own text. */
export function productTypeTopicFromContent(input: { subcategorySlug?: string | null; prose?: string | null }): ImageTopic | null {
  return typeTopicFromCrumbs(input.subcategorySlug) ?? typeTopicFromProse(input.prose);
}

/** The product type a stored stock photo was searched for (its query is one of that type's queries), or null. */
export function productTypeTopicForQuery(query: string | null | undefined): ImageTopic | null {
  const q = query?.trim().toLowerCase();
  if (!q) return null;
  const rule = TYPES.find((r) => r.queries.some((x) => x.toLowerCase() === q));
  return rule ? topicOf(rule) : null;
}

export type CommerceTopicBasis = "name" | "page-category" | "description" | "category";
export type CommerceTopic = { topic: ImageTopic; basis: CommerceTopicBasis; imageType: "illustrative-product-type" | "illustrative-category" };

/**
 * The image topic for a commerce product (a deal card), read from what the product's own page states:
 *   1. its name ("EcoTank ET-15000 … Printer" → a printer),
 *   2. the page's own category / breadcrumbs ("Headsets", "Blenders"),
 *   3. the first product type its description names (ambiguous words such as "watch" or "phone" ignored),
 *   4. the brand's category, only when the brand has exactly one (Epson → printers), as a category topic.
 * Null when none of these names a type: the card then shows the neutral category image, never a guess.
 */
export function commerceProductTopic(input: { name: string; pageCategory?: string | null; breadcrumbs?: string[] | null; description?: string | null; brandCategories?: string[] | null }): CommerceTopic | null {
  const byName = productTypeTopic({ productName: input.name });
  if (byName) return { topic: byName, basis: "name", imageType: "illustrative-product-type" };
  const crumbs = typeTopicFromCrumbs([input.pageCategory ?? "", ...(input.breadcrumbs ?? []).slice(-3)].filter(Boolean).join(" / "));
  if (crumbs) return { topic: crumbs, basis: "page-category", imageType: "illustrative-product-type" };
  const prose = typeTopicFromProse(input.description?.slice(0, 400));
  if (prose) return { topic: prose, basis: "description", imageType: "illustrative-product-type" };
  const cats = [...new Set(input.brandCategories ?? [])];
  if (cats.length === 1) {
    const t = imageTopic({ title: "", productName: "", categorySlug: cats[0] });
    if (t) return { topic: t, basis: "category", imageType: "illustrative-category" };
  }
  return null;
}
