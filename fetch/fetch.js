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

// Orders/Sales dropped -- both sites are non-ecommerce, always 0, pure noise.
const WIX_ANALYTICS_TYPES = ['TOTAL_SESSIONS', 'TOTAL_UNIQUE_VISITORS', 'TOTAL_FORMS_SUBMITTED', 'CLICKS_TO_CONTACT'];

// Wix only retains ~62 days of analytics data. For the shorter GSC period
// filters (7/30d) this fits a real current-vs-previous comparison; for the
// longer ones (90d/6mo/8mo) the requested window gets clamped to the
// retention limit and there's no room left for a "previous" comparison at
// all -- current-period-only, clearly flagged, rather than silently wrong
// or erroring out.
const WIX_RETENTION_SAFE_DAYS = 58; // small buffer under the real ~62-day cap
function wixPeriodWindow(days) {
  const f = d => d.toISOString().slice(0, 10);
  const today = new Date();
  const maxPast = new Date(today); maxPast.setDate(maxPast.getDate() - WIX_RETENTION_SAFE_DAYS);

  const desiredCurStart = new Date(today); desiredCurStart.setDate(desiredCurStart.getDate() - days);
  const capped = desiredCurStart < maxPast;
  const curStart = capped ? maxPast : desiredCurStart;

  const prevEnd = new Date(curStart); prevEnd.setDate(prevEnd.getDate() - 1);
  const desiredPrevStart = new Date(prevEnd); desiredPrevStart.setDate(desiredPrevStart.getDate() - days);
  const hasComparison = desiredPrevStart >= maxPast;

  return {
    curStart: f(curStart), curEnd: f(today), capped,
    hasComparison,
    prevStart: hasComparison ? f(desiredPrevStart) : null,
    prevEnd: hasComparison ? f(prevEnd) : null,
  };
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

const TRAFFIC_MODEL_ID = 'cad7fd34-2c8b-4dda-8296-3f9d47fb484d'; // "traffic" semantic model
const BLOG_MODEL_ID = 'd9f2bc14-0c13-48ba-b349-df4af9bfc9f2'; // "blog" semantic model

function extractField(fields, name) {
  const f = fields[name];
  if (!f) return null;
  return 'stringValue' in f ? f.stringValue : (f.numericValue ?? null);
}

// NOTE: `sort` param on this endpoint 400s with a shape we couldn't get
// right (tried {fieldName,order}) -- results come back unsorted instead;
// sorting/slicing happens client-side (Node) after the fetch, on the
// full (small, <100 row) result set. Not worth more guessing for a
// couple hundred rows of country/referrer data.
async function queryModel(wixSiteId, semanticModelId, fields, startDate, endDate) {
  const res = await fetch('https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data', {
    method: 'POST',
    headers: { Authorization: process.env.WIX_API_KEY, 'wix-site-id': wixSiteId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      semanticModelId,
      interval: { start: `${startDate}T00:00:00.000Z`, end: `${endDate}T23:59:59.000Z` },
      fields,
    }),
  });
  if (!res.ok) throw new Error(`Wix semantic model ${res.status}: ${await res.text()}`);
  const rows = (await res.json()).results || [];
  return rows.map(r => {
    const out = {};
    for (const name of fields) out[name] = extractField(r.fields, name);
    return out;
  });
}

async function getWixTrafficBreakdown(wixSiteId, startDate, endDate) {
  const [device, country, referrer, visitorType, referrerDetail] = await Promise.all([
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.device_type', 'traffic.sessions_count'], startDate, endDate),
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.country_name', 'traffic.sessions_count'], startDate, endDate),
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.referrer_category_name', 'traffic.sessions_count'], startDate, endDate),
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.visitor_type', 'traffic.visitors_count'], startDate, endDate),
    // per-source breakdown within each category -- this is what surfaces
    // individual AI platforms (ChatGPT/Claude/Gemini/Perplexity) rather than
    // just the umbrella "ai_platform" category total.
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.referrer_category_name', 'traffic.referrer_source_name', 'traffic.sessions_count'], startDate, endDate),
  ]);
  const byCount = (rows, countField) => rows
    .map(r => ({ label: Object.values(r)[0], count: r[countField] || 0 }))
    .sort((a, b) => b.count - a.count);

  const aiPlatforms = referrerDetail
    .filter(r => r['traffic.referrer_category_name'] === 'ai_platform')
    .map(r => ({ label: r['traffic.referrer_source_name'] || 'Unknown', count: r['traffic.sessions_count'] || 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    device: byCount(device, 'traffic.sessions_count'),
    country: byCount(country, 'traffic.sessions_count').slice(0, 6),
    referrer: byCount(referrer, 'traffic.sessions_count'),
    visitorType: byCount(visitorType, 'traffic.visitors_count'),
    aiPlatforms,
  };
}

async function getWixBlogAnalytics(wixSiteId, startDate, endDate) {
  const rows = await queryModel(wixSiteId, BLOG_MODEL_ID, [
    'posts.post_title_name', 'posts.post_url',
    'reactions.post_views_count', 'reactions.visitors_count',
    'reactions.reading_time_seconds_avg', 'reactions.post_engagements_count',
  ], startDate, endDate);

  return rows
    .map(r => ({
      title: r['posts.post_title_name'],
      url: r['posts.post_url'],
      views: r['reactions.post_views_count'] || 0,
      visitors: r['reactions.visitors_count'] || 0,
      avgReadSeconds: r['reactions.reading_time_seconds_avg'] || 0,
      engagements: r['reactions.post_engagements_count'] || 0,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 25);
}

const EMPTY_METRICS = () => Object.fromEntries(WIX_ANALYTICS_TYPES.map(t => [t, { total: 0, trend: [] }]));

// One block per GSC period filter (7/30/90/180/240), so switching the
// existing period selector also updates Wix data -- capped to Wix's real
// retention window per period (see wixPeriodWindow), not silently wrong.
async function getWixAnalyticsForPeriod(site, days) {
  const period = wixPeriodWindow(days);
  const [current, previous, traffic, blogPosts] = await Promise.all([
    fetchWixAnalytics(site.wixSiteId, period.curStart, period.curEnd),
    period.hasComparison ? fetchWixAnalytics(site.wixSiteId, period.prevStart, period.prevEnd) : Promise.resolve(EMPTY_METRICS()),
    getWixTrafficBreakdown(site.wixSiteId, period.curStart, period.curEnd),
    getWixBlogAnalytics(site.wixSiteId, period.curStart, period.curEnd),
  ]);
  return { period, current, previous, traffic, blogPosts };
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

    if (process.env.WIX_API_KEY) {
      console.log(`[${site.label}] ${def.label}: fetching Wix analytics...`);
      periods[def.key].wixAnalytics = await getWixAnalyticsForPeriod(site, def.days);
    }
  }

  return { label: site.label, trend, periods };
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
