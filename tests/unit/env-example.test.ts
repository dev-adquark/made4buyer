import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// .env.example is committed (and the repository is public): secret-looking variables must stay empty.
describe(".env.example", () => {
  it("contains no secret values", () => {
    const leaks = readFileSync(".env.example", "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)="([^"]*)"/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .filter(([, name, value]) => /(KEY|SECRET|PASSWORD|TOKEN|_JSON)$/.test(name) && value !== "")
      .map(([, name]) => name);
    expect(leaks).toEqual([]);
  });
});
