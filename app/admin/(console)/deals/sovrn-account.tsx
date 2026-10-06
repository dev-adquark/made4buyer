import { Badge } from "@/components/admin-ui";
import { fetchSovrnCampaigns } from "@/lib/sovrn/account";

const APPROVAL_TONE = { APPROVED: "ok", PENDING: "warn", DENIED: "error" } as const;

/** Sovrn account overview from the Campaigns API. Read-only; errors are shown, never thrown. */
export async function SovrnAccountSection() {
  let result: Awaited<ReturnType<typeof fetchSovrnCampaigns>>;
  try {
    result = await fetchSovrnCampaigns();
  } catch (e) {
    result = { status: "PROVIDER_ERROR", message: e instanceof Error ? e.message : "Sovrn Campaigns API request failed" };
  }
  return (
    <section aria-labelledby="sovrn-account" style={{ marginBottom: 16 }}>
      <h2 id="sovrn-account">Sovrn account</h2>
      {result.status !== "OK" ? (
        <p className={`notice ${result.status === "UNAVAILABLE" ? "warn" : "error"}`} role="status">
          Sovrn Campaigns API: <strong>{result.status}</strong>
          {result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}. {result.message}
        </p>
      ) : (
        <>
          <p className="small muted">
            Account {result.accountId ?? "—"} · {result.campaigns.length} campaign{result.campaigns.length === 1 ? "" : "s"}. Other campaigns in the same account (for example other sites) are shown read-only; only the campaign using SOVRN_SITE_KEY applies to this site.
          </p>
          {result.campaigns.length === 0 ? (
            <p className="notice warn">This Sovrn account has no campaigns.</p>
          ) : (
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Campaign ID</th>
                    <th scope="col">Approval</th>
                    <th scope="col">Application type</th>
                    <th scope="col">Site key</th>
                  </tr>
                </thead>
                <tbody>
                  {result.campaigns.map((c) => (
                    <tr key={String(c.campaignId)}>
                      <td data-label="Campaign">
                        {c.name}
                        {c.isThisSite && (
                          <>
                            {" "}
                            <Badge value="This site" tone="info" />
                          </>
                        )}
                        {(c.category || c.platform) && <div className="small muted">{[c.category, c.platform].filter(Boolean).join(" · ")}</div>}
                      </td>
                      <td data-label="Campaign ID">{c.campaignId}</td>
                      <td data-label="Approval">
                        <Badge value={c.approvalStatus} tone={APPROVAL_TONE[c.approvalStatus as keyof typeof APPROVAL_TONE] ?? "neutral"} />
                      </td>
                      <td data-label="Application type">{c.applicationType ?? "—"}</td>
                      <td data-label="Site key" className="small muted">
                        {c.siteKeyHint}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!result.campaigns.some((c) => c.isThisSite) && <p className="notice warn">No campaign in this account uses SOVRN_SITE_KEY, so this site&apos;s approval status falls back to SOVRN_SITE_STATUS.</p>}
        </>
      )}
    </section>
  );
}
