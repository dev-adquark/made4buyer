import { db } from "@/lib/db";
import { audit, type AuditContext } from "@/lib/security/audit";

/**
 * Admin automation switches: the control centre for the autonomous engine. The engine makes
 * every normal publishing decision itself; these switches only let the owner pause, resume or
 * narrow what it does. A missing row means the coded default.
 */
export const SWITCHES = {
  automation: { label: "Automation (master switch)", help: "Off pauses every scheduled job below. Manual 'Run now' still works.", default: true },
  scheduled_publishing: { label: "Scheduled publishing", help: "Automatic publishing of new posts and QA-passed source reviews.", default: true },
  guides: { label: "Morning guides", help: "08:00 IST Keyword-to-Blog buying guide.", default: true },
  articles: { label: "Evening articles", help: "19:00 IST Keyword-to-Blog informational article.", default: true },
  keyword_to_blog: { label: "Keyword-to-Blog generation", help: "Off stops all generation requests (quota protection).", default: true },
  external_ingestion: { label: "External source ingestion", help: "Apify crawls, collection and the Content API feed.", default: true },
  image_enrichment: { label: "Image enrichment", help: "Daily Pexels image backfill.", default: true },
  affiliate_enrichment: { label: "Affiliate enrichment", help: "Sovrn offer refresh and link verification.", default: true },
  retries: { label: "Automatic retries", help: "Retry of failed pipeline stages.", default: true },
} as const;

export type SwitchKey = keyof typeof SWITCHES;

/** The master default comes from AUTOMATION_ENABLED (default on), so a deploy can start paused. */
function codedDefault(key: SwitchKey): boolean {
  if (key === "automation") {
    const env = (process.env.AUTOMATION_ENABLED ?? "").trim().toLowerCase();
    if (["0", "false", "off", "no"].includes(env)) return false;
  }
  return SWITCHES[key].default;
}

export async function getSwitches(): Promise<Record<SwitchKey, boolean>> {
  const rows = await db.automationSetting.findMany({ where: { key: { in: Object.keys(SWITCHES) } } }).catch(() => []);
  const out = {} as Record<SwitchKey, boolean>;
  for (const key of Object.keys(SWITCHES) as SwitchKey[]) {
    const row = rows.find((r) => r.key === key);
    out[key] = row ? row.value === "on" : codedDefault(key);
  }
  return out;
}

/**
 * Whether a scheduled job may act. Every switch named must be on, and the master switch always
 * applies. Returns the reason when paused, for the job result and the admin timeline.
 */
export async function allowed(...keys: SwitchKey[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = await getSwitches();
  for (const k of ["automation", ...keys] as SwitchKey[]) if (!s[k]) return { ok: false, reason: `paused in Admin → Automation: ${SWITCHES[k].label} is off` };
  return { ok: true };
}

export async function setSwitch(key: SwitchKey, on: boolean, ctx: AuditContext) {
  const before = (await getSwitches())[key];
  await db.automationSetting.upsert({ where: { key }, create: { key, value: on ? "on" : "off", updatedBy: ctx.actor }, update: { value: on ? "on" : "off", updatedBy: ctx.actor } });
  await audit(ctx, { action: `automation.switch.${key}`, entityType: "automation_setting", entityId: key, before: { on: before }, after: { on } });
}
