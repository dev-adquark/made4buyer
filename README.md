# Made4Buyers — RealTech Review Engine

A buyer-focused technology review site. Reviews arrive from a Content API and are
normalized, de-duplicated and classified. They are then matched to Sovrn offers whose
affiliate links are verified, checked in an admin QA step, and published as SEO pages with
first-party analytics. EXPERTE.com was used only as a reference for information architecture
and UX; the implementation, branding and content are original.

**Nothing is fabricated.** When an integration has no credentials it reports
`BLOCKED_BY_ENVIRONMENT` / `NOT_AVAILABLE_IN_ENVIRONMENT`. No offer, price, merchant, image
licence, verification result, indexing figure or CTR is invented, and metrics with too
little data report `INSUFFICIENT_DATA`.

- Pipeline and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Content API field contract: [docs/CONTENT_API_CONTRACT.md](docs/CONTENT_API_CONTRACT.md)
- Deployment, migrations, cron, GSC: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Pipeline

```
Content API → ContentItem → NormalizedReview → ExtractedEntities → CategoryTagSet → ImageAsset
→ MatchedSovrnOfferSet → AffiliateLinkSet (verified) → PageRenderModel → PublishJob
→ /review/{slug}, /category/{slug}, /brand/{slug}, sitemap → analytics → revalidation → Day-30 report
```

## Quick start (local, no credentials needed)

Requires Node ≥ 22. Docker is not needed: `db:local` runs a real PostgreSQL from npm binaries.

```bash
npm install
npm run pipeline:dry-run          # every stage on sample JSON — no DB, no network

# Full local stack with SAMPLE data:
npm run db:local                  # terminal 1: PostgreSQL on :54329, migrated + seeded
npm run dev:stubs                 # terminal 2: SAMPLE Content API / Sovrn / merchant stub on :4010
cp .env.example .env.local        # then set DATABASE_URL, ADMIN_* and the stub lines printed by dev:stubs
npm run dev                       # terminal 3: http://localhost:3000, admin at /admin
```

In the admin: **Run ingestion now** → review the **QA queue** → publish → open the public
pages. Sample fixtures are fictional and are labelled `SAMPLE` wherever they appear.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` / `lint` | TypeScript / ESLint |
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests on a real PostgreSQL (embedded, or `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright E2E against `next start` (run `npm run build` first) |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:local` | Local PostgreSQL (embedded) with migrations and taxonomy |
| `npm run pipeline:dry-run` | Stage-by-stage dry-run over sample JSON → `docs/dry-run/sample-output.json` |
| `npm run job -- <name>` | Run a scheduled job (`ingest`, `verify-links`, `revalidate-offers`, `retry-failed`, `publish-cycle`, `cleanup-cache`, `inspect-index`) |
| `npm run mvp:verify` | MVP launch criteria from persisted data (+ HTTP checks with `MVP_BASE_URL`) |
| `npm run report:day30` | Day-30 report → `reports/generated/*.json` and `*.html` |
| `npm run legacy:import` | Import data from the pre-engine `db push` schema |
| `npm run audit` | Live site audit (only when `AUDIT_BASE_URL` is set) |

## Public experience

- **Routes:** `/` (3D hero, categories, latest, trending by real page views, verified deals), `/reviews`, `/deals`, `/category/{slug}` (per-category colour theme, filters), `/review/{slug}` (parallax hero, sticky section nav, verified-offer panel, mobile sticky CTA), `/brand/{slug}`, `/search` (instant suggestions, keyboard navigable), `/compare` (animated columns, differences highlighted, missing facts shown as "Not available"), `/about`, `/disclosure`, `/privacy`, `/terms`, `/contact`.
- **Design system:** tokens in `app/globals.css`, category themes in `lib/taxonomy/themes.ts`, Bricolage Grotesque + Figtree via `next/font`.
- **3D:** `components/hero3d/*` is a procedural scene in React Three Fiber (laptop, phone, headphones, interface card, particles), with no downloaded models. It is lazy-loaded and decorative (`aria-hidden`). A GPU tier (0–3) is detected from WebGL support, the renderer, device memory, cores, pointer type, save-data and reduced motion. Tier 0 shows static gradient art, and phones get tier ≤ 1. `?tier=N` forces a tier for QA.
- **Motion:** framer-motion for the menus, suggestions and compare columns; CSS for card tilt, reveals and hero drift. Everything is disabled under `prefers-reduced-motion`.
- **Honesty rules:** cards show "Verified offer" only for a `VERIFIED_OK` link on a matched offer. Prices appear only when the provider supplied them. Every empty state says what's missing.

## Admin

`/admin` (session login) has these pages:

- **Overview:** counts, deal coverage, link health, image coverage, success metrics, integration states
- **QA queue:** publish, bulk publish, reject, restore, unpublish
- **All reviews** and **Entities** (low-confidence and overridden entities)
- **Review detail:** edit, entity/category/deal overrides, accept/reject classification, re-run pipeline, revalidate links, full history
- **Ingestion runs & items**
- **Categorization queue** (low confidence, missing category)
- **Deals**
- **Link health** (with revalidation by date range)
- **Images**
- **CSV import:** upload → preview → process → retry → error report
- **Analytics & CTR**
- **Sponsored placements:** feature-flagged, traffic-gated, previewed
- **Day-30 report:** JSON and HTML
- **Jobs & runs**
- **Failures**
- **Audit log & live site audit**
- **Search Console**

## CSV overrides

Header columns:

- `normalized_review_key` (review id, slug or dedupe key)
- one or more of `override_primary_category`, `entity_brand_override`, `entity_product_name_override`, `sovrn_deal_id_override`
- optionally `override_subcategory`, `entity_model_number_override`, `entity_device_type_override`

Rows are validated individually: unknown reviews, invalid categories, duplicate rows and
malformed deal IDs are all caught, and valid rows still apply when others fail. Every applied
override is audited and re-runs categorization, Sovrn matching, affiliate links and
verification for that review. A deal ID that Sovrn does not return is reverted and reported.

## Configuration

Every variable is documented in [.env.example](.env.example). Integration status is shown on
the admin overview and in `GET /api/health`, which never includes secrets or connection strings.
