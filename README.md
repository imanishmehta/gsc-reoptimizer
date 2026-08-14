# GSC Reoptimizer

Static, colorful GSC-driven SEO reoptimization dashboard. GitHub Pages hosts
it, GitHub Actions fetches fresh Search Console data on a daily schedule.
No server, no database, zero hosting cost.

**Live at:** `https://<your-github-username>.github.io/gsc-reoptimizer/`
(enable Pages -- see Setup step 3)

## What it shows
- Clicks/impressions/CTR/avg-position trend chart, period-over-period
- Top decliners, each classified as demand-drop / ranking-drop / CTR-drop
- Top risers -- what's working, worth repeating
- Quick wins: striking-distance queries (position 4-15, CTR ≤2%)
- Keyword-to-page map: inferred primary + secondary keywords per page
- Cannibalization: same query ranking on 2+ pages
- Coverage gaps: sitemap URLs with ~zero impressions (orphan-page proxy)

## What it can't do (GSC API limits, not a bug)
No internal-links report, no true competitor-SERP data -- Search Console's
API doesn't expose either. "Coverage gaps" is a sitemap-vs-impressions proxy
for orphan pages, not a real link graph.

## Architecture
```
fetch/fetch.js        -- pulls GSC data via service account, writes docs/data/*.json
fetch/analysis.js      -- pure functions: diffs, quick wins, keyword map, cannibalization, orphans
docs/                   -- the site itself (GitHub Pages source)
  index.html, app.js, style.css   -- Chart.js dashboard, reads docs/data/*.json
  data/*.json                     -- generated data, committed to the repo
.github/workflows/update-dashboard.yml  -- daily cron: fetch.js + commit + push
```
Pushing updated `docs/data/*.json` to `main` is what republishes the site --
GitHub Pages (branch-deploy mode) auto-rebuilds on every push to `docs/`.

## Setup

### 1. Google Cloud service account
1. console.cloud.google.com -> create/reuse a project.
2. APIs & Services -> Library -> enable **Google Search Console API**.
3. APIs & Services -> Credentials -> Create Credentials -> Service Account -> create a JSON key.
4. Copy the service account's email (`xxx@yyy.iam.gserviceaccount.com`).
5. In Search Console, for **each property** (mimicminds, mimicproductions):
   Settings -> Users and permissions -> Add user -> paste the email -> "Restricted" is enough.

### 2. Add the key as a GitHub secret
Repo -> Settings -> Secrets and variables -> Actions -> New repository secret:
- Name: `GSC_SERVICE_ACCOUNT_JSON`
- Value: the full contents of the service account JSON key file (paste as-is)

### 3. Enable GitHub Pages
Repo -> Settings -> Pages -> Source: **Deploy from a branch** -> Branch: `main`, folder `/docs`.

### 4. Run the workflow
Actions tab -> "Update GSC dashboard" -> Run workflow (or wait for the daily
cron). First successful run fetches real data and pushes it; Pages picks up
the push automatically.

## Local development
```
cd fetch
npm install
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
node fetch.js          # writes ../docs/data/*.json
cd ../docs
python3 -m http.server 8080   # or any static server
```

## Sites configured
Edit the `SITES` array in `fetch/fetch.js` to add/remove properties:
- mimicminds (`sc-domain:mimicminds.com`)
- mimic productions (`https://www.mimicproductions.com/`)

## Content Audit tab
Separate pipeline from the main dashboard above -- own data files
(`docs/data/content-audit-*.json`), own script (`fetch/content-audit.js`),
own frontend (`docs/content-audit-app.js`), reachable as a second tab on the
same page (shares the page's password lock, nothing else). Cross-references
live Wix SEO data (title/meta/focus keywords/body content, via the Wix Admin
API) against 30-day GSC performance and flags concrete issues per page, each
with its own "Apply live" button.

**Apply live** writes go through a small Cloudflare Worker
(`worker/`), because a write-capable Wix API key can never live in client-side
JS on a public static site. The Worker holds the key server-side; the button
click hits the Worker, the Worker calls Wix.

### Setup
1. Wix Admin API Key (Wix dashboard -> Settings -> API Keys -> Generate),
   scoped to at least `wix-seo.edit`, `BLOG.READ-PUBLICATION`. Site IDs are
   hardcoded in `fetch/content-audit.js` and `worker/src/index.js` -- update
   `SITES`/`SITES` map there if properties change.
2. `cd worker && npx wrangler login`, then:
   ```
   npx wrangler deploy
   npx wrangler secret put WIX_API_KEY        # paste the Wix key
   npx wrangler secret put ACTION_PASSWORD    # same password as the page lock
   ```
3. Add `WIX_API_KEY` as a GitHub Actions secret too (for `content-audit.js`'s
   own cron run, separate from the Worker's copy).
4. `worker/wrangler.toml`'s deployed URL must match `WORKER_URL` in
   `docs/content-audit-app.js`.

### Known Wix API quirks (undocumented, found by testing)
- The docs' "Method API Endpoint" field is sometimes wrong -- the curl
  example's path is the one that actually works (e.g.
  `/seo-metatags-server/v1/...`, not the declared `/promote/seo/v1/...`).
  Hit this on both Item SEO Tags and Blog Posts.
- `List Item SEO Tags` intermittently 499s at `paging.limit=100` on some
  sites/item-types (undocumented cap somewhere between 50-75) -- use 50.
- `focusKeywords` items are `{term, isMain}` objects, not plain strings.
- `resolvedTags` wraps each tag one level deeper: `{tag: {...}, source}`.
- Classic Editor/Studio static pages have no URL field anywhere in the SEO
  APIs -- matched here by fetching the live page's rendered `<title>` and
  comparing against each item's resolved title (decode HTML entities first,
  or `&amp;` vs `&` silently breaks every match).
- GSC page URLs with a `#viewer-*` fragment are deep-link variants of the
  same underlying page, not separate pages -- stripped/merged before
  building the page list, or one popular post's fragments crowd out the
  entire top-N.
