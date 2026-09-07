// Shared GSC-pull + Wix-item-matching logic used by both content-audit.js
// (meta tags) and content-reoptimize.js (body content) -- same top-N-pages
// pull, same "which Wix SEO item does this URL belong to" matching, so it
// lives once here instead of twice.

import { google } from 'googleapis';

export const TOP_N_PAGES = 20;

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

function fmtDate(d) { return d.toISOString().slice(0, 10); }

export async function getGscData(client, gscSiteUrl, topN = TOP_N_PAGES) {
  const end = new Date(); end.setDate(end.getDate() - 3);
  const start = new Date(end); start.setDate(start.getDate() - 30);
  const rows = await gscQuery(client, gscSiteUrl, fmtDate(start), fmtDate(end), ['page', 'query']);

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

  const pageTotals = [...byPage.entries()].map(([page, queries]) => ({
    page,
    impressions: queries.reduce((s, q) => s + q.impressions, 0),
    clicks: queries.reduce((s, q) => s + q.clicks, 0),
  })).sort((a, b) => b.impressions - a.impressions);

  return { byPage, topPages: pageTotals.slice(0, topN).map(p => p.page) };
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

export async function fetchLiveTitle(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (content-audit-bot)' } });
    const html = await res.text();
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? decodeEntities(m[1].trim()) : null;
  } catch {
    return null;
  }
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
    };
  }

  const liveTitle = await fetchLiveTitle(pageUrl);
  const tagsEntry = liveTitle ? staticTagsByTitle.get(liveTitle) : null;
  if (tagsEntry) {
    const resolvedFlat = (tagsEntry.resolvedTags || []).map(rt => rt.tag);
    return {
      itemType: 'STATIC_PAGE',
      itemId: tagsEntry.itemId,
      matched: true,
      currentTitle: extractTag(tagsEntry.tags || [], 'title') || extractTag(resolvedFlat, 'title') || liveTitle,
      currentMeta: extractTag(tagsEntry.tags || [], 'meta', 'description') || extractTag(resolvedFlat, 'meta', 'description'),
      currentFocusKeywords: tagsEntry.focusKeywords || [],
      bodyText: null, // no generic body-text API for classic static pages
    };
  }

  return {
    itemType: null, itemId: null, matched: false,
    currentTitle: liveTitle, currentMeta: null, currentFocusKeywords: [], bodyText: null,
  };
}
