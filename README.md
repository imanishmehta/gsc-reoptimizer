# GSC Reoptimizer

Standalone PHP + MySQL dashboard that pulls Google Search Console data daily
and surfaces what's declining, why, quick wins, keyword-to-page mapping,
cannibalization, and coverage/orphan gaps. Runs on any cheap PHP+MySQL host,
no framework, no JS build step.

## What it does
- Cron pulls `(date, page, query)` search analytics daily for each site, stores it
- Dashboard computes period-over-period diffs, quick wins, keyword maps,
  cannibalization, and orphan-page checks straight from SQL -- no re-fetching
  from Google on every page load
- On-demand URL Inspector page checks indexing status for a specific URL

## What it can't do (GSC API limits, not a bug)
- No internal-links report, no true competitor-SERP data -- Search Console's
  API doesn't expose either. The dashboard's "coverage gaps" (sitemap URLs
  with ~zero impressions) is a proxy for orphan pages, not a real link graph.
- Sitemap `indexed` counts from `sitemaps.list` read 0 for both your
  properties right now -- that field is known to be unreliable in this API,
  don't treat it as "nothing is indexed." Use the URL Inspector for ground truth.

## Setup

### 1. Google Cloud service account
1. Go to console.cloud.google.com, create (or reuse) a project.
2. APIs & Services -> Library -> enable **Google Search Console API**.
3. APIs & Services -> Credentials -> Create Credentials -> Service Account.
4. Create a JSON key for it, download as `service-account.json`, place it in
   the project root (or wherever `config.php` points `service_account_key` to).
5. Copy the service account's email (looks like `xxx@yyy.iam.gserviceaccount.com`).
6. In Search Console (search.google.com/search-console), for **each property**:
   Settings -> Users and permissions -> Add user -> paste the service account
   email -> permission level "Restricted" is enough (read + inspect, no
   settings changes).

### 2. Database
```
mysql -u root -p -e "CREATE DATABASE gsc_reoptimizer"
mysql -u root -p gsc_reoptimizer < schema.sql
```
`schema.sql` seeds the two known properties (mimicminds, mimicproductions).
Edit the `INSERT INTO sites` block if URLs change or you add a property.

### 3. Install & configure
```
composer install
cp config.example.php config.php
```
Edit `config.php`: DB credentials, path to `service-account.json`.

### 4. Backfill history
```
php cron/fetch_sitemaps.php
php cron/backfill.php --days=90
```
First run only (or re-run anytime to extend history). Loops day-by-day so it
doesn't hit the API's per-call row cap on busy date ranges.

### 5. Cron (ongoing)
```
0 6 * * *  php /path/to/cron/fetch_daily.php   >> /path/to/logs/fetch.log 2>&1
0 5 * * 1  php /path/to/cron/fetch_sitemaps.php >> /path/to/logs/sitemaps.log 2>&1
```

### 6. Deploy `public/` as the web root
Point your host's document root at `public/`. Everything outside `public/`
(config, service account key, `vendor/`) stays off the web -- don't move
`config.php` or `service-account.json` into `public/`.

Protect the dashboard:
```
htpasswd -c public/.htpasswd yourusername
cp public/.htaccess.example public/.htaccess   # edit the AuthUserFile path
```
(Apache only. On nginx, use an equivalent `auth_basic` block instead.)

## Files
- `schema.sql` -- DB schema + seed sites
- `db.php` / `config.php` -- DB + service account config
- `src/GscClient.php` -- thin wrapper over `google/apiclient` for Search Analytics + URL Inspection
- `src/Fetch.php` -- fetch-one-day-and-store, shared by cron + backfill
- `src/Analysis.php` -- all the SQL: diffs, quick wins, keyword maps, cannibalization, orphans
- `cron/fetch_daily.php` -- daily incremental fetch (T-3 days, GSC's finalization lag)
- `cron/backfill.php` -- historical bulk fetch, day-by-day loop
- `cron/fetch_sitemaps.php` -- weekly sitemap crawl (plain HTTP, recurses sitemap indexes)
- `public/index.php` -- the dashboard
- `public/inspect.php` -- on-demand URL Inspector
