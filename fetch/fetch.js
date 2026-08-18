// Pulls GSC data for each configured site across all period filters (7/30/90
// days, 6mo/8mo) and writes static JSON that docs/app.js renders with
// Chart.js. Runs via GitHub Actions on a daily schedule, or locally for testing.
//
// Auth: service account JSON via GSC_SERVICE_ACCOUNT_JSON env var (a GitHub
// Actions secret) or GOOGLE_APPLICATION_CREDENTIALS file path for local runs.
//
// Usage: node fetch.js

import { google } from 'googleapis';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PERIODS, datePeriods, fetchSitemapUrls, buildPeriodBlock } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data');

const SITES = [
  { slug: 'mimicminds', label: 'mimicminds', gscSiteUrl: 'sc-domain:mimicminds.com', sitemapUrl: 'https://www.mimicminds.com/sitemap.xml', wixSiteId: '1d570b1b-ba44-4cdd-bb4b-176a7afb7d75' },
  { slug: 'mimicproductions', label: 'mimic productions', gscSiteUrl: 'https://www.mimicproductions.com/', sitemapUrl: 'https://www.mimicproductions.com/sitemap.xml', wixSiteId: '20db1d0f-b8d3-49e6-8100-03577875df69' },
];

const WIX_ANALYTICS_TYPES = ['TOTAL_SESSIONS', 'TOTAL_UNIQUE_VISITORS', 'TOTAL_ORDERS', 'TOTAL_SALES', 'TOTAL_FORMS_SUBMITTED', 'CLICKS_TO_CONTACT'];

// Wix only retains 62 days of analytics data -- 28+28 current/previous
// leaves a 6-day safety margin rather than cutting it right at the edge.
function wixAnalyticsPeriods() {
  const curEnd = new Date();
  const curStart = new Date(curEnd); curStart.setDate(curStart.getDate() - 28);
  const prevEnd = new Date(curStart); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 28);
  const f = d => d.toISOString().slice(0, 10);
  return { curStart: f(curStart), curEnd: f(curEnd), prevStart: f(prevStart), prevEnd: f(prevEnd) };
}

async function fetchWixAnalytics(wixSiteId, startDate, endDate) {
  const params = new URLSearchParams({ 'dateRange.startDate': startDate, 'dateRange.endDate': endDate });
  for (const t of WIX_ANALYTICS_TYPES) params.append('measurementTypes', t);
  const res = await fetch(`https://www.wixapis.com/analytics/v2/site-analytics/data?${params}`, {
    headers: { Authorization: process.env.WIX_API_KEY, 'wix-site-id': wixSiteId },
  });
  if (!res.ok) throw new Error(`Wix analytics ${res.status}: ${await res.text()}`);
  const data = (await res.json()).data || [];
  const byType = {};
  for (const d of data) byType[d.type] = { total: d.total, trend: d.values || [] };
  return byType;
}

async function getWixSiteAnalytics(site) {
  if (!process.env.WIX_API_KEY) return null; // optional -- skip cleanly if not configured
  const period = wixAnalyticsPeriods();
  const [current, previous] = await Promise.all([
    fetchWixAnalytics(site.wixSiteId, period.curStart, period.curEnd),
    fetchWixAnalytics(site.wixSiteId, period.prevStart, period.prevEnd),
  ]);
  return { period, current, previous };
}

async function getClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    credentials: process.env.GSC_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON) : undefined,
    scopes: ['https://www.googleapis.com/auth/webmasters'],
  });
  return google.searchconsole({ version: 'v1', auth });
}

async function query(client, siteUrl, startDate, endDate, dimensions, rowLimit = 25000, type = undefined) {
  const res = await client.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions, rowLimit, ...(type ? { type } : {}) },
  });
  return res.data.rows || [];
}

// dims=[] returns a single aggregate row for the whole range -- used for
// image-search totals, where we don't need a per-page/query breakdown.
async function queryTotal(client, siteUrl, startDate, endDate, type) {
  const rows = await query(client, siteUrl, startDate, endDate, [], 1, type);
  const r = rows[0];
  return r
    ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

async function processSite(client, site) {
  console.log(`[${site.label}] fetching sitemap...`);
  const sitemapUrls = await fetchSitemapUrls(site.sitemapUrl);

  // longest span needed for the trend chart: previous-period start of the
  // longest configured filter, through current-end
  const maxDays = Math.max(...PERIODS.map(p => p.days));
  const longest = datePeriods(maxDays);
  const trendRowsRaw = await query(client, site.gscSiteUrl, longest.prevStart, longest.curEnd, ['date']);
  const trend = trendRowsRaw
    .sort((a, b) => a.keys[0].localeCompare(b.keys[0]))
    .map(r => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

  const periods = {};
  for (const def of PERIODS) {
    const period = datePeriods(def.days);
    console.log(`[${site.label}] ${def.label}: ${period.prevStart}..${period.prevEnd} vs ${period.curStart}..${period.curEnd}`);
    const [curRows, prevRows, imagesCur, imagesPrev, appearanceCur, appearancePrev] = await Promise.all([
      query(client, site.gscSiteUrl, period.curStart, period.curEnd, ['page', 'query']),
      query(client, site.gscSiteUrl, period.prevStart, period.prevEnd, ['page', 'query']),
      queryTotal(client, site.gscSiteUrl, period.curStart, period.curEnd, 'image'),
      queryTotal(client, site.gscSiteUrl, period.prevStart, period.prevEnd, 'image'),
      query(client, site.gscSiteUrl, period.curStart, period.curEnd, ['searchAppearance'], 25),
      query(client, site.gscSiteUrl, period.prevStart, period.prevEnd, ['searchAppearance'], 25),
    ]);
    periods[def.key] = buildPeriodBlock({
      curRows, prevRows, sitemapUrls, trend,
      images: { current: imagesCur, previous: imagesPrev },
      appearanceCur, appearancePrev,
      period: { ...period, label: def.label },
    });
  }

  console.log(`[${site.label}] fetching Wix site analytics...`);
  const wixAnalytics = await getWixSiteAnalytics(site);

  return { label: site.label, trend, periods, wixAnalytics };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const client = await getClient();

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of SITES) {
    const data = await processSite(client, site);
    await writeFile(path.join(OUT_DIR, `${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote ${site.slug}.json`);
  }
  await writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
