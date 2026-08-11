// Pulls GSC data for each configured site across all period filters (7/30/90/365
// days) and writes static JSON that docs/app.js renders with Chart.js. Runs via
// GitHub Actions on a daily schedule, or locally for testing.
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
  { slug: 'mimicminds', label: 'mimicminds', gscSiteUrl: 'sc-domain:mimicminds.com', sitemapUrl: 'https://www.mimicminds.com/sitemap.xml' },
  { slug: 'mimicproductions', label: 'mimic productions', gscSiteUrl: 'https://www.mimicproductions.com/', sitemapUrl: 'https://www.mimicproductions.com/sitemap.xml' },
];

async function getClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    credentials: process.env.GSC_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON) : undefined,
    scopes: ['https://www.googleapis.com/auth/webmasters'],
  });
  return google.searchconsole({ version: 'v1', auth });
}

async function query(client, siteUrl, startDate, endDate, dimensions, rowLimit = 25000) {
  const res = await client.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions, rowLimit },
  });
  return res.data.rows || [];
}

async function processSite(client, site) {
  console.log(`[${site.label}] fetching sitemap...`);
  const sitemapUrls = await fetchSitemapUrls(site.sitemapUrl);

  // longest span needed for the trend chart: previous-365 start through current-end
  const longest = datePeriods(365);
  const trendRowsRaw = await query(client, site.gscSiteUrl, longest.prevStart, longest.curEnd, ['date']);
  const trend = trendRowsRaw
    .sort((a, b) => a.keys[0].localeCompare(b.keys[0]))
    .map(r => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

  const periods = {};
  for (const def of PERIODS) {
    const period = datePeriods(def.days);
    console.log(`[${site.label}] ${def.label}: ${period.prevStart}..${period.prevEnd} vs ${period.curStart}..${period.curEnd}`);
    const [curRows, prevRows] = await Promise.all([
      query(client, site.gscSiteUrl, period.curStart, period.curEnd, ['page', 'query']),
      query(client, site.gscSiteUrl, period.prevStart, period.prevEnd, ['page', 'query']),
    ]);
    periods[def.key] = buildPeriodBlock({ curRows, prevRows, sitemapUrls, trend, period: { ...period, label: def.label } });
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
