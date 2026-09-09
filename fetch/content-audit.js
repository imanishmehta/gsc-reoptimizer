// Meta Optimization: for pages that are actually underperforming in each
// GSC period (ranking-drop, ctr-drop, or CTR well below the position-
// expected benchmark -- same signal Reoptimizer's decliners already use,
// see getPeriodTargets in lib/audit-shared.js), cross-references live Wix
// SEO data (title/meta description/meta keywords/focus keywords) and a
// live-HTML schema check, flags issues with a stated reason, and leaves the
// AI-written suggestion for the browser to generate on demand. Fully
// independent of fetch.js/analysis.js's own output by design -- separate
// pipeline, separate output files, separate tab (but reuses analysis.js's
// period/classification logic via audit-shared.js rather than reinventing).
//
// Auth: GSC via GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON
// (same as fetch.js). Wix via WIX_API_KEY (raw Admin API Key).
//
// Usage: node content-audit.js

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PERIODS, getGscClient, getPeriodTargets, listItemSeoTags, listBlogPosts,
  buildWixIndexes, resolvePageWixItem, tokenize,
} from './lib/audit-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data');

const SITES = [
  {
    slug: 'mimicminds', label: 'mimicminds',
    gscSiteUrl: 'sc-domain:mimicminds.com',
    wixSiteId: '1d570b1b-ba44-4cdd-bb4b-176a7afb7d75',
  },
  {
    slug: 'mimicproductions', label: 'mimic productions',
    gscSiteUrl: 'https://www.mimicproductions.com/',
    wixSiteId: '20db1d0f-b8d3-49e6-8100-03577875df69',
  },
];

const BLOG_SCHEMA_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle']);

const CAUSE_TEXT = {
  'ranking-drop': "Position got worse this period -- a competitor outranked it, or a content/relevance signal weakened.",
  'ctr-drop': 'Clicks fell without a matching drop in position/demand -- the title/snippet is likely not matching what searchers expect.',
  'low-ctr': 'CTR is well below what pages at this position typically earn -- the title/snippet is likely under-selling the page.',
};

// ---------- Suggestions ----------

// Rule-based issue detection. Title/meta/meta-keywords `suggested` are left
// null here (needsAi: true) -- filled on demand in the browser via the
// Worker's /generate-suggestion, never at fetch time. Everything else's
// `reason` is filled synchronously from the same numbers that triggered it.
function detectIssues({ primary, secondary, cause }, currentTitle, currentMeta, currentMetaKeywords, currentFocusKeywords, bodyText, liveCrawl, itemType) {
  const issues = [];
  if (!primary) return issues;

  const causeReason = CAUSE_TEXT[cause] || CAUSE_TEXT[primary.ctr < 0.01 ? 'low-ctr' : 'ranking-drop'];

  const titleHasQuery = currentTitle && currentTitle.toLowerCase().includes(primary.query.toLowerCase());
  if (!titleHasQuery) {
    issues.push({
      type: 'title', field: 'title', needsAi: true,
      message: `Title doesn't contain the top query "${primary.query}" (${primary.impressions} impr, pos ${primary.position.toFixed(1)}) -- this page is ${cause.replace('-', ' ')} this period.`,
      current: currentTitle, suggested: null, reason: null,
    });
  }
  if (currentTitle && (currentTitle.length < 30 || currentTitle.length > 60)) {
    issues.push({
      type: 'title-length', field: 'title', needsAi: false,
      message: `Title is ${currentTitle.length} chars (ideal 30-60).`,
      current: currentTitle, suggested: null,
      reason: currentTitle.length < 30
        ? 'Short titles under-use the space Google gives you in the SERP, leaving room for a keyword or benefit that could lift CTR.'
        : 'Titles over 60 chars get truncated with "..." in search results, often cutting off the part that would make someone click.',
    });
  }

  const metaHasQuery = currentMeta && currentMeta.toLowerCase().includes(primary.query.toLowerCase());
  if (!currentMeta) {
    issues.push({ type: 'meta-missing', field: 'metaDescription', needsAi: true, message: 'No meta description set.', current: null, suggested: null, reason: null });
  } else if (!metaHasQuery) {
    issues.push({ type: 'meta', field: 'metaDescription', needsAi: true, message: `Meta description doesn't mention the top query "${primary.query}".`, current: currentMeta, suggested: null, reason: null });
  }

  if (!currentMetaKeywords) {
    issues.push({ type: 'meta-keywords', field: 'metaKeywords', needsAi: true, message: 'No meta keywords set.', current: null, suggested: null, reason: null });
  }

  issues.push({
    type: cause === 'ranking-drop' ? 'ranking' : 'ctr', field: null, needsAi: false,
    message: cause === 'ranking-drop'
      ? `Position moved from ${primary.position.toFixed(1)} to worse this period.`
      : `CTR ${(primary.ctr * 100).toFixed(2)}% is underperforming for position ${primary.position.toFixed(1)}.`,
    current: null, suggested: null, reason: causeReason,
  });

  const currentFocus = (currentFocusKeywords || []).map(k => (k.term || '').toLowerCase());
  if (!currentFocus.includes(primary.query.toLowerCase())) {
    issues.push({
      type: 'focus-keyword', field: 'focusKeywords', needsAi: false,
      message: `Focus keyword doesn't include the top GSC query "${primary.query}".`,
      current: currentFocusKeywords || [],
      suggested: [{ term: primary.query, isMain: true }, ...secondary.slice(0, 2).map(q => ({ term: q.query, isMain: false }))],
      reason: `"${primary.query}" is this page's #1 query by clicks in GSC but isn't set as a focus keyword -- Wix's own SEO tooling (and the page's internal search relevance) works off this field.`,
    });
  }

  if (bodyText) {
    const bodyTokens = tokenize(bodyText);
    for (const q of secondary) {
      const qTokens = [...tokenize(q.query)];
      if (qTokens.every(t => bodyTokens.has(t)) || q.impressions < 20) continue;
      issues.push({
        type: 'content-gap', field: null, needsAi: false,
        message: `Secondary keyword "${q.query}" (${q.impressions} impr) doesn't appear in the page content.`,
        current: null, suggested: q.query,
        // This is a body-content change, not an SEO tag -- Meta
        // Optimization has no field to write it to (no Apply button here
        // by design, see caRenderIssue). Content Reoptimization is where
        // this actually gets fixed: it generates a real new paragraph
        // working this keyword in, with a before/after preview and a live
        // Apply.
        reason: `Google is already showing this page for "${q.query}" (${q.impressions} impressions this period) but the term never appears in the body -- working it in naturally reinforces relevance for a query you're already getting some visibility on. Fix this in the Content Reoptimization tab (this is body content, not a meta tag) -- it'll generate a paragraph using this term with a before/after preview.`,
      });
    }
  }

  if (!liveCrawl.schemaTypes.length) {
    issues.push({
      type: 'schema-missing', field: null, needsAi: false,
      message: 'No structured data (schema.org JSON-LD) found on this page.',
      current: null, suggested: null,
      reason: 'Schema markup helps Google understand and richly display the page (rich results, AI Overview eligibility). Adding it requires editing the page in Wix (custom code / SEO settings) -- not something this tool can apply automatically.',
    });
  } else if (itemType === 'BLOG_POST' && !liveCrawl.schemaTypes.some(t => BLOG_SCHEMA_TYPES.has(t))) {
    issues.push({
      type: 'schema-wrong-type', field: null, needsAi: false,
      message: `Schema present (${liveCrawl.schemaTypes.join(', ')}) but no Article/BlogPosting type found for this blog post.`,
      current: null, suggested: null,
      reason: 'Blog posts without Article/BlogPosting schema are less likely to qualify for article-specific rich results and AI Overview citations.',
    });
  }

  return issues;
}

// ---------- Main per-site ----------

async function processSite(gscClient, site) {
  console.log(`[${site.label}] pulling Wix SEO tags + blog posts...`);
  // Sequential, not Promise.all -- concurrent requests to this Wix endpoint
  // intermittently return a 499 (connection-closed) edge error; one at a
  // time is reliable.
  const staticTags = await listItemSeoTags(site.wixSiteId, 'STATIC_PAGE');
  const blogTags = await listItemSeoTags(site.wixSiteId, 'BLOG_POST');
  const posts = await listBlogPosts(site.wixSiteId);
  const indexes = buildWixIndexes(staticTags, blogTags, posts);

  const periods = {};
  for (const def of PERIODS) {
    console.log(`[${site.label}] ${def.label}: finding underperforming pages...`);
    const { targets } = await getPeriodTargets(gscClient, site, def.days);

    const pages = [];
    for (const target of targets) {
      const item = await resolvePageWixItem(target.url, indexes);
      const issues = detectIssues(target, item.currentTitle, item.currentMeta, item.currentMetaKeywords, item.currentFocusKeywords, item.bodyText, item.liveCrawl, item.itemType);
      if (!issues.length) continue;

      pages.push({
        url: target.url,
        cause: target.cause,
        itemType: item.matched ? item.itemType : null,
        itemId: item.matched ? item.itemId : null,
        matched: item.matched,
        current: { title: item.currentTitle, metaDescription: item.currentMeta, metaKeywords: item.currentMetaKeywords, focusKeywords: item.currentFocusKeywords },
        primary: target.primary, secondary: target.secondary, issues,
        bodyExcerpt: item.bodyText ? item.bodyText.slice(0, 600) : null, // passed back to /generate-suggestion on demand
      });
    }
    console.log(`[${site.label}] ${def.label}: ${pages.length} underperforming page(s) with issues`);
    periods[def.key] = { pages };
  }

  return { label: site.label, slug: site.slug, periods };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const gscClient = await getGscClient();

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of SITES) {
    const data = await processSite(gscClient, site);
    await writeFile(path.join(OUT_DIR, `content-audit-${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote content-audit-${site.slug}.json`);
  }
  await writeFile(path.join(OUT_DIR, 'content-audit-meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
