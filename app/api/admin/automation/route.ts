import { adminAction, field } from "@/lib/admin/route";
import { setSwitch, SWITCHES, type SwitchKey } from "@/lib/automation/settings";

export const dynamic = "force-dynamic";

/** Admin → Automation switches: turn an automated capability on or off (audited). */
export const POST = adminAction("/admin/automation", async ({ form, ctx }) => {
  const key = field(form, "key") as SwitchKey;
  if (!(key in SWITCHES)) return { error: `Unknown switch "${key}"` };
  const on = field(form, "on") === "on";
  await setSwitch(key, on, ctx);
  return { ok: `${SWITCHES[key].label}: ${on ? "on" : "off"}` };
});
