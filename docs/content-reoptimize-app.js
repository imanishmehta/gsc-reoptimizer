// Content Reoptimization tab. Fully independent of app.js -- own data
// files, own render functions; shares the page's password lock, the site
// <select> pattern, and the apply-live plumbing (apply-shared.js) with the
// Meta Optimization/Internal Linking tabs for consistency.
//
// Suggestions (LSI keywords, a new paragraph) are generated on-demand per
// page via applyGenerateSuggestion('content', ...) -- nothing is
// precomputed at fetch time, so nothing calls the configured AI provider
// until you click "Generate" on a specific post.

let crLoaded = false;
let crData = null;
const crGenerated = {}; // `${periodKey}:${pageUrl}` -> generated suggestion result, kept in memory across re-renders

function crEsc(s) { return applyEsc(s); }

function crShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function crPeriodKey() { return document.getElementById('cr-period-select').value; }
function crGenKey(page) { return `${crPeriodKey()}:${page.url}`; }

function crCopyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

async function crGenerate(siteSlug, page, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const result = await applyGenerateSuggestion('content', page.url, {
      pageUrl: page.url,
      currentTitle: page.currentTitle,
      cause: page.cause,
      bodyExcerpt: page.bodyExcerpt,
      gscQueries: page.gscQueries,
      gscGaps: page.gscGaps,
    }, { cacheSuffix: `${crPeriodKey()}-page` });

    crGenerated[crGenKey(page)] = {
      lsiKeywords: result.lsiKeywords || [],
      suggestedParagraph: result.suggestedParagraph || null,
    };
    crRenderSite(siteSlug);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✨ Generate content suggestions';
    alert(`Failed to generate suggestions: ${err.message}`);
  }
}

async function crApplyParagraph(siteSlug, page, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const gen = crGenerated[crGenKey(page)];
  const payload = {
    site: siteSlug, postId: page.itemId, password,
    operation: 'append_paragraph', paragraphText: gen.suggestedParagraph.text, pageUrl: page.url,
  };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => '(post had no added paragraph)',
    formatAfter: cur => cur.addedParagraph,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

function crRenderLsiKeywords(keywords) {
  if (!keywords?.length) return '';
  return `
    <div class="cr-lsi-block">
      <h3>Secondary / LSI keywords to work in</h3>
      <div class="cr-lsi-chips">
        ${keywords.map(k => `<span class="tag" title="${crEsc(k.reason)}">${crEsc(k.term)}</span>`).join('')}
      </div>
    </div>
  `;
}

// Real before/after of the visible page, not an isolated green box: the
// current end of the post, then the same text with the suggested paragraph
// appended.
function crRenderParagraph(siteSlug, page, p) {
  if (!p?.text) return '';
  const canApply = page.itemType === 'BLOG_POST' && page.matched;

  return `
    <div class="cr-suggestion-block">
      <h3>Suggested new paragraph</h3>
      <div class="ca-issue-reason">Why: ${crEsc(p.reason || 'Covers a GSC query gap for this post.')}</div>
      <div class="diff-preview">
        <div class="serp-preview-label">End of post now</div>
        <div>&hellip;${crEsc(page.bodyTailExcerpt)}</div>
        <div class="serp-preview-label" style="margin-top:.6rem">End of post after Apply</div>
        <div>&hellip;${crEsc(page.bodyTailExcerpt)} <span class="diff-add">${crEsc(p.text)}</span></div>
      </div>
      ${canApply
        ? `<button class="ca-apply-btn cr-apply-paragraph" data-page="${crEsc(page.url)}">Apply live (append to post)</button>`
        : `<button class="ca-apply-btn cr-copy-btn" data-copy="${crEsc(p.text)}">Copy suggestion</button>`}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function crRenderPage(siteSlug, page) {
  const gen = crGenerated[crGenKey(page)];

  return `
    <div class="ca-page-card">
      <div class="ca-page-head">
        <a href="${crEsc(page.url)}" target="_blank">${crEsc(crShortPath(page.url))}</a>
        <span class="pill ${page.cause === 'ranking-drop' ? 'ranking-drop' : 'ctr-drop'}">${crEsc(page.cause.replace('-', ' '))}</span>
        <span class="pill ranking-rise">${crEsc(page.itemType)}</span>
      </div>
      ${gen ? crRenderLsiKeywords(gen.lsiKeywords) : ''}
      ${gen ? crRenderParagraph(siteSlug, page, gen.suggestedParagraph) : ''}
      ${!gen ? `<button class="ca-apply-btn cr-generate-btn" data-page="${crEsc(page.url)}">✨ Generate content suggestions</button>` : ''}
    </div>
  `;
}

function crRenderSite(siteSlug) {
  const site = crData[siteSlug];
  const periodData = site.periods[crPeriodKey()];
  const pages = periodData ? periodData.pages : [];

  if (!pages.length) {
    document.getElementById('cr-page-list').innerHTML = '<p class="empty">No underperforming blog posts found for this period -- nothing to optimize.</p>';
    return;
  }
  document.getElementById('cr-page-list').innerHTML = pages.map(p => crRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.cr-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      crGenerate(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cr-apply-paragraph').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      crApplyParagraph(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cr-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => crCopyToClipboard(btn.dataset.copy, btn));
  });
}

async function crLoadAll() {
  const meta = await fetch(`data/content-reoptimize-meta.json?v=${Date.now()}`).then(r => r.json());
  crData = {};
  for (const s of meta.sites) {
    crData[s.slug] = await fetch(`data/content-reoptimize-${s.slug}.json?v=${Date.now()}`).then(r => r.json());
  }

  const select = document.getElementById('cr-site-select');
  select.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${crEsc(s.label)}</option>`).join('');
  select.addEventListener('change', () => crRenderSite(select.value));
  document.getElementById('cr-period-select').addEventListener('change', () => crRenderSite(select.value));

  document.getElementById('cr-generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
  crRenderSite(meta.sites[0].slug);
}

window.initContentReoptimize = function () {
  if (crLoaded) return;
  crLoaded = true;
  crLoadAll().catch(err => {
    document.getElementById('cr-page-list').innerHTML = `<p class="ca-result error" style="display:block">Failed to load: ${crEsc(err.message)}</p>`;
  });
};
