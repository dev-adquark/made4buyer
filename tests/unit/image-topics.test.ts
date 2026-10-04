import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageTopic, photoMatchesTopic } from "@/lib/pipeline/image-topics";
import { placeholderPath } from "@/lib/pipeline/images";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

const t = (title: string, productName: string, categorySlug: string, subcategorySlug?: string) => imageTopic({ title, productName, categorySlug, subcategorySlug })?.key;

describe("illustrative image topics", () => {
  it("maps each published review to its real subject", () => {
    expect(t("NordVPN Review 2026", "NordVPN", "productivity-software", "vpns")).toBe("vpn");
    expect(t("Surfshark VPN Review 2026", "Surfshark VPN", "productivity-software", "vpns")).toBe("vpn");
    expect(t("pCloud Review", "pCloud", "productivity-software", "cloud-storage")).toBe("cloud-storage");
    expect(t("Sync.com Review", "Sync.com", "productivity-software", "cloud-storage")).toBe("cloud-storage");
    expect(t("Icedrive Review in 2026", "Icedrive", "productivity-software", "cloud-storage")).toBe("cloud-storage");
    expect(t("Vercel vs Cloudflare Pages (2026)", "Vercel vs Cloudflare Pages (2026)", "developer-software")).toBe("deployment");
    expect(t("Neon vs Supabase Postgres 2026", "Neon vs Supabase Postgres 2026", "developer-software")).toBe("database");
    expect(t("Cursor vs Windsurf (2026): AI Editor Comparison", "Cursor vs Windsurf (2026)", "developer-software")).toBe("ai-coding");
    expect(t("tmux vs Zellij vs WezTerm vs Screen (2026)", "tmux vs Zellij", "developer-software")).toBe("terminal");
    expect(t("Clerk vs Auth0 (2026)", "Clerk vs Auth0 (2026)", "developer-software")).toBe("auth-secrets");
  });

  it("never applies software topics to hardware reviews", () => {
    expect(t("Logitech MX Master 4 review: precise cursor control", "MX Master 4", "accessories")).toBe("category:accessories");
    expect(t("Anker charger review", "Anker Nano", "accessories")).toBe("category:accessories");
  });

  it("only accepts photos whose description is about the topic", () => {
    const vpn = imageTopic({ title: "NordVPN", productName: "NordVPN", categorySlug: "productivity-software" })!;
    expect(photoMatchesTopic("Padlock on a laptop keyboard, cyber security concept", vpn)).toBe(true);
    expect(photoMatchesTopic("Woman smiling in a park", vpn)).toBe(false);
  });

  it("has a real placeholder file for every category (no 404 fallbacks)", () => {
    for (const c of [...CATEGORIES.map((c) => c.slug), null]) {
      const file = path.join(process.cwd(), "public", placeholderPath(c));
      expect(existsSync(file), file).toBe(true);
    }
  });
});
