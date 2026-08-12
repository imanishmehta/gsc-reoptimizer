// Pure functions over raw GSC rows -- no network, no fs. Shared by fetch.js
// (live API) and the local seeding script.

// No 365-day filter: comparing it to a previous 365 days needs 24 months of
// GSC history, and Search Console only retains ~16 months -- the "previous"
// side would always be truncated/empty. 240 days (8 months) sits right at
// that retention edge; insufficientHistory below catches it dynamically if
// the previous window comes back thin, rather than a hardcoded day cutoff.
export const PERIODS = [
  { key: '7', days: 7, label: 'Last 7 days' },
  { key: '30', days: 30, label: 'Last 30 days' },
  { key: '90', days: 90, label: 'Last 90 days' },
  { key: '180', days: 180, label: 'Last 6 months' },
  { key: '240', days: 240, label: 'Last 8 months' },
];

// rough industry CTR-by-position curve, used only to flag pages doing worse
// than typical for their rank -- not a precise model, a directional signal.
const CTR_BENCHMARK = [
  [1, 0.28], [2, 0.15], [3, 0.10], [4, 0.07], [5, 0.06],
  [6, 0.05], [7, 0.04], [8, 0.035], [9, 0.03], [10, 0.025],
  [15, 0.015], [20, 0.01], [30, 0.006], [50, 0.003],
];

export function expectedCtr(position) {
  if (position <= CTR_BENCHMARK[0][0]) return CTR_BENCHMARK[0][1];
  for (let i = 1; i < CTR_BENCHMARK.length; i++) {
    const [p0, c0] = CTR_BENCHMARK[i - 1];
    const [p1, c1] = CTR_BENCHMARK[i];
    if (position <= p1) {
      const t = (position - p0) / (p1 - p0);
      return c0 + (c1 - c0) * t;
    }
  }
  return CTR_BENCHMARK[CTR_BENCHMARK.length - 1][1];
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export function datePeriods(days) {
  const curEnd = new Date();
  curEnd.setDate(curEnd.getDate() - 3); // GSC finalizes data ~3 days after the fact
  const curStart = new Date(curEnd);
  curStart.setDate(curStart.getDate() - days);
  const prevEnd = new Date(curStart);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - days);
  return {
    days,
    curStart: fmtDate(curStart), curEnd: fmtDate(curEnd),
    prevStart: fmtDate(prevStart), prevEnd: fmtDate(prevEnd),
  };
}

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

// Sums accurate site-level totals from date-dimension rows over a range.
// Used for headline KPIs -- these must match Google's own Performance report.
// (page,query)-dimension sums do NOT match: Google's API allows a single
// impression to attribute to multiple similar queries, inflating impressions,
// while rare/anonymized queries get dropped from query-level rows entirely,
// deflating clicks. That skew is fine for relative breakdowns (decliners,
// quick wins) but wrong for a headline number a user checks against GSC's UI.
export function sumTrend(trendRows, start, end) {
  let clicks = 0, impressions = 0, posWeighted = 0;
  for (const r of trendRows) {
    if (r.date < start || r.date > end) continue;
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return {
    clicks, impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? posWeighted / impressions : 0,
  };
}

// Classifies why a page's numbers moved. Thresholds are deliberately coarse
// -- this is meant to separate "ignore this" (fluctuation) from "look at
// this" (demand/ranking/ctr), not to be a precise attribution model.
export function classify(cur, prev) {
  const impDelta = prev.impressions > 0 ? (cur.impressions - prev.impressions) / prev.impressions : (cur.impressions > 0 ? Infinity : 0);
  const posDelta = cur.position - prev.position; // positive = worse

  if (Math.abs(impDelta) < 0.15 && Math.abs(posDelta) < 1) return 'fluctuation';
  if (Math.abs(impDelta) > 0.2 && Math.abs(posDelta) < 1.5) return impDelta < 0 ? 'demand-drop' : 'demand-rise';
  if (posDelta > 1.5) return 'ranking-drop';
  if (posDelta < -1.5) return 'ranking-rise';
  if (cur.clicks < prev.clicks && Math.abs(posDelta) < 1.5) return 'ctr-drop';
  return 'fluctuation';
}

const CAUSE_TEXT = {
  'demand-drop': "Search interest for this page's queries genuinely fell (impressions down, position steady) -- not a site problem. Low priority unless it's a strategic keyword.",
  'demand-rise': 'Search interest is growing (impressions up, position steady) -- expand content depth/coverage while the topic is hot.',
  'ranking-drop': 'Position got worse while impressions held or grew -- a competitor outranked it, or a content/backlink/technical issue. Refresh content and add internal links.',
  'ranking-rise': 'Position improved -- whatever changed here worked. Consider applying the same treatment (title, content depth, internal links) to similar pages.',
  'ctr-drop': "Position and impressions held but clicks fell -- the title/meta no longer matches intent, or a SERP feature (AI Overview, snippet) is stealing the click. Rewrite title/meta.",
  'fluctuation': 'Change is within normal week-to-week noise -- no action needed.',
};

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

// Site-wide queries gaining impressions that aren't necessarily tied to one
// page yet -- candidates for a new or heavily-updated piece of content.
export function growingQueries(curRows, prevRows, minImpressions = 100) {
  const curQ = aggregateBy(curRows, 1);
  const prevQ = aggregateBy(prevRows, 1);
  const bestPagePerQuery = new Map();
  for (const r of curRows) {
    const q = r.keys[1];
    const existing = bestPagePerQuery.get(q);
    if (!existing || r.clicks > existing.clicks) bestPagePerQuery.set(q, { page: r.keys[0], clicks: r.clicks });
  }
  const out = [];
  for (const [query, cur] of curQ) {
    if (cur.impressions < minImpressions) continue;
    const prev = prevQ.get(query) || { impressions: 0, clicks: 0, position: 0 };
    const impDelta = prev.impressions > 0 ? (cur.impressions - prev.impressions) / prev.impressions : Infinity;
    if (impDelta > 0.3) {
      out.push({
        query, impressions: cur.impressions, position: cur.position, ctr: cur.ctr,
        impressionsDeltaPct: Math.round(impDelta * 100),
        currentPage: bestPagePerQuery.get(query)?.page || null,
      });
    }
  }
  out.sort((a, b) => b.impressions - a.impressions);
  return out.slice(0, 15);
}

function keywordsForPage(curRows, page, limit = 8) {
  const rows = curRows
    .filter(r => r.keys[0] === page)
    .map(r => ({ query: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position, ctr: r.ctr }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return rows.slice(0, limit);
}

function opportunityScore(k) {
  return k.impressions / Math.max(k.position, 1);
}

// The core "what do I actually do" output: one entry per focus page, combining
// cause classification, keyword targeting advice, a CTR-vs-benchmark check,
// and an internal-linking heuristic (GSC's API has no real link graph, so
// this recommends linking from the site's current top-traffic pages -- a
// best-practice heuristic, not a crawled link audit).
export function buildReoptimization(diffRows, curRows, topPagesByClicks, linkCandidates) {
  return diffRows.map(row => {
    const keywords = keywordsForPage(curRows, row.page);
    const primary = keywords[0] || null;
    let suggestedPrimary = null;
    if (primary) {
      const primaryScore = opportunityScore(primary);
      for (const k of keywords.slice(1)) {
        if (opportunityScore(k) > primaryScore * 1.3 && k.impressions >= primary.impressions * 0.4) {
          suggestedPrimary = k;
          break;
        }
      }
    }

    let ctrBenchmark = null;
    if (primary && primary.impressions >= 30) {
      const expected = expectedCtr(primary.position);
      const gapPct = expected > 0 ? Math.round(((primary.ctr - expected) / expected) * 100) : null;
      ctrBenchmark = { expected, actual: primary.ctr, gapPct };
    }

    const internalLinkSuggestion = relatedPages(row.page, linkCandidates, topPagesByClicks);

    const actions = [];
    actions.push(CAUSE_TEXT[row.cause]);
    if (suggestedPrimary) {
      actions.push(`Query "${suggestedPrimary.query}" has better opportunity (${suggestedPrimary.impressions} impr at position ${suggestedPrimary.position.toFixed(1)}) than the current top query "${primary.query}" -- consider making it the primary target: work it into the title/H1 and expand content around it.`);
    }
    if (ctrBenchmark && ctrBenchmark.gapPct !== null && ctrBenchmark.gapPct < -30) {
      actions.push(`CTR is ${Math.abs(ctrBenchmark.gapPct)}% below typical for position ${primary.position.toFixed(1)} (${(ctrBenchmark.actual * 100).toFixed(2)}% vs ~${(ctrBenchmark.expected * 100).toFixed(1)}% expected) -- title/meta likely isn't matching search intent, rewrite it.`);
    }
    if (row.cause === 'ranking-drop' || row.cause === 'demand-drop') {
      actions.push(`Add internal links from your top-traffic pages (${internalLinkSuggestion.map(shortLabel).join(', ') || 'homepage'}) to strengthen this page's relevance signal.`);
    }

    return {
      page: row.page,
      cause: row.cause,
      causeText: CAUSE_TEXT[row.cause],
      primaryKeywordCurrent: primary,
      primaryKeywordSuggested: suggestedPrimary,
      secondaryKeywords: keywords.slice(1, 6),
      ctrBenchmark,
      internalLinkSuggestion,
      actions,
    };
  });
}

function shortLabel(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
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

const STOPWORDS = new Set(['post', 'service', 'services', 'industries', 'industry', 'the', 'for', 'with', 'and', 'ai', 'vs']);

function tokenize(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return new Set(
    path.split(/[/\-_]+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

// Picks internal-link targets by topical overlap (shared URL-path words)
// instead of always the same global top pages -- GSC's API has no real
// content/topic data, so this is a heuristic proxy, not a crawled analysis.
// Falls back to top-traffic pages when no topical overlap is found.
function relatedPages(targetUrl, candidatePages, topPagesByClicks, limit = 3) {
  const targetTokens = tokenize(targetUrl);
  const scored = candidatePages
    .filter(p => p !== targetUrl)
    .map(page => {
      const tokens = tokenize(page);
      let overlap = 0;
      for (const t of targetTokens) if (tokens.has(t)) overlap++;
      return { page, overlap };
    })
    .filter(s => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  const picked = scored.slice(0, limit).map(s => s.page);
  for (const p of topPagesByClicks) {
    if (picked.length >= limit) break;
    if (p !== targetUrl && !picked.includes(p)) picked.push(p);
  }
  return picked;
}

function prettifyAppearance(key) {
  return key
    .toLowerCase()
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Search Appearance breaks down traffic by rich-result/SERP-feature type.
// Google surfaces AI Overview presence here (key contains "AI") -- this is
// the closest real signal GSC exposes for "is this site showing up in
// generative AI answers," not a separate product API.
function buildSearchAppearance(appearanceCur, appearancePrev) {
  const prevMap = new Map(appearancePrev.map(r => [r.keys[0], r]));
  const rows = appearanceCur
    .map(r => {
      const key = r.keys[0];
      const prev = prevMap.get(key);
      return {
        type: key,
        label: prettifyAppearance(key),
        isAI: key.toUpperCase().includes('AI'),
        clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
        clicksPrev: prev ? prev.clicks : 0, impressionsPrev: prev ? prev.impressions : 0,
      };
    })
    .sort((a, b) => b.impressions - a.impressions);

  const aiOverview = rows.find(r => r.isAI) || null;
  return { rows, aiOverview };
}

export function buildPeriodBlock({ curRows, prevRows, sitemapUrls, period, trend, images, appearanceCur, appearancePrev }) {
  const curPageMap = aggregateBy(curRows, 0);
  const prevPageMap = aggregateBy(prevRows, 0);

  // headline uses date-dimension totals (accurate, matches GSC's own
  // Performance report) -- NOT the page/query-dimension sums, which Google's
  // API skews (see sumTrend comment above).
  const curTotals = sumTrend(trend, period.curStart, period.curEnd);
  const prevTotals = sumTrend(trend, period.prevStart, period.prevEnd);

  const diff = pageDiff(curPageMap, prevPageMap);
  const decliners = diff.slice(0, 15);
  const risers = diff.slice().reverse().slice(0, 10);
  const focusRows = [...decliners.slice(0, 8), ...risers.slice(0, 3)];

  const topPagesByClicks = [...curPageMap.entries()]
    .sort((a, b) => b[1].clicks - a[1].clicks)
    .slice(0, 5)
    .map(([page]) => page);

  // full page set for topical matching -- click volume only matters for the
  // fallback tier (topPagesByClicks), not for finding a relevant match
  const linkCandidates = [...curPageMap.keys()];

  const orphanUrls = sitemapUrls.filter(u => !curPageMap.has(u) || curPageMap.get(u).impressions === 0);
  const orphanPages = orphanUrls.map(url => ({
    url,
    internalLinkSuggestion: relatedPages(url, linkCandidates, topPagesByClicks),
  }));

  // Date-based, not ratio-based: a real 10x+ organic growth spike (this
  // happens -- a page catching a broad head-term query can 10x impressions
  // in months) looks identical to retention truncation on a ratio check, but
  // isn't. Only flag when the previous window's start actually falls near
  // GSC's ~487-day (16mo) retention edge.
  const prevStartAgeDays = Math.floor((Date.now() - new Date(period.prevStart + 'T00:00:00Z').getTime()) / 86400000);
  const RETENTION_SAFE_DAYS = 450;

  return {
    period,
    insufficientHistory: prevTotals.impressions < 10 || prevStartAgeDays > RETENTION_SAFE_DAYS,
    headline: { current: curTotals, previous: prevTotals },
    decliners,
    risers,
    quickWins: quickWins(curRows),
    growingQueries: growingQueries(curRows, prevRows),
    reoptimization: buildReoptimization(focusRows, curRows, topPagesByClicks, linkCandidates),
    orphanPages,
    sitemapUrlCount: sitemapUrls.length,
    images,
    searchAppearance: buildSearchAppearance(appearanceCur, appearancePrev),
  };
}
