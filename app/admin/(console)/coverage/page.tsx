import { ActionForm, Badge, Stat } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config, integrationStatus } from "@/lib/config";
import { categoryCoverage, contentOpportunities } from "@/lib/content/calendar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coverage & content calendar" };

const TONE = { STRONG: "ok", WEAK: "warn", MISSING: "error" } as const;

export default async function CoveragePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdminPage();
  const sp = await searchParams;
  const [coverage, next] = await Promise.all([
    categoryCoverage(),
    contentOpportunities({ limit: 25 }),
  ]);
  const sum = (f: (c: (typeof coverage)[number]) => number) =>
    coverage.reduce((n, c) => n + f(c), 0);
  const nonTech = coverage.filter((c) => !c.tech);
  const ai = integrationStatus().aiGuides;
  const autogen = config.aiGuides.autoGenerate();
  const generateBlocked =
    ai !== "READY"
      ? "Keyword-to-Blog not configured"
      : autogen
        ? undefined
        : "GUIDE_AUTOGEN_ENABLED is not true";
  return (
    <>
      <h1>Coverage &amp; content calendar</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Every number is a count of stored data. Categories are STRONG with 5+
        published items including a guide and a review or comparison, WEAK with
        some content, MISSING with none. Nothing here is generated to fill a
        gap: reviews come only from sources whose terms allow it, and
        AI-assisted guides are drafted from the calendar below and still need an
        editor&rsquo;s approval.
      </p>
      <div className="stats">
        <Stat
          label="Categories"
          value={coverage.length}
          note={`${coverage.filter((c) => c.level === "STRONG").length} strong · ${coverage.filter((c) => c.level === "WEAK").length} weak · ${coverage.filter((c) => c.level === "MISSING").length} missing`}
        />
        <Stat
          label="Published"
          value={sum((c) => c.published)}
          note={`${sum((c) => c.reviews)} reviews · ${sum((c) => c.comparisons)} comparisons · ${sum((c) => c.guides + c.aiGuides)} guides`}
        />
        <Stat
          label="Non-tech published"
          value={nonTech.reduce((n, c) => n + c.published, 0)}
          note={`${nonTech.filter((c) => c.published > 0).length} of ${nonTech.length} non-tech categories have content`}
        />
        <Stat label="In editorial QA" value={sum((c) => c.inQa)} />
        <Stat label="Verified offers" value={sum((c) => c.verifiedDeals)} />
      </div>

      <h2>Next content opportunities</h2>
      <p className="small muted">
        Ranked from real gaps (nothing published, or no guide yet), balanced one
        per category at the top, non-tech first, with a seasonal nudge. The{" "}
        <code>daily-article</code> job publishes from this queue twice a day (guide at 08:00, article at 19:00 IST) within the
        Keyword-to-Blog quota ({config.aiGuides.dailyLimit()}/day), published as returned. The same exact topic is never sent twice for the same post type.
      </p>
      <div className="btnrow">
        <ActionForm
          action="/api/admin/jobs"
          fields={{ job: "daily-article" }}
          label="Run the due article slot now"
          returnTo="/admin/coverage"
          disabledReason={generateBlocked}
        />
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Type</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Score
              </th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {next.map((o) => (
              <tr key={o.key}>
                <td data-label="Topic">
                  {o.kind === "CATEGORY_GUIDE"
                    ? `How to choose ${o.subject.toLowerCase()}`
                    : `${o.subject}: buying guide`}
                </td>
                <td data-label="Type">
                  {o.kind === "CATEGORY_GUIDE"
                    ? "Category guide"
                    : "Product guide"}
                </td>
                <td data-label="Category">
                  {coverage.find((c) => c.slug === o.categorySlug)?.name}
                </td>
                <td data-label="Score" className="num">
                  {o.score}
                </td>
                <td data-label="Why" className="small">
                  {o.why}
                </td>
              </tr>
            ))}
            {!next.length && (
              <tr>
                <td colSpan={5}>
                  No open opportunities: every category and reviewed product
                  already has a guide.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Coverage by category</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Coverage</th>
              <th scope="col" className="num">
                Reviews
              </th>
              <th scope="col" className="num">
                Comparisons
              </th>
              <th scope="col" className="num">
                Guides (source / AI)
              </th>
              <th scope="col" className="num">
                Products
              </th>
              <th scope="col" className="num">
                In QA
              </th>
              <th scope="col" className="num">
                Offers
              </th>
              <th scope="col" className="num">
                Real images
              </th>
              <th scope="col">Blocked by</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((c) => (
              <tr key={c.slug}>
                <td data-label="Category">
                  <a href={`/category/${c.slug}`}>{c.name}</a>
                  <div className="small muted">
                    {c.departmentName}
                    {c.tech ? "" : " · non-tech"}
                  </div>
                </td>
                <td data-label="Coverage">
                  <Badge value={c.level} tone={TONE[c.level]} />
                </td>
                <td data-label="Reviews" className="num">
                  {c.reviews}
                </td>
                <td data-label="Comparisons" className="num">
                  {c.comparisons}
                </td>
                <td data-label="Guides" className="num">
                  {c.guides} / {c.aiGuides}
                </td>
                <td data-label="Products" className="num">
                  {c.products}
                </td>
                <td data-label="In QA" className="num">
                  {c.inQa}
                </td>
                <td data-label="Offers" className="num">
                  {c.verifiedDeals}
                </td>
                <td data-label="Real images" className="num">
                  {c.realImages}
                </td>
                <td data-label="Blocked by" className="small">
                  {c.blockers.join("; ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
