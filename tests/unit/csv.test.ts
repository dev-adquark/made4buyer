import { describe, expect, it } from "vitest";
import { validateUpload } from "@/lib/csv/import";
import { csvEscape, parseCsv, toCsv } from "@/lib/csv/parse";

describe("CSV parser", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const r = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n1,,3\n');
    expect(r).toEqual({ ok: true, rows: [["a", "b", "c"], ["x, y", 'he said "hi"', "multi\nline"], ["1", "", "3"]] });
  });
  it("reports malformed input precisely", () => {
    expect(parseCsv('a,b\n"unterminated,1')).toMatchObject({ ok: false, error: expect.stringMatching(/Unterminated quoted field/) });
    expect(parseCsv('a,b\nx"y,1')).toMatchObject({ ok: false, error: expect.stringMatching(/Unexpected quote/) });
    expect(parseCsv("a\u0000b")).toMatchObject({ ok: false });
    expect(parseCsv("a\n1\n2\n3", { maxRows: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/More than 2 rows/) });
  });
  it("neutralises formula injection in exported reports", () => {
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(toCsv(["h"], [["v"]])).toBe("h\r\nv\r\n");
  });
});

describe("CSV upload validation", () => {
  const file = (name = "o.csv", size = 100, type = "text/csv") => ({ name, size, type });
  it("accepts a valid header", () => {
    const v = validateUpload(file(), "normalized_review_key,override_primary_category\nabc,phones\n");
    expect(v.ok).toBe(true);
  });
  it("rejects missing/unknown/duplicate columns, bad types and empty files", () => {
    expect(validateUpload(file(), "override_primary_category\nphones")).toMatchObject({ ok: false, errors: [expect.stringMatching(/Missing required column/)] });
    expect(validateUpload(file(), "normalized_review_key\nabc")).toMatchObject({ ok: false });
    expect((validateUpload(file(), "normalized_review_key,override_primary_category,evil\nabc,phones,1") as { errors: string[] }).errors.join()).toMatch(/Unknown column/);
    expect((validateUpload(file(), "normalized_review_key,entity_brand_override,entity_brand_override\na,b,c") as { errors: string[] }).errors.join()).toMatch(/Duplicate column/);
    expect(validateUpload(file("o.xlsx"), "x").ok).toBe(false);
    expect(validateUpload(file("o.csv", 100, "image/png"), "x").ok).toBe(false);
    expect(validateUpload(file("o.csv", 50_000_000), "x").ok).toBe(false);
    expect(validateUpload(file("o.csv", 0), "").ok).toBe(false);
    expect(validateUpload(file(), "normalized_review_key,override_primary_category\n")).toMatchObject({ ok: false, errors: [expect.stringMatching(/no data rows/)] });
  });
});
