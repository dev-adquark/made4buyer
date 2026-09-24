# Made4Buyers — RealTech Review Engine

Automated technology review and affiliate-deal platform. EXPERTE.com is used as an information-architecture and UX reference; the implementation is original.

## Implemented
- Live Content API ingestion, normalization and source deduplication
- Buyer taxonomy classification with confidence
- Configurable image enrichment and Sovrn offer adapters
- Affiliate URL verification and tracked redirects
- SEO review/category pages, search, comparison entry point, sitemap and robots
- Admin login, ingestion controls, QA/publishing, run history and analytics
- Automated ingestion and six-hour deal revalidation cron routes
- Affiliate disclosure, privacy, about and Day 30 reporting pages
- CI typecheck and production build
- Google Search Console reporting via service-account authentication

## Real integrations only
No review text, price, affiliate offer, image, verification state or analytics result is fabricated. External integrations require real endpoint/credential configuration.

## Setup
Copy `.env.example` to `.env.local`, configure PostgreSQL and the external API contracts, then run `npm install`, `npm run db:push`, and `npm run dev`.

Pipeline: Content API → normalize/dedupe → taxonomy → image enrichment → database → Sovrn matching → link verification → admin QA → publish → analytics.

## Google Search Console
1. Create/select the Google Cloud project used for Search Console reporting.
2. Create a service account and generate its JSON credentials.
3. Grant that service account access to the target Search Console property with appropriate read access.
4. Set `GSC_SITE_URL` to the exact Search Console property URL.
5. Set `GSC_SERVICE_ACCOUNT_JSON` to the service-account JSON as a single environment variable value.
6. Open `/admin/gsc` after signing into the admin area; the current report uses the latest available complete reporting window.

Production external requirements: actual Content API schema, Sovrn account/feed contract, image provider, PostgreSQL, Search Console credentials and analytics/consent configuration. Missing integrations remain explicitly unavailable rather than simulated.

Reference: https://www.experte.com/
