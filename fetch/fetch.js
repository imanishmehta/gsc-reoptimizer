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

// The basic Sessions/Visitors/Forms/Contact-clicks KPI (Analytics Data API)
// has a real, confirmed-by-testing hard wall: it 400s on any startDate more
// than ~60 days back, no exceptions. Capped here, current-period-only past
// that point.
const WIX_RETENTION_SAFE_DAYS = 58; // small buffer under the real ~62-day cap
function wixKpiPeriodWindow(days) {
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

// Everything else (traffic/blog/bots breakdowns, via the Semantic Model API)
// does NOT have that same wall -- confirmed live: a 6-month-back previous
// window returns real data (1534 sessions), an 8-month-back one returns
// genuinely zero (this site's Wix tracking history doesn't reach that far,
// not a query-shape or API problem). So these use the real, uncapped dates
// (same as GSC's own periods) and let "was there real data" be discovered
// per-fetch rather than predicted from a fixed day-count rule.
function wixBreakdownPeriodWindow(days) {
  return datePeriods(days); // real prevStart/prevEnd, same math GSC's periods use
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
const BOTS_MODEL_ID = '75148a55-77ce-472f-b2d2-ff31346f14b2'; // "bots" semantic model (crawler hits)

// Real bot_platform_name values seen in the wild for AI crawlers/assistants
// (there's no dimension that separates "AI" from "search engine" bots, so
// this list is what makes the AI-vs-other split possible).
const AI_BOT_PLATFORMS = new Set([
  'bot_platform_chatgpt', 'bot_platform_perplexity', 'bot_platform_gemini', 'bot_platform_claude',
  'bot_type_openai_search_bot', 'bot_type_metaai_training_bot', 'bot_type_amazonai_training_bot',
]);
function prettifyBotName(name) {
  const known = {
    bot_platform_chatgpt: 'ChatGPT', bot_platform_perplexity: 'Perplexity', bot_platform_gemini: 'Gemini', bot_platform_claude: 'Claude',
    bot_type_openai_search_bot: 'OpenAI Search Bot', bot_type_metaai_training_bot: 'Meta AI (training)', bot_type_amazonai_training_bot: 'Amazon AI (training)',
  };
  return known[name] || name;
}

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

// Fetches a (label, count) breakdown for current + previous period (real
// dates, not retention-capped -- see wixBreakdownPeriodWindow), joins them
// by label so the frontend can show a %-change badge per row.
async function queryBreakdownWithDelta(wixSiteId, modelId, labelField, countField, period) {
  const [curRows, prevRows] = await Promise.all([
    queryModel(wixSiteId, modelId, [labelField, countField], period.curStart, period.curEnd),
    queryModel(wixSiteId, modelId, [labelField, countField], period.prevStart, period.prevEnd),
  ]);
  const prevByLabel = new Map(prevRows.map(r => [r[labelField], r[countField] || 0]));
  return curRows
    .map(r => ({ label: r[labelField] || 'Unknown', count: r[countField] || 0, countPrev: prevByLabel.get(r[labelField]) || 0 }))
    .sort((a, b) => b.count - a.count);
}

async function getWixTrafficBreakdown(wixSiteId, period) {
  const [device, country, visitorType, referrerAllCur, referrerAllPrev] = await Promise.all([
    queryBreakdownWithDelta(wixSiteId, TRAFFIC_MODEL_ID, 'traffic.device_type', 'traffic.sessions_count', period),
    queryBreakdownWithDelta(wixSiteId, TRAFFIC_MODEL_ID, 'traffic.country_name', 'traffic.sessions_count', period),
    queryBreakdownWithDelta(wixSiteId, TRAFFIC_MODEL_ID, 'traffic.visitor_type', 'traffic.visitors_count', period),
    // individual sources (Google, Bing, DuckDuckGo, ChatGPT, specific
    // referring domains, ...), not just the 5 umbrella categories -- "take
    // all the sources", matches Wix's own Top Traffic Sources report.
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.referrer_source_name', 'traffic.referrer_category_name', 'traffic.sessions_count', 'traffic.visitors_count'], period.curStart, period.curEnd),
    queryModel(wixSiteId, TRAFFIC_MODEL_ID, ['traffic.referrer_source_name', 'traffic.sessions_count'], period.prevStart, period.prevEnd),
  ]);

  const prevSessionsBySource = new Map(referrerAllPrev.map(r => [r['traffic.referrer_source_name'], r['traffic.sessions_count'] || 0]));
  const referrerAll = referrerAllCur
    .map(r => ({
      source: r['traffic.referrer_source_name'] || 'Unknown',
      category: r['traffic.referrer_category_name'] || 'other',
      sessions: r['traffic.sessions_count'] || 0,
      sessionsPrev: prevSessionsBySource.get(r['traffic.referrer_source_name']) || 0,
      visitors: r['traffic.visitors_count'] || 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const aiPlatforms = referrerAll
    .filter(r => r.category === 'ai_platform')
    .map(r => ({ label: r.source, count: r.sessions, countPrev: r.sessionsPrev }));

  // Signal for the frontend: is the previous-period side real data, or is
  // this period's "previous" window reaching back before the site's Wix
  // analytics history even starts? Device breakdown always has data if
  // there was any traffic at all, so its previous-side total is a reliable
  // proxy -- confirmed live (6mo-back previous window: real data; 8mo-back:
  // genuinely zero, not a bug).
  const hasComparison = device.reduce((s, r) => s + r.countPrev, 0) > 0;

  return {
    device,
    country: country.slice(0, 8),
    visitorType,
    referrerAll: referrerAll.slice(0, 30),
    aiPlatforms,
    hasComparison,
  };
}

async function getWixBotActivity(wixSiteId, period) {
  const rows = await queryBreakdownWithDelta(wixSiteId, BOTS_MODEL_ID, 'bots.bot_platform_name', 'bots.hits_count', period);
  const named = rows.filter(r => r.label && r.label !== 'Unknown');
  const aiBots = named.filter(r => AI_BOT_PLATFORMS.has(r.label)).map(r => ({ ...r, label: prettifyBotName(r.label) }));
  const otherBots = named.filter(r => !AI_BOT_PLATFORMS.has(r.label)).map(r => ({ ...r, label: prettifyBotName(r.label) }));
  return { aiBots, otherBots };
}

async function getWixBlogAnalytics(wixSiteId, period) {
  const fields = [
    'posts.post_title_name', 'posts.post_url',
    'reactions.post_views_count', 'reactions.visitors_count', 'reactions.clicks_count',
    'reactions.reading_time_seconds_avg', 'reactions.post_engagements_count',
  ];
  const [curRows, prevRows] = await Promise.all([
    queryModel(wixSiteId, BLOG_MODEL_ID, fields, period.curStart, period.curEnd),
    queryModel(wixSiteId, BLOG_MODEL_ID, fields, period.prevStart, period.prevEnd),
  ]);
  const prevByUrl = new Map(prevRows.map(r => [r['posts.post_url'], r]));

  return curRows
    .map(r => {
      const prev = prevByUrl.get(r['posts.post_url']);
      return {
        title: r['posts.post_title_name'],
        url: r['posts.post_url'],
        views: r['reactions.post_views_count'] || 0,
        viewsPrev: prev?.['reactions.post_views_count'] || 0,
        visitors: r['reactions.visitors_count'] || 0,
        clicks: r['reactions.clicks_count'] || 0,
        clicksPrev: prev?.['reactions.clicks_count'] || 0,
        avgReadSeconds: r['reactions.reading_time_seconds_avg'] || 0,
        engagements: r['reactions.post_engagements_count'] || 0,
      };
    })
    .sort((a, b) => b.views - a.views)
    .slice(0, 50);
}

const EMPTY_METRICS = () => Object.fromEntries(WIX_ANALYTICS_TYPES.map(t => [t, { total: 0, trend: [] }]));

// One block per GSC period filter (7/30/90/180/240), so switching the
// existing period selector also updates Wix data. Two separate windows:
// the basic KPI (sessions/visitors/forms/contact) is capped to Wix's real
// ~60-day retention wall; everything else (breakdowns/blog/bots) uses the
// same real dates GSC uses, since that data isn't subject to the same cap.
async function getWixAnalyticsForPeriod(site, days) {
  const kpiPeriod = wixKpiPeriodWindow(days);
  const breakdownPeriod = wixBreakdownPeriodWindow(days);
  const [current, previous, traffic, bots, blogPosts] = await Promise.all([
    fetchWixAnalytics(site.wixSiteId, kpiPeriod.curStart, kpiPeriod.curEnd),
    kpiPeriod.hasComparison ? fetchWixAnalytics(site.wixSiteId, kpiPeriod.prevStart, kpiPeriod.prevEnd) : Promise.resolve(EMPTY_METRICS()),
    getWixTrafficBreakdown(site.wixSiteId, breakdownPeriod),
    getWixBotActivity(site.wixSiteId, breakdownPeriod),
    getWixBlogAnalytics(site.wixSiteId, breakdownPeriod),
  ]);
  return { kpiPeriod, breakdownPeriod, current, previous, traffic, bots, blogPosts };
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
