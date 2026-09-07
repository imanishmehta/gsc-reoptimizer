// Content Reoptimization: detects LSI/secondary-keyword gaps for blog posts
// that are actually underperforming in each GSC period (ranking-drop,
// ctr-drop, or CTR well below the position-expected benchmark -- same
// signal Reoptimizer's decliners already use, see getPeriodTargets in
// lib/audit-shared.js). Static pages have no body-content API (see
// resolvePageWixItem) so they're skipped here -- see content-links.js for
// the internal-linking suggestions that DO cover static pages.
//
// This pipeline is data-only -- it does NOT call an AI provider. The actual
// suggestion (LSI keywords, a new paragraph) is generated on-demand in the
// browser via the Worker's /generate-suggestion endpoint, using whichever
// provider + API key the user configured in Settings. That keeps AI spend
// opt-in per page instead of running for every page on every nightly cron
// -- see docs/content-reoptimize-app.js and worker/src/index.js.
//
// Live-apply (once a suggestion is generated) is scoped to one structurally-
// safe Ricos edit: appending a whole new paragraph (see worker/src/index.js).
//
// Auth: GSC via GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON.
// Wix via WIX_API_KEY.
//
// Usage: node content-reoptimize.js

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

async function processSite(gscClient, site) {
  console.log(`[${site.label}] pulling Wix SEO tags + blog posts...`);
  const staticTags = await listItemSeoTags(site.wixSiteId, 'STATIC_PAGE');
  const blogTags = await listItemSeoTags(site.wixSiteId, 'BLOG_POST');
  const posts = await listBlogPosts(site.wixSiteId);
  const indexes = buildWixIndexes(staticTags, blogTags, posts);

  const periods = {};
  for (const def of PERIODS) {
    console.log(`[${site.label}] ${def.label}: finding underperforming blog posts...`);
    const { targets } = await getPeriodTargets(gscClient, site, def.days);

    const pages = [];
    for (const target of targets) {
      const item = await resolvePageWixItem(target.url, indexes);
      if (!item.matched || item.itemType !== 'BLOG_POST' || !item.bodyText) continue;

      const bodyTokens = tokenize(item.bodyText);
      const gscGaps = (target.secondary || []).filter(q => {
        if (q.impressions < 20) return false;
        return ![...tokenize(q.query)].every(t => bodyTokens.has(t));
      });

      pages.push({
        url: target.url,
        cause: target.cause,
        itemType: item.itemType,
        itemId: item.itemId,
        matched: true,
        currentTitle: item.currentTitle,
        bodyExcerpt: item.bodyText.slice(0, 3000), // full context for the AI prompt
        bodyTailExcerpt: item.bodyText.slice(-400), // "current end of post" for the before/after preview
        gscQueries: [target.primary, ...target.secondary].filter(Boolean).map(q => ({ query: q.query, impressions: q.impressions, position: q.position })),
        gscGaps: gscGaps.map(q => ({ query: q.query, impressions: q.impressions, position: q.position })),
      });
    }
    console.log(`[${site.label}] ${def.label}: ${pages.length} underperforming blog post(s)`);
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
    await writeFile(path.join(OUT_DIR, `content-reoptimize-${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote content-reoptimize-${site.slug}.json`);
  }
  await writeFile(path.join(OUT_DIR, 'content-reoptimize-meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
