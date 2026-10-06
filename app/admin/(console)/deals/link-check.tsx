import { Badge, when } from "@/components/admin-ui";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { LINK_CHECK_PREFIX, parseLinkCheck, parseLinkCheckQueryKey } from "@/lib/sovrn/link-check";

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 60 ? `${u.pathname.slice(0, 57)}…` : u.pathname;
    return `${u.hostname}${path === "/" ? "" : path}`;
  } catch {
    return raw.slice(0, 80);
  }
}

/** Admin → Deals: ask Sovrn whether a merchant URL can be monetised for this site, plus the latest recorded checks. */
export async function LinkCheckSection() {
  const siteKey = config.sovrn.siteKey();
  const recent = await db.sovrnOfferCache.findMany({
    where: { queryKey: { startsWith: LINK_CHECK_PREFIX } },
    orderBy: { fetchedAt: "desc" },
    take: 10,
    select: { id: true, queryKey: true, fetchedAt: true, providerStatus: true, httpStatus: true, rawResponse: true },
  });
  const disabledReason = siteKey ? undefined : "SOVRN_SITE_KEY is not configured (or holds the secret key)";
  return (
    <>
      <h2>Sovrn link check</h2>
      <p className="muted">
        Asks Sovrn whether it can monetise a merchant URL for this site, with its estimated earnings per click. Until Sovrn approves the site, it answers “not affiliatable” for every merchant.
        {config.sovrn.linkCheckEnabled()
          ? " The pipeline skips wrapping merchant links that Sovrn reports as not affiliatable."
          : " Pipeline gating is off (SOVRN_LINK_CHECK_ENABLED=false)."}
      </p>
      {disabledReason ? (
        <p className="notice warn">Not available: {disabledReason}.</p>
      ) : (
        <form className="toolbar" action="/api/admin/sovrn" method="post">
          <input type="hidden" name="action" value="link-check" />
          <input type="hidden" name="returnTo" value="/admin/deals" />
          <div className="field">
            <label htmlFor="slc-url">Merchant URL</label>
            <input id="slc-url" name="url" type="url" required maxLength={2000} placeholder="https://www.example-store.com/product/123" />
          </div>
          <div className="field">
            <label htmlFor="slc-geo">Country (optional)</label>
            <input id="slc-geo" name="geo" maxLength={2} pattern="[A-Za-z]{2}" placeholder="US" />
          </div>
          <button className="btn primary" type="submit">
            Check link
          </button>
        </form>
      )}
      {recent.length > 0 ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">Affiliatable</th>
                <th scope="col">EEPC</th>
                <th scope="col">Checked</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const { url, geo } = parseLinkCheckQueryKey(r.queryKey);
                const parsed = r.providerStatus === "OK" ? parseLinkCheck(r.rawResponse) : undefined;
                return (
                  <tr key={r.id}>
                    <td data-label="URL">
                      {shortUrl(url)}
                      {geo && <span className="small muted"> ({geo})</span>}
                    </td>
                    <td data-label="Affiliatable">
                      {parsed ? (
                        <Badge value={parsed.affiliatable ? "YES" : "NO"} tone={parsed.affiliatable ? "ok" : "warn"} />
                      ) : (
                        <Badge value={r.httpStatus ? `ERROR ${r.httpStatus}` : "ERROR"} tone="error" />
                      )}
                    </td>
                    <td data-label="EEPC">{parsed?.eepc != null ? `$${parsed.eepc.toFixed(4)}` : "—"}</td>
                    <td data-label="Checked">{when(r.fetchedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">No link checks recorded yet.</p>
      )}
    </>
  );
}
