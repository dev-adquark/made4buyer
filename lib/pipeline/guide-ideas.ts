import { isTechCategory, type Opportunity } from "@/lib/content/calendar";
import { CATEGORY_BY_SLUG, DEPARTMENTS } from "@/lib/taxonomy/definitions";

/**
 * Keyword-to-Blog request topics, built only from the site's taxonomy and reviewed products:
 * names and buying intents, never third-party text. The provider's post is published as returned.
 */

export function guideKeywords(productName: string, categoryName?: string): string[] {
  const base = [`${productName} worth buying`, `${productName} alternatives`, `${productName} vs`];
  return categoryName ? [...base, `best ${categoryName.toLowerCase()}`] : base;
}

/** What to ask Keyword-to-Blog for, per opportunity. Only names and intents: never source text. */
export function guideRequestFor(o: Opportunity, articleType: "GUIDE" | "ARTICLE" = "GUIDE") {
  const cat = CATEGORY_BY_SLUG.get(o.categorySlug);
  const dept = cat ? DEPARTMENTS.find((d) => d.slug === cat.department)?.name : undefined;
  const industry = cat ? (isTechCategory(cat) ? "consumer technology" : `consumer products: ${(dept ?? cat.name).toLowerCase()}`) : "consumer products";
  const audience = `shoppers choosing ${cat ? cat.name.toLowerCase() : "products"} before they buy`;
  // An informational article: what to know, common mistakes, how it works. Not a "best of" list.
  if (articleType === "ARTICLE") {
    const s = o.subject.toLowerCase();
    return { productName: o.subject, brand: o.brand ?? undefined, category: cat?.name, keywords: [`what to know before buying ${s}`, `${s} explained`, `${s} common mistakes`], topic: `What to know before buying ${s}: common mistakes and how to avoid them`, audience, industry, articleType };
  }
  if (o.kind === "CATEGORY_GUIDE") {
    const s = o.subject.toLowerCase();
    return { productName: o.subject, category: cat?.name, keywords: [`how to choose ${s}`, `${s} buying guide`, `best ${s}`], topic: `How to choose ${s}: what actually matters before you buy`, audience, industry, articleType };
  }
  return { productName: o.subject, brand: o.brand ?? undefined, category: cat?.name, keywords: guideKeywords(o.subject, cat?.name), audience, industry, articleType };
}
