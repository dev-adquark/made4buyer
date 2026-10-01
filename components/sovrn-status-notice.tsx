import { config } from "@/lib/config";

/** Admin warning until the site owner confirms Sovrn has approved the site (never inferred). */
export default function SovrnStatusNotice() {
  const status = config.sovrn.siteStatus();
  if (status === "APPROVED") return null;
  return (
    <p className={`notice ${status === "DENIED" ? "error" : "warn"}`} role="status">
      Sovrn site status: <strong>{status}</strong>.{" "}
      {status === "DENIED"
        ? "Sovrn has declined this site, so offers may not earn commission. Review the decision in the Sovrn dashboard."
        : "Complete Sovrn’s site approval (Network Quality) in the Sovrn dashboard, then set SOVRN_SITE_STATUS to the status it shows. Verified offers still need a working SOVRN_API_KEY."}
    </p>
  );
}
