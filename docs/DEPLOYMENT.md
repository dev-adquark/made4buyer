# Deployment (Vercel + PostgreSQL)

## 1. Database

Production runs on **Supabase PostgreSQL** (project region ap-southeast-2; Vercel functions are pinned to `syd1` in `vercel.json` so queries stay in-region). Any PostgreSQL 14+ works for local development and CI.

**New database:**

```bash
DATABASE_URL="…" DIRECT_URL="…" npm run db:migrate   # prisma migrate deploy
DATABASE_URL="…" npm run db:seed                     # taxonomy (also seeded automatically on first classification)
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

`vercel.json` schedules every job once a day (UTC), which is what the Vercel **Hobby** plan
allows: more frequent expressions fail the deploy there.

| Path | Schedule |
|---|---|
| `/api/cron/cleanup-cache` | 03:00 |
| `/api/cron/inspect-index` | 04:00 (no-op unless GSC is configured) |
| `/api/cron/ingest` | 06:15 |
| `/api/cron/verify-links` | 07:00 |
| `/api/cron/revalidate-offers` | 07:30 |
| `/api/cron/retry-failed` | 08:00 |
| `/api/cron/publish-cycle` | 08:30 (no-op unless `AUTO_PUBLISH_ENABLED=true`) |

For the intended cadence (links and offers every 6 hours; ingestion, retries and publishing
hourly), either upgrade to Vercel Pro and tighten the schedules, or set the GitHub repository
secrets `SITE_URL` and `CRON_SECRET`. That activates `.github/workflows/scheduled-jobs.yml`,
which calls the same authenticated endpoints; an HTTP 409 means the job's lock was already
held.

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set.
Every job is also available as **Admin → Jobs & runs → Run now** and as
`npm run job -- <name>`. Cron routes declare `maxDuration = 300`. Ingestion processes at most
`INGEST_MAX_ITEMS_PER_RUN` items per invocation, and the rest continues on the next run.

## Supabase

The app talks to Supabase only through Prisma on the server. It does not use supabase-js,
the publishable/anon key or the service-role key, so none of them are required and none are
exposed to the browser.

| Variable | Supabase connection | Used for |
|---|---|---|
| `DATABASE_URL` | Transaction pooler `aws-0-REGION.pooler.supabase.com:6543`, `?pgbouncer=true&connection_limit=5&pool_timeout=20` | App runtime (Vercel functions, IPv4) |
| `DIRECT_URL` | Session pooler `aws-0-REGION.pooler.supabase.com:5432` | `prisma migrate deploy` (DDL, prepared statements) |

The dedicated host `db.PROJECT_REF.supabase.co` is IPv6-only unless the IPv4 add-on is
enabled, so use the poolers.

Security: migration `20260928000000_lock_down_public_schema` enables Row Level Security with
no policies on every table and revokes `anon` / `authenticated` privileges. The Supabase
REST/GraphQL APIs therefore cannot read or write Made4Buyers data even with the publishable
key. Prisma connects as the table owner and is unaffected. Any **new** table added in a
later migration must also `ENABLE ROW LEVEL SECURITY`; `tests/integration/schema-security.test.ts`
fails if one doesn't.

### Moving data between databases

```bash
DATABASE_URL=$TARGET DIRECT_URL=$TARGET npx prisma migrate deploy        # schema on the empty target
SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:copy            # dry run: counts
SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:copy -- --apply  # copy + per-table comparison
```

`db:copy` copies tables in foreign-key order inside one transaction, preserves primary keys
and types exactly, refuses to merge into non-empty tables, and exits non-zero on any count
mismatch.

## 4. Google Search Console (optional)

1. Create a service account in Google Cloud and download its JSON key.
2. In Search Console → Settings → Users and permissions, add the service account's email with at least *Restricted* access.
3. Set `GSC_SITE_URL` (exactly as the property is named, e.g. `sc-domain:example.com`) and `GSC_SERVICE_ACCOUNT_JSON` (the JSON on one line).
4. The `inspect-index` job inspects up to `GSC_INSPECTIONS_PER_RUN` published URLs per day. The Day-30 report uses these results; without them it reports `NOT_AVAILABLE_IN_ENVIRONMENT`.

## 5. After deploying

For the first real-data run, follow [GO_LIVE.md](GO_LIVE.md) (Admin → Go-live checks first).

```bash
curl https://<site>/api/health                 # {"status":"ok","database":"ok",…}
AUDIT_BASE_URL=https://<site> npm run audit     # core routes, sitemap, robots, health, internal links
DATABASE_URL=… MVP_BASE_URL=https://<site> npm run mvp:verify
```

To run the live audit on every CI build, set the GitHub repository variable `AUDIT_BASE_URL`.
