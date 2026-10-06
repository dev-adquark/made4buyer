import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const { reviewRevalidationTargets, revalidateReviewPaths } = await import("@/lib/pipeline/revalidate-paths");

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("public pages are cacheable (ISR)", () => {
  const cached = ["app/page.tsx", "app/product/[slug]/page.tsx", "app/brand/[slug]/page.tsx", "app/review/[slug]/page.tsx"];
  it.each(cached)("%s revalidates every 5 minutes and never opts into dynamic rendering", (file) => {
    const s = src(file);
    expect(s).toMatch(/^export const revalidate = 300;$/m);
    // Any of these makes a page dynamic (Cache-Control: private, no-store).
    expect(s).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(\)|noStore|draftMode/);
  });
  it.each(["app/product/[slug]/page.tsx", "app/brand/[slug]/page.tsx", "app/review/[slug]/page.tsx"])("%s prebuilds nothing (rendered and cached on first request)", (file) => {
    expect(src(file)).toMatch(/generateStaticParams\(\)[^\n]*\n\s*return \[\];/);
    expect(src(file)).not.toMatch(/dynamicParams = false/);
  });
  it("the root layout and template stay static (no per-request APIs in the shell)", () => {
    for (const file of ["app/layout.tsx", "app/template.tsx"]) expect(src(file)).not.toMatch(/cookies\(|headers\(\)|connection\(|searchParams|force-dynamic/);
  });
});

describe("on-demand revalidation", () => {
  it("purges every cached page a review appears on", () => {
    expect(reviewRevalidationTargets({ slug: "x-review", categorySlug: "laptops", brandSlug: "acme" })).toEqual(
      expect.arrayContaining([{ path: "/review/x-review" }, { path: "/" }, { path: "/category/laptops" }, { path: "/brand/acme" }, { path: "/product/[slug]", type: "page" }]),
    );
    expect(reviewRevalidationTargets({ slug: "y" }).some((t) => t.path.startsWith("/category/") || t.path.startsWith("/brand/"))).toBe(false);
  });
  it("calls revalidatePath for each target and tolerates a missing request context", () => {
    revalidatePath.mockClear();
    revalidateReviewPaths({ slug: "x-review", brandSlug: "acme" });
    expect(revalidatePath).toHaveBeenCalledWith("/", undefined);
    expect(revalidatePath).toHaveBeenCalledWith("/brand/acme", undefined);
    expect(revalidatePath).toHaveBeenCalledWith("/product/[slug]", "page");
    revalidatePath.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => revalidateReviewPaths({ slug: "x-review" })).not.toThrow();
  });
});
