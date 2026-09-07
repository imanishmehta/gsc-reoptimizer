// Internal Linking: for pages that are actually underperforming in each GSC
// period (ranking-drop, ctr-drop, or CTR well below the position-expected
// benchmark -- see getPeriodTargets in lib/audit-shared.js), crawls the live
// page for its current internal links (the "before" state) and proposes
// candidate target pages for new links (token-overlap + top-clicks
// fallback, same pattern as analysis.js's relatedPages). Covers blog posts
// AND static/project pages -- this doesn't need the Wix body-content API,
// just live HTML, so it isn't blocked by the static-page limitation that
// content-reoptimize.js has.
//
// Data-only, like the other two pipelines -- the actual suggested anchor
// text + reason is generated on demand in the browser via the Worker's
// /generate-suggestion endpoint (type: 'links'). Live-apply (once
// generated) only ever works for blog posts with a verbatim-matching anchor
// (see worker/src/index.js); static pages are always copy-paste, since
// there's no write API for static-page body content.
//
// Auth: GSC via GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON.
// Wix via WIX_API_KEY.
//
// Usage: node content-links.js

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PERIODS, getGscClient, getPeriodTargets, listItemSeoTags, listBlogPosts,
  buildWixIndexes, resolvePageWixItem, internalLinkSuggestions,
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
  console.log(`[${site.label}] pulling Wix SEO tags + blog posts...`);
  const staticTags = await listItemSeoTags(site.wixSiteId, 'STATIC_PAGE');
  const blogTags = await listItemSeoTags(site.wixSiteId, 'BLOG_POST');
  const posts = await listBlogPosts(site.wixSiteId);
  const indexes = buildWixIndexes(staticTags, blogTags, posts);

  const periods = {};
  for (const def of PERIODS) {
    console.log(`[${site.label}] ${def.label}: finding underperforming pages...`);
    const { targets } = await getPeriodTargets(gscClient, site, def.days);
    // Top-clicks fallback candidates for relatedPages-style suggestions --
    // pages worth linking FROM regardless of URL-token overlap.
    const topClickUrls = [...targets].sort((a, b) => b.curTotals.clicks - a.curTotals.clicks).slice(0, 8).map(t => t.url);
    const allUrls = targets.map(t => t.url);

    const pages = [];
    for (const target of targets) {
      const item = await resolvePageWixItem(target.url, indexes);
      if (!item.matched) continue;

      const candidates = [...new Set([...internalLinkSuggestions(target.url, allUrls), ...topClickUrls])]
        .filter(u => u !== target.url)
        .slice(0, 5);
      if (!candidates.length) continue;

      pages.push({
        url: target.url,
        cause: target.cause,
        itemType: item.itemType,
        itemId: item.itemId,
        applyableLive: item.itemType === 'BLOG_POST',
        currentTitle: item.currentTitle,
        bodyExcerpt: item.bodyText ? item.bodyText.slice(0, 3000) : null, // for anchor-text verbatim-match check (blog only)
        currentInternalLinks: item.liveCrawl.internalLinks,
        linkCandidates: candidates,
      });
    }
    console.log(`[${site.label}] ${def.label}: ${pages.length} page(s) with link candidates`);
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
    await writeFile(path.join(OUT_DIR, `content-links-${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote content-links-${site.slug}.json`);
  }
  await writeFile(path.join(OUT_DIR, 'content-links-meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
