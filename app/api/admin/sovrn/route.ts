import { adminAction, field } from "@/lib/admin/route";
import { audit } from "@/lib/security/audit";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { checkLink } from "@/lib/sovrn/link-check";

export const dynamic = "force-dynamic";

/** Admin → Deals: Sovrn tools. `link-check` asks Sovrn whether a merchant URL is monetisable for this site. */
export const POST = adminAction("/admin/deals", async ({ form, admin, ctx }) => {
  const action = field(form, "action");
  if (action !== "link-check") return { error: "Unknown Sovrn action" };
  const url = field(form, "url").slice(0, 2000);
  if (!url) return { error: "Enter a merchant URL to check" };
  const geo = field(form, "geo").slice(0, 2) || undefined;
  if (!memoryRateLimit(`sovrn-link-check:${admin.email}`, 60, 3_600_000)) return { error: "Too many link checks this hour. Try again later." };

  const result = await checkLink(url, { geo, bypassCache: true });
  let host = "invalid";
  try {
    host = new URL(url).hostname || "invalid";
  } catch {
    // keep "invalid"
  }
  await audit(ctx, {
    action: "sovrn.link_check",
    entityType: "url",
    entityId: host,
    metadata: result.status === "OK" ? { affiliatable: result.affiliatable, competitive: result.competitive, eepc: result.eepc, geo: geo ?? null } : { affiliatable: null, status: result.status },
  });
  if (result.status !== "OK") return { error: `Link check (${host}): ${result.message}`, json: result };
  const eepc = result.eepc === null ? "unknown" : `$${result.eepc.toFixed(4)}`;
  const competitive = result.competitive === null ? "unknown" : result.competitive ? "yes" : "no";
  return { ok: `${host} — Affiliatable: ${result.affiliatable ? "yes" : "no"} · EEPC ${eepc} · competitive ${competitive}`, json: { ...result, optimizedUrl: undefined } };
});
