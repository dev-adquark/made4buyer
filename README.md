# Made4Buyers — RealTech Review Engine

Automated technology review and affiliate-deal platform. EXPERTE.com is used as an information-architecture and UX reference; the implementation is original.

## Implemented
- Live Content API ingestion, normalization, canonical/source deduplication and ingestion locking
- Buyer taxonomy classification with confidence
- Configurable image enrichment and Sovrn offer adapter
- Affiliate URL verification with redirect/timeouts and tracked redirects
- SEO review/category pages, search, comparison entry point, sitemap and robots
- Admin authentication with signed expiring sessions
- Admin ingestion controls, run history, QA publishing, rejection, restore/unpublish and full review editing
- Sponsored placements with traffic-threshold gating
- First-party analytics, analytics/reporting and Day 30 reporting
- Google Search Console reporting via service-account authentication
- Automated daily ingestion and six-hour deal revalidation cron routes
- Baseline production security headers
- CI typecheck and production build

## Real integrations only
No review text, price, affiliate offer, image, verification state or analytics result is fabricated. External integrations require real endpoint/credential configuration. Missing integrations remain explicitly unavailable rather than simulated.

## Setup
Copy `.env.example` to `.env.local`, configure PostgreSQL and the external API contracts, then run:
```bash
npm install
npm run db:push
npm run dev
```

For a production database, apply the Prisma schema to the target PostgreSQL database before the first deployment. Do not point a production deployment at an empty database and expect the Next.js build to create tables automatically.

Pipeline: Content API → normalize/dedupe → taxonomy → image enrichment → database → Sovrn matching → link verification → admin QA/edit → publish → analytics.

## Required production configuration
- `DATABASE_URL`
- `CONTENT_API_URL` + `CONTENT_API_KEY`
- `SOVRN_API_URL` + `SOVRN_API_KEY`
- `IMAGE_ENRICHMENT_URL` + `IMAGE_ENRICHMENT_API_KEY` when image enrichment is enabled
- `ADMIN_EMAIL` + `ADMIN_PASSWORD` + strong `ADMIN_SESSION_SECRET`
- `CRON_SECRET`
- `NEXT_PUBLIC_SITE_URL`
- `GSC_SITE_URL` + `GSC_SERVICE_ACCOUNT_JSON` when Search Console reporting is enabled
- `NEXT_PUBLIC_ANALYTICS_ID` only when external analytics is intentionally enabled

## Google Search Console
1. Create/select the Google Cloud project used for Search Console reporting.
2. Create a service account and generate its JSON credentials.
3. Grant that service account access to the target Search Console property with appropriate read access.
4. Set `GSC_SITE_URL` to the exact Search Console property URL.
5. Set `GSC_SERVICE_ACCOUNT_JSON` to the service-account JSON as a single environment variable value.
6. Open `/admin/gsc` after signing into the admin area.

## Cron authentication
The ingestion and revalidation routes require:
`Authorization: Bearer <CRON_SECRET>`.
The Vercel cron schedules are defined in `vercel.json`.

Reference: https://www.experte.com/
