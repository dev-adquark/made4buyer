import { sovrnApprovalStatus } from "@/lib/sovrn/account";

/** Admin warning until Sovrn has approved the site: live from the Sovrn Campaigns API, else SOVRN_SITE_STATUS. */
export default async function SovrnStatusNotice() {
  const { status, source, campaign, message } = await sovrnApprovalStatus();
  if (status === "APPROVED") return null;
  const explanation =
    status === "DENIED"
      ? "Sovrn has declined this site, so links will not earn commission and the price API refuses requests. Review the decision in the Sovrn dashboard."
      : status === "PENDING"
        ? "Complete Sovrn’s site review in the Sovrn dashboard. Until the site is approved, Sovrn reports merchants as not affiliatable and the price API refuses requests. Content publishing is unaffected."
        : "The approval status is not known. Check the site in the Sovrn dashboard; until it is approved, Sovrn reports merchants as not affiliatable and the price API refuses requests. Content publishing is unaffected.";
  return (
    <p className={`notice ${status === "DENIED" ? "error" : "warn"}`} role="status">
      Sovrn site status: <strong>{status}</strong>
      {campaign ? ` for campaign “${campaign.name}” (${campaign.campaignId})` : ""} {source === "sovrn-api" ? "(from the Sovrn API)" : "(from SOVRN_SITE_STATUS)"}. {explanation}
      {message ? <span className="small muted"> {source === "env" ? `Live status unavailable: ${message}.` : `${message}.`}</span> : null}
    </p>
  );
}
