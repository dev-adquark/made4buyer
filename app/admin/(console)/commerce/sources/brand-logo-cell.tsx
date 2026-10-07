import type { CommerceBrand } from "@prisma/client";
import { ActionForm, Badge, safeHref, when } from "@/components/admin-ui";
import LogoChip from "@/components/brand-logo-chip";
import { publicLogo } from "@/lib/commerce/brand-logo-public";

export const LOGO_API = "/api/admin/commerce/brand-logo";

const SOURCE_LABEL: Record<string, string> = {
  "official-jsonld": "Official site (JSON-LD)",
  "official-icon": "Official site (icon)",
  "wikidata-commons": "Wikidata → Commons",
  "admin-url": "Admin override",
};

/** Admin → Sources: the brand's official logo chip, provenance, status/reason, Re-check, and the override form. */
export default function BrandLogoCell({ b, returnTo }: { b: CommerceBrand; returnTo: string }) {
  const logo = publicLogo(b);
  const tone = b.logoStatus === "VERIFIED" ? "ok" : b.logoStatus === "FAILED" || b.logoStatus === "REJECTED" ? "error" : b.logoStatus === "NOT_FOUND" ? "warn" : "neutral";
  return (
    <div className="small">
      <div>
        <LogoChip logo={logo} name={b.name} height={24} monogram />
        <Badge value={b.logoStatus ?? "NOT CHECKED"} tone={tone} />
        {b.logoLocked && <Badge value="LOCKED" tone="info" />}
      </div>
      {b.logoSource && <div className="muted">{SOURCE_LABEL[b.logoSource] ?? b.logoSource}</div>}
      {b.logoUrl && (
        <div className="muted" style={{ wordBreak: "break-all" }}>
          <a href={safeHref(b.logoUrl)} rel="noopener noreferrer nofollow" target="_blank">
            {(() => {
              try {
                return new URL(b.logoUrl).hostname;
              } catch {
                return "file";
              }
            })()}
          </a>
          {b.logoWidth && b.logoHeight ? ` · ${b.logoWidth}×${b.logoHeight}` : ""}
          {b.logoMime ? ` · ${b.logoMime.replace("image/", "")}` : ""}
          {b.logoSourceUrl && (
            <>
              {" · "}
              <a href={safeHref(b.logoSourceUrl)} rel="noopener noreferrer nofollow" target="_blank">
                source
              </a>
            </>
          )}
        </div>
      )}
      {b.logoLicense && <div className="muted">Licence: {b.logoLicense}</div>}
      {b.logoReason && <div className="muted">{b.logoReason.slice(0, 240)}</div>}
      {b.logoCheckedAt && <div className="muted">checked {when(b.logoCheckedAt)}</div>}
      <details>
        <summary>Logo actions</summary>
        <div className="btnrow" style={{ margin: "4px 0" }}>
          <ActionForm action={LOGO_API} fields={{ id: b.id, action: "recheck" }} label="Re-check logo" returnTo={returnTo} disabledReason={b.logoLocked ? "Locked by an admin override: unlock first" : undefined} />
          {b.logoLocked && <ActionForm action={LOGO_API} fields={{ id: b.id, action: "unlock" }} label="Unlock" returnTo={returnTo} />}
        </div>
        <form action={LOGO_API} method="post" className="inline-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="action" value="override" />
          <input type="hidden" name="id" value={b.id} />
          <label className="visually-hidden" htmlFor={`logo-url-${b.id}`}>
            Logo URL for {b.name}
          </label>
          <input id={`logo-url-${b.id}`} name="logoUrl" type="url" required maxLength={2000} placeholder={`https://…${b.officialDomain.replace(/^www\./, "")}/logo.svg or upload.wikimedia.org`} style={{ maxWidth: 220 }} />
          <button className="btn small" type="submit">
            Override
          </button>
        </form>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Only a file on {b.officialDomain.replace(/^www\./, "")} (or its subdomains) or a Wikimedia Commons file; it is fetched and checked like any logo, then locked.
        </p>
      </details>
    </div>
  );
}
