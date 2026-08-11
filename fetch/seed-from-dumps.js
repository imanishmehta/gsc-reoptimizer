// One-off: builds docs/data/*.json from already-fetched GSC JSON dumps (one
// per period per site), so the deployed site shows real content before the
// GitHub Action + service account secret take over the ongoing pipeline.
//
// Usage: node seed-from-dumps.js <config.json>
// config.json: {
//   outDir, trendFile (per site, dims=date),
//   sites: [{ slug, label, sitemapUrl, trendFile,
//             periods: { "7": {curFile, prevFile}, "30": {...}, "90": {...}, "365": {...} } }]
// }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PERIODS, datePeriods, fetchSitemapUrls, buildPeriodBlock } from './analysis.js';

async function loadRows(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return data.rows || [];
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  await mkdir(config.outDir, { recursive: true });

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of config.sites) {
    const sitemapUrls = await fetchSitemapUrls(site.sitemapUrl);
    const trendRows = await loadRows(site.trendFile);
    const trend = trendRows
      .slice()
      .sort((a, b) => a.keys[0].localeCompare(b.keys[0]))
      .map(r => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

    const periods = {};
    for (const def of PERIODS) {
      const cfg = site.periods[def.key];
      const period = { ...datePeriods(def.days), label: def.label };
      const [curRows, prevRows] = await Promise.all([loadRows(cfg.curFile), loadRows(cfg.prevFile)]);
      periods[def.key] = buildPeriodBlock({ curRows, prevRows, sitemapUrls, trend, period });
      console.log(`[${site.label}] ${def.label}: ${curRows.length} cur rows, ${prevRows.length} prev rows`);
    }

    const data = { label: site.label, trend, periods };
    await writeFile(`${config.outDir}/${site.slug}.json`, JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote ${site.slug}.json`);
  }
  await writeFile(`${config.outDir}/meta.json`, JSON.stringify(meta, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
