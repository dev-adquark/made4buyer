/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded commas and
 * newlines, CRLF/LF line endings, UTF-8 BOM. Returns a precise error on malformed input.
 */

export type CsvParseResult = { ok: true; rows: string[][] } | { ok: false; error: string };

export function parseCsv(input: string, opts: { maxRows?: number; maxFieldLength?: number } = {}): CsvParseResult {
  const maxRows = opts.maxRows ?? Infinity;
  const maxField = opts.maxFieldLength ?? 10_000;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes("\u0000")) return { ok: false, error: "File contains NUL bytes; not a text CSV" };

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let fieldStartLine = 1;

  const endField = () => {
    if (field.length > maxField) throw new Error(`Field on line ${fieldStartLine} exceeds ${maxField} characters`);
    row.push(field);
    field = "";
    fieldStartLine = line;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error(`More than ${maxRows} rows`);
  };

  try {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else {
          if (ch === "\n") line++;
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        if (field.length > 0) return { ok: false, error: `Unexpected quote inside unquoted field on line ${line}` };
        inQuotes = true;
      } else if (ch === ",") endField();
      else if (ch === "\r") {
        if (text[i + 1] === "\n") i++;
        endRow();
        line++;
      } else if (ch === "\n") {
        endRow();
        line++;
      } else field += ch;
    }
    if (inQuotes) return { ok: false, error: `Unterminated quoted field starting on line ${fieldStartLine}` };
    if (field.length > 0 || row.length > 0) endRow();
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, rows };
}

export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formula injection in exported reports.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}
