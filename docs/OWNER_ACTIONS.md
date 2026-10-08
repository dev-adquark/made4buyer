# Owner actions

Everything below needs a credential, an account or a decision that only the site owner has.
The code for each integration is complete and tested against local stubs: it stays
**BLOCKED_BY_ENVIRONMENT** (links plain, jobs skipped) until the variables are set, and turns
on with the next deploy after they are.

**Where to check:** Admin → **Integrations** (`/admin/integrations`) lists each integration as
READY / BLOCKED_BY_ENVIRONMENT / ERROR, with the last successful call and the exact names of the
variables still missing. It never shows a value. "Run live checks" makes one real call to each
configured provider.

**How to set a variable in production** (run these yourself, on your machine). `vercel env add`
asks for the value at a prompt, so it is not saved in your shell history:

```sh
npx vercel env add NAME production --scope team_nWHsBPLFeOoHpJYXLxPC3eF9      # paste the value at the prompt
npx vercel env rm  NAME production --scope team_nWHsBPLFeOoHpJYXLxPC3eF9      # remove a value
npx vercel deploy --prod --yes --scope team_nWHsBPLFeOoHpJYXLxPC3eF9          # redeploy so the new value is used
```

Mark secrets as **Sensitive** in the Vercel dashboard. Never put a secret in a `NEXT_PUBLIC_*`
variable. The `verify-*` scripts read variables from your shell or `.env.local`. They print
statuses and counts only, never values.

---

## 1. Rotate the Apify token (required: the old token was exposed)

1. Apify Console → **Settings → API & Integrations** → *Personal API tokens* → **Create new token**
   (or reset the default token). Copy it.
2. Put the new token in Vercel and redeploy:
   ```sh
   npx vercel env rm  APIFY_API_TOKEN production --scope team_nWHsBPLFeOoHpJYXLxPC3eF9
   npx vercel env add APIFY_API_TOKEN production --scope team_nWHsBPLFeOoHpJYXLxPC3eF9
   npx vercel deploy --prod --yes --scope team_nWHsBPLFeOoHpJYXLxPC3eF9
   ```
   Also update `.env.local` if you run scripts locally.
3. Back in Apify Console, **delete/revoke the old token**.
4. Verify locally (the old token is passed by the *name* of an env var, never on the command line):
   ```sh
   export APIFY_API_TOKEN=…            # new token (or keep it in .env.local)
   read -s OLD_APIFY_TOKEN && export OLD_APIFY_TOKEN   # paste the OLD token, nothing is echoed
   npx tsx scripts/verify-apify-token.ts --old-token-env OLD_APIFY_TOKEN
   unset OLD_APIFY_TOKEN
   ```
   Expected output: `current token ok (username …)` and `old token ok (revoked: HTTP 401)`.
   The script calls `GET https://api.apify.com/v2/users/me` and nothing else.

## 2. Sovrn (removed from the code): revoke the key

The Sovrn integration was removed. Sign in to the Sovrn Commerce dashboard, open the site's API
key settings (site API key / secret key) and **revoke or regenerate** the secret key, so the
exposed key stops working. No variable needs to be set. Delete `SOVRN_*` variables from Vercel if any are left:
`npx vercel env ls production --scope …`, then `npx vercel env rm SOVRN_… production --scope …`.

## 3. Secret scan

```sh
npm run build                                   # so the .next output is scanned too
npx tsx scripts/verify-no-secrets.ts            # working tree + .next + production HTML/JS
npx tsx scripts/verify-no-secrets.ts --skip-prod
npx tsx scripts/verify-no-secrets.ts --prod-url https://made4buyers.vercel.app --pages /,/deals,/reviews
```

Patterns: Apify `apify_api_…`, Sovrn keys by the prefixes `e9f9…` / `c668…`, Vercel `vcp_…`,
`sk-…` API keys, JWTs, Postgres URLs with a real password, private-key blocks. Only file:line
or URL and the pattern name are printed. Local `.env*` files (git-ignored) are skipped.

### Purge git history (only if you approve it)

A rotated/revoked secret is harmless even if it stays in history. Rewriting history is only
cosmetic hardening. It rewrites every commit hash and needs a force-push, so do it only if
you decide to:

```sh
pip install git-filter-repo
git clone --mirror <repo-url> m4b-mirror && cd m4b-mirror
printf 'regex:apify_api_[A-Za-z0-9]+==>REDACTED\n' > ../replacements.txt   # add one line per leaked literal
git filter-repo --replace-text ../replacements.txt
git push --force --mirror
```

Then everyone re-clones, open PRs are rebased, and GitHub support can purge cached views. Never
do this without the owner's explicit approval.

## 4. Content API (optional; reviews also come from Apify sources)

| Variable | Required | Example / meaning |
|---|---|---|
| `CONTENT_API_URL` | yes | `https://content.example.com/v1/reviews` (first page) |
| `CONTENT_API_KEY` | if the feed needs auth | Sensitive |
| `CONTENT_API_AUTH_HEADER` | no (default `Authorization`) | e.g. `X-API-Key` sends the raw key |
| `CONTENT_API_AUTH_SCHEME` | no (default `Bearer`) | prefix used with `Authorization` |
| `CONTENT_API_SOURCE_NAME` | no | stable source id (default: API host) |
| `CONTENT_API_SCHEMA_VERSION` | no (default `1`) | contract major version |

The feed must match [CONTENT_API_CONTRACT.md](CONTENT_API_CONTRACT.md) (v1: `id`, `title`,
`body` ≥ 120 chars, `publishedAt`; array or `items`/`results`/`data`/… plus `next` pagination).
Check: `npx tsx scripts/verify-content-api.ts` (prints counts only). A version or shape mismatch
fails the run with `CONTENT_API_SCHEMA_MISMATCH`, visible in Admin → Ingestion, Failures and
Integrations.

## 5. Affiliate links (optional; links stay plain until set)

Choose one or more with `AFFILIATE_PROVIDER` (comma list, tried in order, e.g. `amazon,skimlinks`).
Only destinations the provider supports are wrapped, every generated URL is verified, the plain
link is kept on any error, affiliate links get `rel="sponsored"`, and the disclosure page
switches to the affiliate wording (plus Amazon's required sentence when `amazon` is active).
Links are applied by the daily `commerce-collect` job, or right away with Admin → Jobs →
`affiliate-links`.

| Provider | `AFFILIATE_PROVIDER` | Variables | What you need first |
|---|---|---|---|
| Amazon Associates (US) | `amazon` | `AMAZON_ASSOCIATES_TAG` (e.g. `yourid-20`) | An approved Associates account. Only amazon.com product URLs that already contain an ASIN are wrapped (`https://www.amazon.com/dp/<ASIN>?tag=…`); nothing is looked up or invented. |
| Skimlinks | `skimlinks` | `SKIMLINKS_PUBLISHER_ID`, `SKIMLINKS_SITE_ID` (numeric, Publisher Hub), `SKIMLINKS_CLIENT_ID`, `SKIMLINKS_CLIENT_SECRET` (Hub → Toolbox → API) | An approved Skimlinks publisher account with made4buyers.vercel.app added as a site. A domain is wrapped only if the Skimlinks Merchant API lists the merchant. |
| impact.com | `impact` | `IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN` (partner account → Settings → API), `IMPACT_PROGRAMS` = `{"brand.com":"<programId>"}` | Approval in each brand's program. Only mapped domains are wrapped, via the Tracking Link API. |

Check: `npx tsx scripts/verify-affiliate.ts --url <a real product URL>` prints the status and the
generated link's host only. Setting `AFFILIATE_PROVIDER=none` (or removing it) removes every
stored affiliate link on the next run.

## 6. Google Search Console

1. **Verify the property.** In Search Console, add a **URL-prefix** property
   `https://made4buyers.vercel.app/`. A Domain property is not possible on `vercel.app`. Verify it
   by one of:
   - **HTML tag**: copy the `content` value of the tag into `GOOGLE_SITE_VERIFICATION` and
     redeploy. The root layout needs this one-line change, owned by the layout maintainer:
     in `app/layout.tsx` add `import { gscVerificationMetadata } from "@/lib/gsc";` and add
     `...gscVerificationMetadata(),` inside `export const metadata: Metadata = { … }`.
   - **HTML file**: download Google's `google<token>.html` and commit it to `public/`, then redeploy.
   - Or (custom domain later) **DNS TXT** on a Domain property.
2. **Google Cloud:** create (or pick) a project → *APIs & Services → Library* → enable **Google
   Search Console API** → *IAM & Admin → Service Accounts* → create a service account → *Keys →
   Add key → JSON* (download it once and keep it private).
3. **Search Console → Settings → Users and permissions → Add user:** the service account's
   `client_email`, permission **Full**. Restricted is enough for reading data, but sitemap
   submission needs Full.
4. Set in Vercel (Sensitive) and redeploy:
   - `GSC_SITE_URL` = `https://made4buyers.vercel.app/` (exactly the property, with the trailing slash;
     `sc-domain:example.com` for a Domain property)
   - `GSC_SERVICE_ACCOUNT_JSON` = the whole JSON key on one line
   - optional `GSC_SITEMAP_URL` (default `$NEXT_PUBLIC_SITE_URL/sitemap.xml`), `GSC_INSPECTIONS_PER_RUN` (default 50)
5. Check: `npx tsx scripts/verify-gsc.ts` (add `--submit-sitemap` to submit now). The daily
   `inspect-index` job then inspects URLs, submits the sitemap when it was not submitted in 7
   days, and records a 28-day clicks/impressions snapshot. All numbers come from Google; nothing
   is estimated.

## 6a. Feedico coupon feed (optional)

Promo codes that merchants publish through affiliate networks (CJ, Impact, Awin, …), for the brands
in the registry only (matched by the merchant's exact website domain). Code: `lib/commerce/feedico.ts`.

1. Feedico dashboard → **Account** → create an API token (`fdco_…`).
2. Add it to Vercel **Production** only, marked Sensitive, then redeploy:
   ```sh
   npx vercel env add FEEDICO_API_KEY production --scope team_nWHsBPLFeOoHpJYXLxPC3eF9
   npx vercel deploy --prod --yes --scope team_nWHsBPLFeOoHpJYXLxPC3eF9
   ```
3. Check it (one request, prints counts only): `FEEDICO_API_KEY=… npx tsx scripts/verify-feedico.ts`,
   or Admin → Jobs → `feedico-coupons` → Run now.

**What it does.** The `feedico-coupons` job runs **once a week** (Sunday 09:50 UTC) and fetches every
enabled brand: one request per brand (a second page only above 200 codes), ≈ 100 requests/week, ≈ 430
/month. It stops at `FEEDICO_MONTHLY_REQUEST_BUDGET` (600) and on Feedico's own 429, well inside the Free
plan's 1,000. A re-run within 20 hours only retries brands whose fetch failed.

**14-day freshness.** A code is accepted only when Feedico confirmed it (its `fetchedAt`) within the
last 14 days; a row with no `fetchedAt` is rejected (age unknown). Every run deactivates (INVALID, never
deleted) each stored Feedico code whose latest Feedico confirmation is older than 14 days, even when the
fetch itself could not run. A code Feedico confirms again later is reactivated as a candidate.

**What it never does.** Make a code public on its own. Feedico codes are stored as **UNVERIFIED**
candidates (Admin → Commerce → Coupons, source "Feedico coupon feed"); the existing rule still applies:
only verified codes are public, i.e. published on the brand's own official page and verified within 7
days. A code missing from two consecutive successful fetches becomes INVALID; a stated end date that
has passed makes it EXPIRED; duplicates across networks are merged and disagreements marked CONFLICTING. A failed, malformed or quota-refused response changes nothing. Turn the feed off
in Admin → Commerce → Coupons → Sources (Feedico coupon feed → Disable).

**Terms.** Feedico's catalogue pools codes from programmes across all Feedico customers. Before
showing any of these codes publicly (a separate decision, not implemented), confirm your own approval
in each affiliate programme.

## 7. Other integrations shown in Admin → Integrations

| Integration | Variables |
|---|---|
| Pexels images | `PEXELS_API_KEY` |
| Feedico coupon feed | `FEEDICO_API_KEY` (section 6a) |
| Keyword-to-Blog | `KEYWORD_TO_BLOG_API_URL`, `KEYWORD_TO_BLOG_API_KEY` (optional `KEYWORD_TO_BLOG_API_KEY_SECONDARY`) |
| Analytics | first-party events need only `DATABASE_URL`; optional `NEXT_PUBLIC_ANALYTICS_ID` (public) |
| Cron | `CRON_SECRET` (Vercel sends it automatically to `/api/cron/*`) |

## 8. Production admin check

```sh
export ADMIN_EMAIL=…                       # or keep both in .env.local
read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
npx tsx scripts/verify-admin.ts            # default https://made4buyers.vercel.app; --base-url to override
```

Headless Chromium signs in, opens every admin page (dashboard, commerce engine, commerce
sources/products/deals/coupons/runs, sources, products, deals, schedules, data audit, images,
keywords, jobs, go-live, integrations), checks HTTP 200, no error boundary, the heading and
content, checks the session cookie (HttpOnly, Secure, SameSite=Strict, `__Host-` prefix), signs out
and prints a pass/fail table. Credentials are never printed. Needs `npx playwright install chromium`
once.
