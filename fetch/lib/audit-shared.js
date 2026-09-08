// Shared GSC-pull + Wix-item-matching logic used by both content-audit.js
// (meta tags) and content-reoptimize.js (body content) -- same top-N-pages
// pull, same "which Wix SEO item does this URL belong to" matching, so it
// lives once here instead of twice.

import { google } from 'googleapis';
import { PERIODS, datePeriods, classify, expectedCtr } from '../analysis.js';

export { PERIODS };

export const TOP_N_PAGES = 20;
// How many candidate pages (by current-period impressions) to classify per
// period before filtering down to underperformers -- generous enough that a
// real decliner outside the top 20 doesn't get missed, small enough that the
// per-page Wix-matching + live-crawl work stays bounded.
const CANDIDATE_POOL_SIZE = 40;

const STOPWORDS = new Set(['post', 'the', 'for', 'with', 'and', 'ai', 'vs', 'a', 'an', 'to', 'in', 'of', 'on']);
export function tokenize(text) {
  return new Set(
    (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

// ---------- GSC ----------

export async function getGscClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    credentials: process.env.GSC_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON) : undefined,
    scopes: ['https://www.googleapis.com/auth/webmasters'],
  });
  return google.searchconsole({ version: 'v1', auth });
}

async function gscQuery(client, siteUrl, startDate, endDate, dimensions, rowLimit = 25000) {
  const res = await client.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions, rowLimit },
  });
  return res.data.rows || [];
}

// One GSC pull for an arbitrary date range, dims ['page','query']. Returns
// per-page query breakdown (sorted by clicks) and per-page totals -- the
// building block getPeriodTargets uses for both the current and previous
// window of every period.
export async function gscPageQueryData(client, siteUrl, startDate, endDate) {
  const rows = await gscQuery(client, siteUrl, startDate, endDate, ['page', 'query']);

  // Strip URL fragments (#viewer-xxx) -- these are duplicate-content deep-link
  // variants of the same underlying page/post, not separate content. Without
  // this, a single popular post can occupy most of the top-N slots as its own
  // fragment variants, crowding out genuinely different pages.
  const byPageQuery = new Map(); // "page query" -> merged row
  for (const r of rows) {
    const [rawPage, query] = r.keys;
    const page = rawPage.split('#')[0];
    const key = `${page} ${query}`;
    const existing = byPageQuery.get(key);
    if (existing) {
      existing.clicks += r.clicks;
      existing.impressions += r.impressions;
      existing.posWeighted += r.position * r.impressions;
    } else {
      byPageQuery.set(key, { page, query, clicks: r.clicks, impressions: r.impressions, posWeighted: r.position * r.impressions });
    }
  }

  const byPage = new Map();
  for (const { page, query, clicks, impressions, posWeighted } of byPageQuery.values()) {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push({
      query, clicks, impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? posWeighted / impressions : 0,
    });
  }
  for (const queries of byPage.values()) queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const pageTotals = new Map();
  for (const [page, queries] of byPage) {
    const impressions = queries.reduce((s, q) => s + q.impressions, 0);
    const clicks = queries.reduce((s, q) => s + q.clicks, 0);
    const posWeighted = queries.reduce((s, q) => s + q.position * q.impressions, 0);
    pageTotals.set(page, {
      impressions, clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? posWeighted / impressions : 0,
    });
  }

  return { byPage, pageTotals };
}

// Same "is this page actually declining" signal Reoptimizer's own
// decliners/quick-wins already use (classify() + the CTR-vs-expected-
// benchmark check) -- reused rather than reinvented so a page flagged here
// matches what the Reoptimizer tab already calls declining.
//
// Returns an underperformer-specific cause ('ranking-drop' | 'ctr-drop' |
// 'low-ctr'), or null if the page doesn't qualify. Deliberately does NOT
// just pass through classify()'s raw label: a page can classify as
// 'ranking-rise' (its trend is fine) while still having objectively low CTR
// for its position -- surfacing "ranking rise" as the reason it needs
// optimizing would be actively misleading, so the low-CTR path always
// reports 'low-ctr' regardless of what classify() said about the trend.
export function underperformerCause(cause, cur) {
  if (cause === 'ranking-drop' || cause === 'ctr-drop') return cause;
  if (cur.impressions >= 30 && cur.ctr < expectedCtr(cur.position) * 0.5) return 'low-ctr';
  return null;
}

// Per-period underperformer detection, shared by content-audit.js,
// content-reoptimize.js, and content-links.js -- same list everywhere for a
// given site+period, computed once per script run (each script still pulls
// its own GSC data independently; this just makes sure they agree on which
// pages qualify).
export async function getPeriodTargets(gscClient, site, days) {
  const period = datePeriods(days);
  const [cur, prev] = await Promise.all([
    gscPageQueryData(gscClient, site.gscSiteUrl, period.curStart, period.curEnd),
    gscPageQueryData(gscClient, site.gscSiteUrl, period.prevStart, period.prevEnd),
  ]);

  const candidatePages = [...cur.pageTotals.entries()]
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .slice(0, CANDIDATE_POOL_SIZE)
    .map(([page]) => page);

  const targets = [];
  for (const page of candidatePages) {
    const curTotals = cur.pageTotals.get(page);
    const prevTotals = prev.pageTotals.get(page) || { impressions: 0, clicks: 0, ctr: 0, position: 0 };
    const cause = underperformerCause(classify(curTotals, prevTotals), curTotals);
    if (!cause) continue;
    const queries = cur.byPage.get(page) || [];
    targets.push({
      url: page, cause,
      primary: queries[0] || null,
      secondary: queries.slice(1, 6),
      curTotals, prevTotals,
    });
  }
  return { period, targets };
}

// ---------- Wix ----------

export async function wixFetch(siteId, path, options = {}) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    ...options,
    headers: {
      Authorization: process.env.WIX_API_KEY,
      'wix-site-id': siteId,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Wix ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listItemSeoTags(siteId, itemType) {
  const items = [];
  let cursor;
  do {
    // 100 intermittently 499s on this endpoint (undocumented cap, confirmed
    // via direct testing between 50 and 75) -- 50 is confirmed reliable.
    const q = new URLSearchParams({ 'paging.limit': '50' });
    if (cursor) q.set('paging.cursor', cursor);
    const data = await wixFetch(siteId, `/seo-metatags-server/v1/item-seo-tags/${itemType}?${q}`);
    items.push(...(data.itemSeoTags || []));
    cursor = data.pagingMetadata?.hasNext ? data.pagingMetadata?.cursors?.next : null;
  } while (cursor);
  return items;
}

export async function listBlogPosts(siteId) {
  const posts = [];
  let offset = 0;
  for (;;) {
    const data = await wixFetch(siteId, '/blog/v3/posts/query', {
      method: 'POST',
      body: JSON.stringify({
        fieldsets: ['URL', 'CONTENT_TEXT'],
        query: { paging: { limit: 100, offset } },
      }),
    });
    const batch = data.posts || [];
    posts.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return posts;
}

export function extractTag(tags, type, propsName) {
  const tag = propsName ? tags.find(t => t.type === type && t.props?.name === propsName) : tags.find(t => t.type === type);
  return tag ? (tag.children ?? tag.props?.content ?? null) : null;
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
export function decodeEntities(text) {
  return text.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => HTML_ENTITIES[e]);
}

function extractInternalLinks(html, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const links = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 60) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    let abs;
    try { abs = new URL(m[1], pageUrl).href; } catch { continue; }
    if (!abs.startsWith(origin)) continue; // internal links only
    const key = `${abs}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ anchorText: text, href: abs });
  }
  return links;
}

function collectSchemaTypes(node, types) {
  if (Array.isArray(node)) { node.forEach(n => collectSchemaTypes(n, types)); return; }
  if (!node || typeof node !== 'object') return;
  if (node['@type']) (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).forEach(t => types.add(t));
  if (node['@graph']) collectSchemaTypes(node['@graph'], types);
}

function extractSchemaTypes(html) {
  const types = new Set();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { collectSchemaTypes(JSON.parse(m[1]), types); } catch { /* malformed JSON-LD -- skip, don't crash the run */ }
  }
  return [...types];
}

// H2/H3 section headings, in document order -- lets the Content
// Reoptimization AI target a specific existing section for a new paragraph
// (e.g. "add this after the 'Benefits' section") instead of only ever being
// able to append at the very end of the post.
function extractHeadings(html) {
  const heads = [];
  const re = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) && heads.length < 40) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text) heads.push({ level: Number(m[1]), text });
  }
  return heads;
}

const liveCrawlCache = new Map();

// Fetches a page's live HTML once and extracts everything downstream needs
// from it: title (for static-page Wix-item matching), internal links (the
// Internal Linking tab's "before" state), meta keywords, and JSON-LD schema
// types (Meta Optimization's schema check). Cached by URL for the life of
// the process -- a page can qualify as an underperformer in multiple
// periods within one script run, and its live content doesn't change based
// on which GSC window is being analyzed, so re-fetching per period would be
// pure waste.
export async function crawlLivePage(url) {
  if (liveCrawlCache.has(url)) return liveCrawlCache.get(url);
  const promise = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (content-audit-bot)' } });
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const keywordsMatch = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i);
      return {
        title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
        internalLinks: extractInternalLinks(html, url),
        metaKeywords: keywordsMatch ? decodeEntities(keywordsMatch[1].trim()) : null,
        schemaTypes: extractSchemaTypes(html),
        headings: extractHeadings(html),
      };
    } catch {
      return { title: null, internalLinks: [], metaKeywords: null, schemaTypes: [], headings: [] };
    }
  })();
  liveCrawlCache.set(url, promise);
  return promise;
}

export function internalLinkSuggestions(pageUrl, allPageUrls) {
  const tokens = tokenize(new URL(pageUrl).pathname);
  const scored = allPageUrls
    .filter(u => u !== pageUrl)
    .map(u => {
      const t = tokenize(new URL(u).pathname);
      let overlap = 0;
      for (const w of tokens) if (t.has(w)) overlap++;
      return { url: u, overlap };
    })
    .filter(s => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map(s => s.url);
  return scored;
}

// Builds lookup indexes from raw Wix API results, then resolves each GSC
// top-page URL to its Wix SEO item (blog post or static page) -- same
// title-based fallback matching content-audit.js always used, since a page
// still on the site default title has no title of its own to match on
// except via resolvedTags.
export function buildWixIndexes(staticTags, blogTags, posts) {
  const postByUrl = new Map();
  for (const p of posts) {
    const url = p.url ? `${p.url.base}${p.url.path}` : null;
    if (url) postByUrl.set(url, p);
  }
  const blogTagsByItemId = new Map(blogTags.map(t => [t.itemId, t]));
  const staticTagsByTitle = new Map();
  for (const t of staticTags) {
    const resolvedFlat = (t.resolvedTags || []).map(rt => rt.tag);
    const title = extractTag(t.tags || [], 'title') || extractTag(resolvedFlat, 'title');
    if (title) staticTagsByTitle.set(title, t);
  }
  return { postByUrl, blogTagsByItemId, staticTagsByTitle };
}

export async function resolvePageWixItem(pageUrl, indexes) {
  const { postByUrl, blogTagsByItemId, staticTagsByTitle } = indexes;
  const post = postByUrl.get(pageUrl);
  const liveCrawl = await crawlLivePage(pageUrl); // schema/links/keywords, and title for static-page matching -- always fetched once, cached

  if (post) {
    const tagsEntry = blogTagsByItemId.get(post.id);
    return {
      itemType: 'BLOG_POST',
      itemId: post.id,
      matched: true,
      currentTitle: extractTag(tagsEntry?.tags || [], 'title') || post.title,
      currentMeta: extractTag(tagsEntry?.tags || [], 'meta', 'description') || post.excerpt,
      currentFocusKeywords: tagsEntry?.focusKeywords || [],
      bodyText: post.contentText || '',
      liveCrawl,
    };
  }

  const tagsEntry = liveCrawl.title ? staticTagsByTitle.get(liveCrawl.title) : null;
  if (tagsEntry) {
    const resolvedFlat = (tagsEntry.resolvedTags || []).map(rt => rt.tag);
    return {
      itemType: 'STATIC_PAGE',
      itemId: tagsEntry.itemId,
      matched: true,
      currentTitle: extractTag(tagsEntry.tags || [], 'title') || extractTag(resolvedFlat, 'title') || liveCrawl.title,
      currentMeta: extractTag(tagsEntry.tags || [], 'meta', 'description') || extractTag(resolvedFlat, 'meta', 'description'),
      currentFocusKeywords: tagsEntry.focusKeywords || [],
      bodyText: null, // no generic body-text API for classic static pages
      liveCrawl,
    };
  }

  return {
    itemType: null, itemId: null, matched: false,
    currentTitle: liveCrawl.title, currentMeta: null, currentFocusKeywords: [], bodyText: null,
    liveCrawl,
  };
}
