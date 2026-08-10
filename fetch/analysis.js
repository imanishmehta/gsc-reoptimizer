// Pure functions over raw GSC rows -- no network, no fs. Shared by fetch.js
// (live API) and any one-off local seeding script.

export function aggregateBy(rows, keyIndex) {
  const map = new Map();
  for (const r of rows) {
    const key = r.keys[keyIndex];
    const cur = map.get(key) || { clicks: 0, impressions: 0, posWeighted: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posWeighted += r.position * r.impressions;
    map.set(key, cur);
  }
  const out = new Map();
  for (const [key, v] of map) {
    out.set(key, {
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
      position: v.impressions > 0 ? v.posWeighted / v.impressions : 0,
    });
  }
  return out;
}

export function totals(pageMap) {
  let clicks = 0, impressions = 0, posWeighted = 0;
  for (const v of pageMap.values()) {
    clicks += v.clicks;
    impressions += v.impressions;
    posWeighted += v.position * v.impressions;
  }
  return {
    clicks, impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? posWeighted / impressions : 0,
  };
}

export function classify(cur, prev) {
  const impDelta = prev.impressions > 0 ? (cur.impressions - prev.impressions) / prev.impressions : 0;
  const posDelta = cur.position - prev.position; // positive = worse
  if (Math.abs(impDelta) > 0.2 && Math.abs(posDelta) < 1) return impDelta < 0 ? 'demand-drop' : 'demand-rise';
  if (posDelta > 1) return 'ranking-drop';
  if (posDelta < -1) return 'ranking-rise';
  if (cur.clicks < prev.clicks) return 'ctr-drop';
  return 'mixed';
}

export function pageDiff(curMap, prevMap) {
  const keys = new Set([...curMap.keys(), ...prevMap.keys()]);
  const zero = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const rows = [];
  for (const page of keys) {
    const c = curMap.get(page) || zero;
    const p = prevMap.get(page) || zero;
    rows.push({
      page,
      clicks_new: c.clicks, clicks_old: p.clicks, delta_clicks: c.clicks - p.clicks,
      impressions_new: c.impressions, impressions_old: p.impressions, delta_impressions: c.impressions - p.impressions,
      ctr_new: c.ctr, ctr_old: p.ctr,
      position_new: Math.round(c.position * 10) / 10, position_old: Math.round(p.position * 10) / 10,
      delta_position: Math.round((c.position - p.position) * 10) / 10,
      cause: classify(c, p),
    });
  }
  rows.sort((a, b) => a.delta_clicks - b.delta_clicks);
  return rows;
}

export function quickWins(curRows, { minImpressions = 50, maxCtr = 0.02, posMin = 4, posMax = 15 } = {}) {
  return curRows
    .filter(r => r.impressions >= minImpressions && r.ctr <= maxCtr && r.position >= posMin && r.position <= posMax)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 40)
    .map(r => ({ query: r.keys[1], page: r.keys[0], position: r.position, ctr: r.ctr, impressions: r.impressions, clicks: r.clicks }));
}

export function keywordMap(curRows, pages) {
  const byPage = new Map();
  for (const r of curRows) {
    const page = r.keys[0];
    if (!pages.has(page)) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({ query: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position });
  }
  const out = [];
  for (const [page, kws] of byPage) {
    kws.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    out.push({ page, keywords: kws.slice(0, 6) });
  }
  return out;
}

export function cannibalization(curRows, minImpressions = 20) {
  const byQuery = new Map();
  for (const r of curRows) {
    if (r.impressions < minImpressions) continue;
    const q = r.keys[1];
    if (!byQuery.has(q)) byQuery.set(q, []);
    byQuery.get(q).push({ page: r.keys[0], impressions: r.impressions, clicks: r.clicks, position: r.position });
  }
  const out = [];
  for (const [query, pages] of byQuery) {
    if (pages.length > 1) {
      pages.sort((a, b) => b.impressions - a.impressions);
      out.push({ query, pages });
    }
  }
  out.sort((a, b) => b.pages.reduce((s, p) => s + p.impressions, 0) - a.pages.reduce((s, p) => s + p.impressions, 0));
  return out.slice(0, 20);
}

export async function fetchSitemapUrls(url, depth = 0) {
  if (depth > 3) return [];
  let xml;
  try {
    const res = await fetch(url);
    xml = await res.text();
  } catch {
    return [];
  }
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  if (xml.includes('<sitemapindex')) {
    const nested = await Promise.all(locs.map(l => fetchSitemapUrls(l, depth + 1)));
    return nested.flat();
  }
  return locs;
}

export function buildSiteData(site, { curRows, prevRows, trendRows, sitemapUrls, period }) {
  const curPageMap = aggregateBy(curRows, 0);
  const prevPageMap = aggregateBy(prevRows, 0);
  const diff = pageDiff(curPageMap, prevPageMap);
  const decliners = diff.slice(0, 15);
  const risers = diff.slice().reverse().slice(0, 10);
  const focusPages = new Set([...decliners.slice(0, 8), ...risers.slice(0, 3)].map(r => r.page));

  const trend = trendRows
    .slice()
    .sort((a, b) => a.keys[0].localeCompare(b.keys[0]))
    .map(r => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));

  const orphanPages = sitemapUrls.filter(u => !curPageMap.has(u) || curPageMap.get(u).impressions === 0);

  return {
    label: site.label,
    period,
    headline: { current: totals(curPageMap), previous: totals(prevPageMap) },
    trend,
    decliners,
    risers,
    quickWins: quickWins(curRows),
    keywordMap: keywordMap(curRows, focusPages),
    cannibalization: cannibalization(curRows),
    orphanPages,
    sitemapUrlCount: sitemapUrls.length,
  };
}
