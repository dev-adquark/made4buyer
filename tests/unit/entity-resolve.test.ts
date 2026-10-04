import { describe, expect, it } from "vitest";
import {
  detectContentKind,
  entityKey,
  parseComparisonTitle,
} from "@/lib/entities/resolve";

describe("comparison titles", () => {
  it.each([
    [
      "tmux vs Zellij vs WezTerm vs Screen (2026)",
      ["tmux", "Zellij", "WezTerm", "Screen"],
    ],
    [
      "Ghostty vs iTerm2 (2026): Which Mac Terminal Wins?",
      ["Ghostty", "iTerm2"],
    ],
    [
      "Temporal vs Inngest vs Trigger.dev vs BullMQ 2026",
      ["Temporal", "Inngest", "Trigger.dev", "BullMQ"],
    ],
    [
      "LaunchDarkly vs Unleash vs GrowthBook vs PostHog 2026",
      ["LaunchDarkly", "Unleash", "GrowthBook", "PostHog"],
    ],
    [
      "Snyk vs Dependabot vs Renovate vs Socket 2026",
      ["Snyk", "Dependabot", "Renovate", "Socket"],
    ],
    [
      "Doppler vs Infisical vs 1Password Secrets 2026",
      ["Doppler", "Infisical", "1Password Secrets"],
    ],
    [
      "Vercel vs Cloudflare Pages (2026): Speed, Pricing, DX",
      ["Vercel", "Cloudflare Pages"],
    ],
    [
      "Neon vs Supabase Postgres 2026: Which Should You Choose?",
      ["Neon", "Supabase Postgres"],
    ],
    ["Cursor vs Windsurf (2026): AI Editor Comparison", ["Cursor", "Windsurf"]],
    ["Clerk vs Auth0 (2026): Head-to-Head Comparison", ["Clerk", "Auth0"]],
    ["iPhone 17 Pro versus Pixel 10 Pro", ["iPhone 17 Pro", "Pixel 10 Pro"]],
  ])("%s", (title, parts) => {
    expect(parseComparisonTitle(title)).toEqual(parts);
    expect(detectContentKind(title).kind).toBe("COMPARISON");
  });

  it("does not misread headlines that merely contain 'vs'", () => {
    expect(
      parseComparisonTitle(
        "NordVPN Review 2026 [Features, Security, Pricing & More]",
      ),
    ).toBeNull();
    expect(
      parseComparisonTitle(
        "Why the battle of streaming services vs cable TV is over for most households in America",
      ),
    ).toBeNull();
    expect(parseComparisonTitle("Apple vs apple (2026)")).toBeNull();
  });
});

describe("content kinds", () => {
  it.each([
    ["The 7 Best VPNs for Streaming in 2026", "BUYING_GUIDE"],
    ["Best budget laptops for students", "BUYING_GUIDE"],
    ["Mattress buying guide: what actually matters", "BUYING_GUIDE"],
    ["5 ClickUp alternatives worth a look", "BUYING_GUIDE"],
    ["NordVPN Review 2026 [Features, Security, Pricing & More]", "REVIEW"],
    ["Sony WH-1000XM6 review", "REVIEW"],
  ])("%s → %s", (title, kind) =>
    expect(detectContentKind(title).kind).toBe(kind),
  );
});

describe("entity identity", () => {
  it("resolves spelling variants to one key", () => {
    expect(entityKey("NordVPN")).toBe(entityKey("Nord VPN"));
    expect(entityKey("nordvpn")).toBe(entityKey("Nord-VPN"));
    expect(entityKey("Cursor (2026)")).toBe(entityKey("cursor"));
    expect(entityKey("1Password")).not.toBe(entityKey("Password"));
  });
});
