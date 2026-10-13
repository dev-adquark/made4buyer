import { describe, expect, it } from "vitest";
import { factsDiffer } from "@/components/compare-table";

describe("compare: which facts differ", () => {
  it("equal facts do not differ, whatever the case or spacing", () => {
    expect(factsDiffer(["Laptop", "laptop"])).toBe(false);
    expect(factsDiffer(["Fitness  Equipment ", "fitness equipment"])).toBe(false);
  });
  it("different facts differ", () => {
    expect(factsDiffer(["$99.00", "$149.00"])).toBe(true);
    expect(factsDiffer(["iOS", "Android", "iOS"])).toBe(true);
  });
  it("a missing value never counts as a difference (it is shown as Not stated)", () => {
    expect(factsDiffer(["iOS", null])).toBe(false);
    expect(factsDiffer([null, undefined, ""])).toBe(false);
    expect(factsDiffer(["iOS", null, "Android"])).toBe(true);
  });
});
