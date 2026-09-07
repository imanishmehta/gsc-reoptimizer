// Content Reoptimization: detects LSI/secondary-keyword gaps and internal-
// link candidates for blog posts, grounded in GSC query data. Static pages
// have no body-content API (see resolvePageWixItem in lib/audit-shared.js)
// so they're marked read-only with no body-derived suggestions.
//
// This pipeline is data-only -- it does NOT call an AI provider. The actual
// suggestion (LSI keywords, a new paragraph, an internal-link anchor) is
// generated on-demand in the browser via the Worker's /generate-suggestion
// endpoint, using whichever provider + API key the user configured in
// Settings. That keeps AI spend opt-in per page instead of running for
// every page on every nightly cron -- see docs/content-reoptimize-app.js
// and worker/src/index.js.
//
// Live-apply (once a suggestion is generated) is scoped to two structurally-
// safe Ricos edits only (see worker/src/index.js): appending a whole new
// paragraph, and wrapping an *exact, already-present* text run in a link. An
// internal-link suggestion is only marked `applyable` when its anchor text
// is a verbatim substring of the post's body text -- verified client-side
// against the bodyExcerpt this script provides, before Apply is offered.
//
// Auth: GSC via GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON.
// Wix via WIX_API_KEY.
//
// Usage: node content-reoptimize.js

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getGscClient, getGscData, listItemSeoTags, listBlogPosts,
  buildWixIndexes, resolvePageWixItem, tokenize, internalLinkSuggestions,
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

async function processSite(gscClient, site) {
  console.log(`[${site.label}] pulling GSC data...`);
  const { byPage, topPages } = await getGscData(gscClient, site.gscSiteUrl);

  console.log(`[${site.label}] pulling Wix SEO tags + blog posts...`);
  const staticTags = await listItemSeoTags(site.wixSiteId, 'STATIC_PAGE');
  const blogTags = await listItemSeoTags(site.wixSiteId, 'BLOG_POST');
  const posts = await listBlogPosts(site.wixSiteId);
  const indexes = buildWixIndexes(staticTags, blogTags, posts);

  const allUrls = topPages;
  const pages = [];

  for (const pageUrl of topPages) {
    const gscQueries = byPage.get(pageUrl) || [];
    const item = await resolvePageWixItem(pageUrl, indexes);
    const linkCandidates = internalLinkSuggestions(pageUrl, allUrls);

    let gscGaps = [];
    if (item.bodyText) {
      const bodyTokens = tokenize(item.bodyText);
      gscGaps = gscQueries.slice(1, 8).filter(q => {
        if (q.impressions < 20) return false;
        const qTokens = [...tokenize(q.query)];
        return !qTokens.every(t => bodyTokens.has(t));
      });
    }

    const hasBodyContent = !!item.bodyText;
    const canSuggest = item.matched && item.itemType === 'BLOG_POST' && hasBodyContent && gscQueries.length > 0;

    pages.push({
      url: pageUrl,
      itemType: item.matched ? item.itemType : null,
      itemId: item.matched ? item.itemId : null,
      matched: item.matched,
      hasBodyContent,
      canSuggest,
      currentTitle: item.currentTitle,
      bodyExcerpt: item.bodyText ? item.bodyText.slice(0, 3000) : null,
      gscQueries: gscQueries.slice(0, 8).map(q => ({ query: q.query, impressions: q.impressions, position: q.position })),
      gscGaps: gscGaps.map(q => ({ query: q.query, impressions: q.impressions, position: q.position })),
      linkCandidates,
    });
  }

  return { label: site.label, slug: site.slug, pages };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const gscClient = await getGscClient();

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of SITES) {
    const data = await processSite(gscClient, site);
    await writeFile(path.join(OUT_DIR, `content-reoptimize-${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote content-reoptimize-${site.slug}.json (${data.pages.length} pages)`);
  }
  await writeFile(path.join(OUT_DIR, 'content-reoptimize-meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
