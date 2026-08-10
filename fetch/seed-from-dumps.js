// One-off: builds docs/data/*.json from already-fetched GSC JSON dumps,
// so the deployed site shows real content before the service account /
// GitHub Action is wired up. Not part of the ongoing pipeline -- fetch.js
// (via the scheduled Action) takes over once GSC_SERVICE_ACCOUNT_JSON exists.
//
// Usage: node seed-from-dumps.js <config.json>
// config.json: { outDir, sites: [{ slug, label, period, curFile, prevFile, trendFile, sitemapUrl }] }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchSitemapUrls, buildSiteData } from './analysis.js';

async function loadRows(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return data.rows || [];
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  await mkdir(config.outDir, { recursive: true });

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of config.sites) {
    const [curRows, prevRows, trendRows, sitemapUrls] = await Promise.all([
      loadRows(site.curFile),
      loadRows(site.prevFile),
      loadRows(site.trendFile),
      fetchSitemapUrls(site.sitemapUrl),
    ]);
    const data = buildSiteData(site, { curRows, prevRows, trendRows, sitemapUrls, period: site.period });
    await writeFile(`${config.outDir}/${site.slug}.json`, JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote ${site.slug}.json (${curRows.length} cur rows, ${prevRows.length} prev rows, ${sitemapUrls.length} sitemap urls)`);
  }
  await writeFile(`${config.outDir}/meta.json`, JSON.stringify(meta, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
