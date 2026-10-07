import Link from "next/link";
import { notFound } from "next/navigation";
import Flash from "@/components/flash";
import { ActionForm, Badge, pct, when, safeHref } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { publicImageUrl } from "@/lib/pipeline/images";
import { CATEGORIES, categoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review detail" };

export default async function ReviewDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  await requireAdminPage();
  const { id } = await params;
  const sp = await searchParams;
  const r = await db.normalizedReview.findUnique({
    where: { id },
    include: {
      entities: true,
      contentEntities: { orderBy: { position: "asc" }, include: { entity: true } },
      assignments: { orderBy: [{ active: "desc" }, { tagType: "asc" }, { createdAt: "desc" }], include: { categoryTag: true }, take: 40 },
      images: { orderBy: { createdAt: "desc" }, take: 3 },
      contentItems: { orderBy: { fetchedAt: "desc" }, take: 5 },
      publishJobs: { orderBy: { createdAt: "desc" }, take: 10 },
      renderModel: { select: { builtAt: true, modelHash: true } },
    },
  });
  if (!r) notFound();
  const primaryEntityId = r.contentEntities.find((c) => c.role === "PRIMARY")?.productEntityId ?? null;
  const [failures, auditRows, commerceOffers] = await Promise.all([
    db.pipelineFailure.findMany({ where: { normalizedReviewId: id, resolvedAt: null }, orderBy: { lastOccurredAt: "desc" }, take: 20 }),
    db.auditLog.findMany({ where: { entityType: "normalized_review", entityId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    primaryEntityId
      ? db.commerceOffer.findMany({ where: { product: { productEntityId: primaryEntityId } }, orderBy: { observedAt: "desc" }, take: 20, select: { id: true, seller: true, sellerType: true, price: true, currency: true, availability: true, status: true, observedAt: true, destinationUrl: true, affiliateUrl: true, affiliateStatus: true } })
      : Promise.resolve([]),
  ]);
  const self = `/admin/reviews/${id}`;
  const qa = (r.qaFailures as Array<{ code: string; message: string }> | null) ?? [];
  const e = r.entities;
  const conf = (e?.confidences ?? {}) as Record<string, number>;
  const overrides = (e?.overrides ?? {}) as Record<string, { value: string; source: string; actor: string; at: string }>;
  const primaryImage = r.images.find((i) => i.isPrimary);
  const shown = publicImageUrl(primaryImage, r.categorySlug);
  const category = CATEGORIES.find((c) => c.slug === r.categorySlug);

  return (
    <>
      <p className="small">
        <Link href="/admin/qa">← Content status</Link>
      </p>
      <h1>{r.canonicalTitle}</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <div className="btnrow">
        <Badge value={r.status} />
        {r.status === "PUBLISHED" && (
          <Link className="btn small" href={`/review/${r.slug}`} target="_blank">
            View public page
          </Link>
        )}
        {r.status !== "PUBLISHED" && r.status !== "REJECTED" && <ActionForm action="/api/admin/reviews" fields={{ id, action: "publish" }} label="Publish" returnTo={self} className="btn small primary" disabledReason={qa.length ? `QA: ${qa.map((f) => f.code).join(", ")}` : undefined} />}
        {r.status === "PUBLISHED" && <ActionForm action="/api/admin/reviews" fields={{ id, action: "unpublish" }} label="Unpublish" returnTo={self} confirm="Unpublish this review?" />}
        {(r.status === "REJECTED" || r.status === "UNPUBLISHED") && <ActionForm action="/api/admin/reviews" fields={{ id, action: "restore" }} label="Restore" returnTo={self} />}
        {r.status !== "REJECTED" && <ActionForm action="/api/admin/reviews" fields={{ id, action: "reject" }} label="Reject" returnTo={self} confirm="Reject this review?" className="btn small danger" />}
        <ActionForm action="/api/admin/reviews" fields={{ id, action: "reprocess" }} label="Re-run pipeline" returnTo={self} />
      </div>

      {r.kind === "AI_GUIDE" && (
        <section className={`notice ${r.editorApprovedAt ? "ok" : "warn"}`} aria-label="AI-assisted guide">
          <strong>AI-assisted guide.</strong> Drafted by Keyword-to-Blog
          {(() => {
            const g = (r.generationMeta ?? {}) as { model?: string; qualityStatus?: string; qualityScore?: number; requestId?: string };
            return ` (${[g.model, g.qualityStatus && `quality ${g.qualityStatus}${g.qualityScore != null ? ` ${g.qualityScore}` : ""}`, g.requestId].filter(Boolean).join(", ")})`;
          })()}
          {r.source === "keyword-to-blog" ? (
            <>. Published as returned by Keyword-to-Blog (direct-publish mode: no approval or QA step). The site labels it AI-assisted and says no editor reviewed it. To take it down, use Unpublish.</>
          ) : (
            <>
              . Check every factual claim (specs, prices, availability, comparisons) before approving; the site labels it as AI-assisted and never as a hands-on review.
              <div className="btnrow">
                {r.editorApprovedAt ? (
                  <>
                    <span>
                      Approved by {r.editorApprovedBy} on {when(r.editorApprovedAt)}
                    </span>
                    <ActionForm action="/api/admin/reviews" fields={{ id, action: "revoke-guide-approval" }} label="Revoke approval" returnTo={self} confirm="Revoke editor approval? A published guide will be unpublished." className="btn small danger" />
                  </>
                ) : (
                  <ActionForm action="/api/admin/reviews" fields={{ id, action: "approve-guide" }} label="I’ve checked this guide — approve" returnTo={self} className="btn small primary" />
                )}
              </div>
            </>
          )}
        </section>
      )}
      <section aria-labelledby="qa-h">
        <h2 id="qa-h">Publish QA</h2>
        {qa.length ? (
          <ul>
            {qa.map((f) => (
              <li key={f.code}>
                <Badge value={f.code} tone="warn" /> {f.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="notice ok">All QA gates pass.</p>
        )}
        <dl className="kv">
          <dt>Slug</dt>
          <dd>{r.slug}</dd>
          <dt>Dedupe key</dt>
          <dd>
            <code>{r.dedupeKey}</code>
          </dd>
          <dt>Source</dt>
          <dd>
            {r.source} / {r.sourceId} {safeHref(r.sourceUrl) && <a href={safeHref(r.sourceUrl)} target="_blank" rel="noopener noreferrer">source ↗</a>}
          </dd>
          <dt>Confidence</dt>
          <dd>
            entities {pct(r.entityConfidence)} · category {pct(r.classificationConfidence)}
          </dd>
          <dt>Published</dt>
          <dd>{when(r.publishedAt)}</dd>
          <dt>Render model</dt>
          <dd>{r.renderModel ? `built ${when(r.renderModel.builtAt)} (${r.renderModel.modelHash.slice(0, 10)})` : "not built (built at publish)"}</dd>
          <dt>Manual edits</dt>
          <dd>{r.manualEditLocked ? "locked — content updates will not overwrite text" : "none"}</dd>
        </dl>
      </section>

      <section aria-labelledby="edit-h">
        <h2 id="edit-h">Edit content</h2>
        <form action="/api/admin/reviews" method="post" className="card card-body">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="action" value="save" />
          <input type="hidden" name="returnTo" value={self} />
          <div className="field">
            <label htmlFor="f-title">Canonical title</label>
            <input id="f-title" name="canonicalTitle" defaultValue={r.canonicalTitle} required minLength={8} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="f-summary">Summary</label>
            <textarea id="f-summary" name="summary" defaultValue={r.summary} required minLength={20} maxLength={600} rows={3} />
          </div>
          <div className="field">
            <label htmlFor="f-body">Body</label>
            <textarea id="f-body" name="body" defaultValue={r.body} required minLength={120} rows={14} />
            <div className="field-hint">Plain text. Separate paragraphs with a blank line. HTML is not rendered.</div>
          </div>
          <button className="btn primary" type="submit">
            Save
          </button>
        </form>
      </section>

      <section aria-labelledby="ent-h">
        <h2 id="ent-h">Entities</h2>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Entity</th>
                <th scope="col">Value</th>
                <th scope="col" className="num">Confidence</th>
                <th scope="col">Override</th>
              </tr>
            </thead>
            <tbody>
              {(["productName", "brand", "deviceType", "modelNumber", "platform", "useCase", "price", "source", "publishDate"] as const).map((f) => {
                const raw = e ? (e as unknown as Record<string, unknown>)[f] : undefined;
                const value = raw instanceof Date ? when(raw) : raw === null || raw === undefined ? "—" : String(raw);
                const low = e?.lowConfidenceFields.includes(f);
                return (
                  <tr key={f}>
                    <td data-label="Entity">{f}</td>
                    <td data-label="Value">{value}{f === "price" && e?.currency ? ` ${e.currency}` : ""}</td>
                    <td data-label="Confidence" className="num">
                      {low ? <Badge value={pct(conf[f])} tone="warn" /> : pct(conf[f])}
                    </td>
                    <td data-label="Override" className="small">{overrides[f] ? `${overrides[f].source} by ${overrides[f].actor}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form action="/api/admin/reviews" method="post" className="card card-body" style={{ marginTop: 12 }}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="action" value="override-entities" />
          <input type="hidden" name="returnTo" value={self} />
          <div className="form-grid">
            {(["productName", "brand", "modelNumber", "deviceType", "platform", "useCase"] as const).map((f) => (
              <div className="field" key={f}>
                <label htmlFor={`o-${f}`}>{f}</label>
                <input id={`o-${f}`} name={f} defaultValue={overrides[f]?.value ?? ""} placeholder={e ? String((e as unknown as Record<string, unknown>)[f] ?? "") : ""} maxLength={160} />
              </div>
            ))}
          </div>
          <div className="field-hint">Filled fields become overrides (confidence 100%). Clear a field to remove its override. Saving re-runs categorization and the commerce-offer check.</div>
          <div className="btnrow">
            <button className="btn primary" type="submit">
              Save entity overrides
            </button>
          </div>
        </form>
        {e && e.lowConfidenceFields.length > 0 && <ActionForm action="/api/admin/reviews" fields={{ id, action: "confirm-entities" }} label={`Confirm current values of ${e.lowConfidenceFields.join(", ")}`} returnTo={self} />}
      </section>

      <section aria-labelledby="prod-h">
        <h2 id="prod-h">Products in this article</h2>
        <p className="muted small">
          Kind: <Badge value={r.kind} />{" "}
          {r.kind === "COMPARISON" ? "Each compared product is linked below. QA needs at least two." : r.kind === "REVIEW" ? "A review links one primary product." : "Guides list the products they cover."} Links never change the source article. Editor links are kept when the pipeline re-runs, and a product you remove is not re-added.
        </p>
        {r.kind !== "AI_GUIDE" && (
          <form action="/api/admin/reviews" method="post" className="btnrow" style={{ alignItems: "end" }}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="action" value="set-kind" />
            <input type="hidden" name="returnTo" value={self} />
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="kind-sel">Content kind</label>
              <select id="kind-sel" name="kind" defaultValue={((e?.overrides as { contentKind?: string } | null)?.contentKind) ?? ""}>
                <option value="">Automatic (from the title)</option>
                <option value="REVIEW">Review of one product</option>
                <option value="COMPARISON">Comparison of several products</option>
                <option value="BUYING_GUIDE">Buying guide</option>
              </select>
            </div>
            <button className="btn" type="submit">
              Set kind
            </button>
          </form>
        )}
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Role</th>
                <th scope="col">Brand / category</th>
                <th scope="col">Linked by</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {r.contentEntities.map((c) => (
                <tr key={c.id}>
                  <td data-label="Product">
                    <a href={`/product/${c.entity.slug}`}>{c.entity.name}</a>
                    {c.entity.aliases.length > 0 && <div className="small muted">aka {c.entity.aliases.join(", ")}</div>}
                  </td>
                  <td data-label="Role">{c.role}</td>
                  <td data-label="Brand / category" className="small">
                    {c.entity.brand ?? "—"} / {c.entity.categorySlug ?? "—"}
                    {c.entity.subcategorySlug ? ` → ${c.entity.subcategorySlug}` : ""}
                  </td>
                  <td data-label="Linked by">
                    {c.source} {c.source === "AUTO" ? `(${pct(c.confidence)})` : ""}
                  </td>
                  <td data-label="Actions">
                    <ActionForm action="/api/admin/reviews" fields={{ id, action: "entity-remove", entityId: c.productEntityId }} label="Remove" returnTo={self} />
                    <details className="small">
                      <summary>Edit product</summary>
                      <form action="/api/admin/reviews" method="post">
                        <input type="hidden" name="id" value={id} />
                        <input type="hidden" name="action" value="entity-update" />
                        <input type="hidden" name="entityId" value={c.productEntityId} />
                        <input type="hidden" name="returnTo" value={self} />
                        <div className="field">
                          <label htmlFor={`en-${c.id}`}>Name</label>
                          <input id={`en-${c.id}`} name="name" defaultValue={c.entity.name} maxLength={120} />
                        </div>
                        <div className="field">
                          <label htmlFor={`eb-${c.id}`}>Brand</label>
                          <input id={`eb-${c.id}`} name="brand" defaultValue={c.entity.brand ?? ""} maxLength={80} />
                        </div>
                        <div className="field">
                          <label htmlFor={`ec-${c.id}`}>Category</label>
                          <select id={`ec-${c.id}`} name="categorySlug" defaultValue={c.entity.categorySlug ?? ""}>
                            <option value="">None</option>
                            {CATEGORIES.map((cat) => (
                              <option key={cat.slug} value={cat.slug}>
                                {cat.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor={`es-${c.id}`}>Subcategory slug (optional)</label>
                          <input id={`es-${c.id}`} name="subcategorySlug" defaultValue={c.entity.subcategorySlug ?? ""} pattern="[a-z0-9-]{0,60}" />
                        </div>
                        <p className="field-hint">This edits the shared product, so every article that links it changes. A rename keeps the old name as an alias.</p>
                        <button className="btn small" type="submit">
                          Save product
                        </button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
              {!r.contentEntities.length && (
                <tr>
                  <td colSpan={5}>No products linked yet.{r.kind === "COMPARISON" ? " Add each compared product below." : ""}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form action="/api/admin/reviews" method="post" className="card card-body" style={{ marginTop: 12 }}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="action" value="entity-add" />
          <input type="hidden" name="returnTo" value={self} />
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ea-name">Product or service</label>
              <input id="ea-name" name="name" required minLength={2} maxLength={120} placeholder="e.g. Zellij" />
            </div>
            <div className="field">
              <label htmlFor="ea-brand">Brand (optional)</label>
              <input id="ea-brand" name="brand" maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ea-role">Role</label>
              <select id="ea-role" name="role" defaultValue={r.kind === "COMPARISON" ? "COMPARED" : r.kind === "REVIEW" ? "PRIMARY" : "MENTIONED"}>
                <option value="PRIMARY">Primary (the reviewed product)</option>
                <option value="COMPARED">Compared</option>
                <option value="MENTIONED">Covered in a guide</option>
              </select>
            </div>
          </div>
          <p className="field-hint">An existing product with the same name or alias is reused (&ldquo;Nord VPN&rdquo; links NordVPN).</p>
          <div className="btnrow">
            <button className="btn primary" type="submit">
              Link product
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="tax-h">
        <h2 id="tax-h">Taxonomy</h2>
        <form action="/api/admin/reviews" method="post" className="toolbar">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="action" value="override-category" />
          <input type="hidden" name="returnTo" value={self} />
          <div className="field">
            <label htmlFor="o-cat">Primary category</label>
            <select id="o-cat" name="category" defaultValue={r.categorySlug ?? ""} required>
              <option value="" disabled>
                Choose…
              </option>
              {CATEGORIES.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="o-sub">Subcategory (optional)</label>
            <select id="o-sub" name="subcategory" defaultValue={r.subcategorySlug ?? ""}>
              <option value="">None</option>
              {CATEGORIES.map((c) => (
                <optgroup key={c.slug} label={c.name}>
                  {c.subcategories.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit">
            Override category
          </button>
        </form>
        <p className="small muted">Current: {categoryName(r.categorySlug) ?? "none"}{category && r.subcategorySlug ? ` › ${category.subcategories.find((s) => s.slug === r.subcategorySlug)?.name ?? r.subcategorySlug}` : ""}</p>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Tag</th>
                <th scope="col" className="num">Confidence</th>
                <th scope="col">Source</th>
                <th scope="col">Reason</th>
                <th scope="col">State</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {r.assignments.map((a) => (
                <tr key={a.id} className={a.active ? undefined : "row-inactive"}>
                  <td data-label="Type">
                    {a.tagType}
                    {a.isPrimary ? " (primary)" : ""}
                  </td>
                  <td data-label="Tag">{a.categoryTag.name}</td>
                  <td data-label="Confidence" className="num">{pct(a.confidence)}</td>
                  <td data-label="Source">
                    {a.source}
                    {a.isOverride ? " · override" : ""}
                  </td>
                  <td data-label="Reason" className="small muted">{a.reason}</td>
                  <td data-label="State">
                    <Badge value={a.active ? a.reviewState : "INACTIVE"} />
                  </td>
                  <td data-label="Action">
                    {a.active && a.tagType === "CATEGORY" && !a.isOverride && a.reviewState === "UNREVIEWED" ? (
                      <div className="btnrow" style={{ margin: 0 }}>
                        <ActionForm action="/api/admin/assignments" fields={{ id: a.id, decision: "ACCEPTED" }} label="Accept" returnTo={self} />
                        <ActionForm action="/api/admin/assignments" fields={{ id: a.id, decision: "REJECTED" }} label="Reject" returnTo={self} className="btn small danger" />
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {!r.assignments.length && (
                <tr>
                  <td colSpan={7}>No assignments yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="deal-h">
        <h2 id="deal-h">Commerce offers</h2>
        <p>
          <Badge value={r.dealStatus} /> <span className="small muted">{r.dealStatusReason ?? ""} · checked {when(r.dealCheckedAt)}</span>
        </p>
        <p className="small muted">Offers observed by the commerce engine for this review’s primary product. A price is shown publicly only while observed within the price window; links stay plain unless an affiliate provider set one.</p>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Seller</th>
                <th scope="col" className="num">Price</th>
                <th scope="col">Availability</th>
                <th scope="col">Status</th>
                <th scope="col">Link</th>
                <th scope="col">Observed</th>
              </tr>
            </thead>
            <tbody>
              {commerceOffers.map((o) => (
                <tr key={o.id}>
                  <td data-label="Seller">
                    {o.seller} <span className="small muted">({o.sellerType.toLowerCase()})</span>
                  </td>
                  <td data-label="Price" className="num">{o.price !== null ? `${o.price} ${o.currency ?? ""}` : "not stated"}</td>
                  <td data-label="Availability">{o.availability ?? "—"}</td>
                  <td data-label="Status">
                    <Badge value={o.status} />
                  </td>
                  <td data-label="Link" className="small" style={{ wordBreak: "break-all" }}>
                    <Badge value={o.affiliateUrl ? "AFFILIATED" : "PLAIN"} tone={o.affiliateUrl ? "ok" : "neutral"} /> {o.destinationUrl}
                  </td>
                  <td data-label="Observed">{when(o.observedAt)}</td>
                </tr>
              ))}
              {!commerceOffers.length && (
                <tr>
                  <td colSpan={6}>{primaryEntityId ? "No commerce offers observed for this product yet." : "No primary product linked, so no commerce offers apply."}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="img-h">
        <h2 id="img-h">Image</h2>
        {primaryImage ? (
          <div className="card card-body" style={{ display: "grid", gridTemplateColumns: "minmax(0,240px) 1fr", gap: 16 }}>
            <img src={shown.url} alt="Public image preview" width={240} height={135} style={{ borderRadius: 8, objectFit: "cover" }} />
            <dl className="kv">
              <dt>Source</dt>
              <dd>{primaryImage.sourceType}</dd>
              <dt>Source URL</dt>
              <dd style={{ wordBreak: "break-all" }}>{primaryImage.sourceUrl ?? "—"}</dd>
              <dt>CDN URL</dt>
              <dd style={{ wordBreak: "break-all" }}>{primaryImage.cdnUrl ?? "not configured"}</dd>
              <dt>License</dt>
              <dd>
                <Badge value={primaryImage.licenseState} /> {primaryImage.license ?? ""}
              </dd>
              <dt>Status</dt>
              <dd>
                <Badge value={primaryImage.enrichmentStatus} /> {primaryImage.isFallback && <Badge value="FALLBACK" tone="warn" />}
              </dd>
              <dt>Shown publicly</dt>
              <dd>{shown.isFallback ? "placeholder (fallback or unverified license)" : "source image"}</dd>
              {primaryImage.failureReason && (
                <>
                  <dt>Reason</dt>
                  <dd className="small">{primaryImage.failureReason}</dd>
                </>
              )}
            </dl>
          </div>
        ) : (
          <p className="muted">No image asset yet.</p>
        )}
      </section>

      <section aria-labelledby="fail-h">
        <h2 id="fail-h">Open failures</h2>
        {failures.length ? (
          <ul>
            {failures.map((f) => (
              <li key={f.id}>
                <Badge value={f.kind} /> <strong>{f.stage}</strong> {f.errorCode} — <span className="small">{f.message}</span> <span className="small muted">({f.occurrences}×, last {when(f.lastOccurredAt)})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None.</p>
        )}
      </section>

      <section aria-labelledby="src-h">
        <h2 id="src-h">Source content items</h2>
        {r.contentItems.map((c) => (
          <details key={c.id} className="card card-body" style={{ marginBottom: 8 }}>
            <summary>
              {c.source}/{c.sourceId} · <Badge value={c.processingStatus} /> · fetched {when(c.fetchedAt)} · hash {c.contentHash.slice(0, 10)}
            </summary>
            {c.statusReason && <p className="small">{c.statusReason}</p>}
            <pre className="code">{JSON.stringify(c.rawPayload, null, 2).slice(0, 20000)}</pre>
          </details>
        ))}
      </section>

      <section aria-labelledby="hist-h">
        <h2 id="hist-h">History</h2>
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {[...r.publishJobs.map((j) => ({ at: j.createdAt, actor: j.actor ?? j.trigger, action: `${j.action} ${j.status}${j.message ? ` — ${j.message}` : ""}` })), ...auditRows.map((a) => ({ at: a.createdAt, actor: a.actor, action: a.action }))]
                .sort((a, b) => b.at.getTime() - a.at.getTime())
                .map((h, i) => (
                  <tr key={i}>
                    <td data-label="When">{when(h.at)}</td>
                    <td data-label="Actor">{h.actor}</td>
                    <td data-label="Action">{h.action}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
