# Editorial review sources (Apify Web Scraper)

Genuine reviews come from editorial sites configured in **Admin → Sources** and crawled with
the official `apify/web-scraper` actor. AI-assisted guides (Keyword-to-Blog) are a separate
pipeline and are never labelled as reviews.

## Flow

```
scrape-sources  (cron)  enabled + due sources → robots.txt check → start Apify run → apify_runs
collect-scrapes (cron)  poll runs → SUCCEEDED → fetch dataset (once, claimed) → strict mapping
                        → validation (coded rejections) → existing ingestion → QA queue
```

Nothing publishes automatically unless `AUTO_PUBLISH_ENABLED=true`, and every QA gate still
applies (publication date, category confidence, entities, editor actions).

## Rules the adapter enforces

| Rule | How |
|---|---|
| Only configured sources | Crawl starts only from a source's start URLs; only pages matching its review URL globs are extracted |
| Only the source's domains | Page and canonical URL must be on `allowedDomains`, else `SOURCE_NOT_ALLOWED` |
| robots.txt | Checked for every start URL before a run (unreadable robots.txt = no crawl, `ROBOTS_DISALLOWED`); the actor runs with `respectRobotsTxtFile: true` |
| No access-control bypass | No proxy rotation, no login, cookies or CAPTCHA handling; depth 1, concurrency 2 |
| Nothing guessed | Extraction order JSON-LD → semantic HTML → OpenGraph/meta; missing fields stay empty. A rating needs both value and scale |
| Dates | Source date only. Future (> 24 h), pre-1990 and unparseable dates are rejected with their own codes; a missing date holds the review in QA (`PUBLICATION_DATE_MISSING`) |
| Dedupe | Normalised canonical URL is the item id (tracking parameters, hash and trailing slash removed); repeats within a run count as `DUPLICATE_REVIEW`; the existing canonical-URL and product/publisher/month dedupe still apply |
| Images | Source images are never marked licensed, so they are not shown; Pexels (attributed) or our placeholder is used |

## Text rights (copyright)

Each source is **Excerpt only** by default: the full text is stored privately for entity
extraction and classification, and the public page shows the excerpt, our structured facts and
a link to the original. Structured data is an `Article` citing the source (`isBasedOn`), never a
`Review` of our own. Set a source to **Licensed** only when you hold permission to republish
its full text.

## Failure codes

`APIFY_NOT_CONFIGURED`, `APIFY_AUTH_FAILED`, `APIFY_RUN_FAILED`, `APIFY_EMPTY_DATASET`,
`APIFY_RESPONSE_INVALID`, `ROBOTS_DISALLOWED`, `SOURCE_NOT_ALLOWED`, `PUBLICATION_DATE_INVALID`,
`PUBLICATION_DATE_FUTURE`, `PUBLICATION_DATE_TOO_OLD`, `CONTENT_TOO_SHORT`, `DUPLICATE_REVIEW`
(all visible under Admin → Failures and on each source's runs).
