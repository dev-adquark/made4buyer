# Deployment (Vercel + PostgreSQL)

## 1. Database

Any PostgreSQL 14+ works: Neon, Supabase, RDS, Prisma Postgres and so on.

**New database:**

```bash
DATABASE_URL="postgresql://…" npm run db:migrate   # prisma migrate deploy
DATABASE_URL="postgresql://…" npm run db:seed      # taxonomy (also seeded automatically on first classification)
```

**Existing database created by the previous `db push` schema** (tables `"Review"`, `"Deal"`, …):
`prisma migrate deploy` refuses to run because the database is not empty. The new tables use
different names (`normalized_reviews`, `affiliate_links`, …), so they can be added next to the
legacy tables without changing them:

```bash
# 1. Back up the database first.
# 2. Create the new schema and mark the baseline migration as applied.
npx prisma db execute --file prisma/migrations/20260925000000_init/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260925000000_init
# 3. Preview, then import legacy reviews (slugs and publishedAt preserved; published reviews
#    are re-published through the QA gates; legacy "verified" deals are re-verified, not copied).
npm run legacy:import
npm run legacy:import -- --apply
```

The legacy tables are never dropped by these steps. Remove them manually once the import
has been checked.

For every later schema change, run `npm run db:migrate` before (or as part of) the deploy.

## 2. Vercel project

1. Import the repository. The framework is detected as Next.js, and the build command is `npm run build` (release notes → `prisma generate` → `next build`).
2. Set the environment variables from [`.env.example`](../.env.example). The minimum for a working production site is `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` (≥ 32 characters) and `CRON_SECRET`, plus `CONTENT_API_URL`/`CONTENT_API_KEY` for ingestion and `SOVRN_API_URL`/`SOVRN_API_KEY` for deals.
3. Never set `UNSAFE_ALLOW_LOOPBACK_FOR_TESTS` in any deployed environment. It is ignored when `VERCEL_ENV=production`.

## 3. Cron

`vercel.json` schedules:

| Path | Schedule |
|---|---|
| `/api/cron/ingest` | hourly at :15 |
| `/api/cron/verify-links` | every 6 h |
| `/api/cron/revalidate-offers` | every 6 h (offset 30 min) |
| `/api/cron/retry-failed` | hourly at :45 |
| `/api/cron/publish-cycle` | hourly at :50 (no-op unless `AUTO_PUBLISH_ENABLED=true`) |
| `/api/cron/cleanup-cache` | daily 03:00 UTC |
| `/api/cron/inspect-index` | daily 04:00 UTC (no-op unless GSC is configured) |

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set.
Vercel Hobby plans only allow daily cron jobs; on Hobby, change every schedule to run at most
once a day. Every job is also available as **Admin → Jobs & runs → Run now** and as
`npm run job -- <name>`.

Cron routes declare `maxDuration = 300`. Ingestion processes at most
`INGEST_MAX_ITEMS_PER_RUN` items per invocation; the remainder stays `INGESTED` and is picked up
by the next run.

## 4. Google Search Console (optional)

1. Create a service account in Google Cloud and download its JSON key.
2. In Search Console → Settings → Users and permissions, add the service account's email with at least *Restricted* access.
3. Set `GSC_SITE_URL` (exactly as the property is named, e.g. `sc-domain:example.com`) and `GSC_SERVICE_ACCOUNT_JSON` (the JSON on one line).
4. The `inspect-index` job inspects up to `GSC_INSPECTIONS_PER_RUN` published URLs per day. The Day-30 report uses these results; without them it reports `NOT_AVAILABLE_IN_ENVIRONMENT`.

## 5. After deploying

```bash
curl https://<site>/api/health                 # {"status":"ok","database":"ok",…}
AUDIT_BASE_URL=https://<site> npm run audit     # core routes, sitemap, robots, health, internal links
DATABASE_URL=… MVP_BASE_URL=https://<site> npm run mvp:verify
```

To run the live audit on every CI build, set the GitHub repository variable `AUDIT_BASE_URL`.
