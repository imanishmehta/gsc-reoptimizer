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
