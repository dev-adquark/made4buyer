// Generates lib/reports/release-notes.json from git history (used by the Day-30 report's
// "Fixes shipped" section). Falls back to Vercel commit metadata, then to an empty list.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = new URL("../lib/reports/release-notes.json", import.meta.url);
let notes = { source: "unavailable", changes: [] };
try {
  const log = execFileSync("git", ["log", "-n", "200", "--date=iso-strict", "--pretty=format:%h%x1f%ad%x1f%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const changes = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split("\x1f");
      return { sha, date, subject };
    })
    .filter((c) => /^(fix|feat|perf|security|revert)(\(.+\))?!?:/i.test(c.subject));
  notes = { source: "git", changes };
} catch {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    notes = {
      source: "vercel-metadata",
      changes: [{ sha: process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7), date: new Date().toISOString(), subject: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? "" }],
    };
  }
}
writeFileSync(out, JSON.stringify(notes, null, 2) + "\n");
console.log(`release notes: ${notes.changes.length} change(s) from ${notes.source}`);
