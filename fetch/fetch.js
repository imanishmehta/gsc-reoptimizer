// Pulls GSC data for each configured site and writes static JSON that
// docs/app.js renders with Chart.js. Runs via GitHub Actions on a schedule,
// or locally for testing.
//
// Auth: service account JSON via GSC_SERVICE_ACCOUNT_JSON env var (a GitHub
// Actions secret) or GOOGLE_APPLICATION_CREDENTIALS file path for local runs.
//
// Usage: node fetch.js

import { google } from 'googleapis';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchSitemapUrls, buildSiteData } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data');

const SITES = [
  { slug: 'mimicminds', label: 'mimicminds', gscSiteUrl: 'sc-domain:mimicminds.com', sitemapUrl: 'https://www.mimicminds.com/sitemap.xml' },
  { slug: 'mimicproductions', label: 'mimic productions', gscSiteUrl: 'https://www.mimicproductions.com/', sitemapUrl: 'https://www.mimicproductions.com/sitemap.xml' },
];

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function datePeriods(days = 28) {
  const curEnd = new Date();
  curEnd.setDate(curEnd.getDate() - 3); // GSC finalizes data ~3 days after the fact
  const curStart = new Date(curEnd);
  curStart.setDate(curStart.getDate() - days);
  const prevEnd = new Date(curStart);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - days);
  return {
    curStart: fmtDate(curStart), curEnd: fmtDate(curEnd),
    prevStart: fmtDate(prevStart), prevEnd: fmtDate(prevEnd),
  };
}

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
  const period = datePeriods(28);
  const { curStart, curEnd, prevStart, prevEnd } = period;
  console.log(`[${site.label}] ${prevStart}..${prevEnd} vs ${curStart}..${curEnd}`);

  const [curRows, prevRows, trendRows, sitemapUrls] = await Promise.all([
    query(client, site.gscSiteUrl, curStart, curEnd, ['page', 'query']),
    query(client, site.gscSiteUrl, prevStart, prevEnd, ['page', 'query']),
    query(client, site.gscSiteUrl, prevStart, curEnd, ['date']),
    fetchSitemapUrls(site.sitemapUrl),
  ]);

  return buildSiteData(site, { curRows, prevRows, trendRows, sitemapUrls, period });
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
