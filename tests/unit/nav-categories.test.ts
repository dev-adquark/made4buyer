import { describe, expect, it, vi } from "vitest";

// Only the pure filter is exercised here; keep the import free of Prisma and Next caches.
vi.mock("@/lib/public/queries", () => ({ categoryCounts: async () => [] }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));

const { filterNavCategories } = await import("@/lib/public/nav-categories");

const cat = (slug: string, department: string) => ({ slug, department });
const departments = (list: Array<{ department: string }>) => [...new Set(list.map((c) => c.department))];

describe("filterNavCategories", () => {
  const taxonomy = [cat("laptops", "tech"), cat("phones", "tech"), cat("mattresses", "home"), cat("cookware", "kitchen"), cat("blenders", "kitchen"), cat("audio", "tech")];

  it("keeps only non-empty categories in taxonomy order, regardless of slug-set order", () => {
    expect(filterNavCategories(taxonomy, ["audio", "blenders", "phones"]).map((c) => c.slug)).toEqual(["phones", "blenders", "audio"]);
  });

  it("drops departments that have no remaining categories and keeps department order", () => {
    const visible = filterNavCategories(taxonomy, new Set(["blenders", "phones"]));
    expect(departments(visible)).toEqual(["tech", "kitchen"]);
    expect(departments(visible)).not.toContain("home");
  });

  it("returns nothing when no category has published content, and ignores unknown slugs", () => {
    expect(filterNavCategories(taxonomy, [])).toEqual([]);
    expect(filterNavCategories(taxonomy, ["not-a-category"])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const copy = structuredClone(taxonomy);
    filterNavCategories(taxonomy, ["phones"]);
    expect(taxonomy).toEqual(copy);
  });
});
