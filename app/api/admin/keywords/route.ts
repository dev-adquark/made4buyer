import { adminAction, field } from "@/lib/admin/route";
import { createKeyword, importKeywords, publishKeywordNow, runKeywordNow, setKeywordEnabled, updateKeyword, validateKeywordInput } from "@/lib/automation/keywords";
import { jobOutcome } from "@/lib/jobs/registry";
import { LockHeldError } from "@/lib/jobs/lock";

export const dynamic = "force-dynamic";
// "Publish now" waits for one Keyword-to-Blog generation (up to ~4.5 minutes).
export const maxDuration = 300;

const PAGE = "/admin/keywords";

/** Admin → Keywords: create | update | enable | disable | run-now | publish-now | import. Every change is audited. */
export const POST = adminAction(PAGE, async ({ form, ctx }) => {
  const action = field(form, "action");
  const id = field(form, "id");
  const get = (n: string) => field(form, n);

  if (action === "create") {
    const v = validateKeywordInput({ keyword: get("keyword"), kind: get("kind"), categorySlug: get("categorySlug"), priority: get("priority"), frequency: get("frequency"), enabled: get("enabledPresent") ? (get("enabled") ? "true" : "false") : undefined });
    if (!v.ok) return { error: v.error };
    const r = await createKeyword(v.value, ctx);
    if (!r.ok) return { error: r.error };
    return { ok: `"${r.value.topic}" scheduled (${r.value.frequency.toLowerCase().replace("_", " ")}): due at the next ${r.value.kind === "ARTICLE" ? "evening" : "morning"} slot` };
  }

  if (action === "update") {
    const r = await updateKeyword(id, { keyword: get("keyword") || undefined, kind: get("kind") || undefined, categorySlug: get("categorySlug") || undefined, priority: get("priority") || undefined, frequency: get("frequency") || undefined, enabled: get("enabledPresent") ? (get("enabled") ? "true" : "false") : undefined }, ctx);
    if (!r.ok) return { error: r.error };
    return { ok: `"${r.value.topic}" saved` };
  }

  if (action === "enable" || action === "disable") {
    const r = await setKeywordEnabled(id, action === "enable", ctx);
    if (!r.ok) return { error: r.error };
    return { ok: `"${r.value.topic}" ${action}d` };
  }

  if (action === "run-now") {
    const r = await runKeywordNow(id, ctx);
    if (!r.ok) return { error: r.error };
    return { ok: `"${r.value.topic}" is due: it runs at the next ${r.value.key.startsWith("article:") ? "evening" : "morning"} slot (the daily cadence still applies)${r.value.enabled ? "" : ", once enabled"}` };
  }

  if (action === "publish-now") {
    try {
      const result = await publishKeywordNow(id, ctx);
      const outcome = jobOutcome(result);
      if (!outcome.ran) return { error: `Not published: ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`, json: { ok: false, result } };
      return { ok: `Published: ${result.topic ?? ""}${result.reviewSlug ? ` (/review/${result.reviewSlug})` : ""}`, json: { ok: true, result } };
    } catch (error) {
      if (error instanceof LockHeldError) return { error: "The daily-article job is running right now; try again in a few minutes" };
      throw error;
    }
  }

  if (action === "import") {
    const r = await importKeywords(get("keywords"), { kind: get("kind"), categorySlug: get("categorySlug"), priority: get("priority"), frequency: get("frequency"), enabled: "true" }, ctx);
    if (!r.ok) return { error: r.error };
    const v = r.value;
    const invalid = v.invalid.length ? `; ${v.invalid.length} invalid (${v.invalid.map((i) => `${i.line}: ${i.error}`).join("; ").slice(0, 150)})` : "";
    return { ok: `Imported ${v.created} keyword(s); ${v.duplicates} exact repeat(s) skipped of ${v.total}${invalid}`, json: { ok: true, ...v } };
  }

  return { error: `Unknown action: ${action || "(none)"}` };
});
