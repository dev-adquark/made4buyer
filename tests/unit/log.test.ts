import { describe, expect, it } from "vitest";
import { redactString } from "@/lib/log";

describe("redactString pattern fallback (tokens not in the environment)", () => {
  it("redacts query tokens, Apify tokens and bearer headers", () => {
    const out = redactString("GET https://api.example/v2/runs?token=abc123SECRETxyz&x=1 Authorization: Bearer abcdefghijklmnop1234 apify_api_ZZZZZZZZZZZZ");
    expect(out).not.toMatch(/abc123SECRETxyz|abcdefghijklmnop1234|apify_api_Z/);
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("&x=1");
  });
  it("leaves ordinary text alone", () => {
    expect(redactString("Bearer of good news; keyboard key=value")).toBe("Bearer of good news; keyboard key=value");
  });
});
