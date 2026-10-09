import { describe, expect, it } from "vitest";
import GoogleAnalytics, { gaMeasurementId } from "@/components/google-analytics";
import { withEnv } from "../support/env";

describe("Google Analytics 4", () => {
  it("is off without a valid G- measurement id", () => {
    for (const v of [undefined, "", "UA-12345-1", "G-", "G-abc def", "<script>"]) {
      const r = withEnv({ NEXT_PUBLIC_GA_MEASUREMENT_ID: v });
      expect(gaMeasurementId(), String(v)).toBeNull();
      expect(GoogleAnalytics()).toBeNull();
      r();
    }
  });
  it("renders gtag.js and the config call for a valid id", () => {
    const r = withEnv({ NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-ABC123XYZ9" });
    expect(gaMeasurementId()).toBe("G-ABC123XYZ9");
    const el = GoogleAnalytics() as { props: { children: Array<{ props: { src?: string; children?: string; strategy: string } }> } };
    const [src, init] = el.props.children;
    expect(src.props).toMatchObject({ src: "https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9", strategy: "lazyOnload" });
    expect(init.props.children).toContain("gtag('config','G-ABC123XYZ9')");
    r();
  });
});
