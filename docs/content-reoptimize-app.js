// Content Reoptimization tab. Fully independent of app.js -- own data
// files, own render functions; shares the page's password lock, the site
// <select> pattern, and the apply-live plumbing (apply-shared.js) with the
// Meta Optimization/Internal Linking tabs for consistency.
//
// Suggestions (LSI keywords, multiple new paragraphs) are generated on-
// demand per page via applyGenerateSuggestion('content', ...) -- nothing is
// precomputed at fetch time, so nothing calls the configured AI provider
// until you click "Generate" on a specific post.
//
// Each suggested paragraph targets a specific existing section (via
// insertAfterHeading) instead of always landing at the end of the post --
// the Worker inserts it at the end of that section (see
// findSectionInsertIndex in worker/src/index.js), falling back to
// end-of-post (still signature-line-aware) if no section was requested.
// This is ADD-only: nothing existing is ever edited or removed.

let crLoaded = false;
let crData = null;
const crGenerated = {}; // `${periodKey}:${pageUrl}` -> { lsiKeywords, paragraphs: [{text, reason, insertAfterHeading}] }

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

async function crGenerate(siteSlug, page, btn, force = false) {
  btn.disabled = true;
  btn.textContent = force ? 'Regenerating...' : 'Generating...';
  try {
    const result = await applyGenerateSuggestion('content', page.url, {
      pageUrl: page.url,
      currentTitle: page.currentTitle,
      cause: page.cause,
      bodyExcerpt: page.bodyExcerpt,
      headings: page.headings,
      gscQueries: page.gscQueries,
      gscGaps: page.gscGaps,
    }, { cacheSuffix: `${crPeriodKey()}-page`, force });

    crApplyResult(page, result);
    crRenderSite(siteSlug);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = force ? '↻ Regenerate' : '✨ Generate content suggestions';
    alert(`Failed to generate suggestions: ${err.message}`);
  }
}

// Fills crGenerated from a generate-suggestion result -- shared by the
// actual Generate click and by cache hydration on load, so a page refresh
// shows already-generated suggestions immediately instead of needing
// another click just to pull them back out of the cache.
function crApplyResult(page, result) {
  crGenerated[crGenKey(page)] = {
    lsiKeywords: result.lsiKeywords || [],
    paragraphs: result.paragraphs || [],
  };
}

async function crApplyParagraph(siteSlug, page, para, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = {
    site: siteSlug, postId: page.itemId, password,
    operation: 'append_paragraph', paragraphText: para.text, insertAfterHeading: para.insertAfterHeading || null, pageUrl: page.url,
  };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => '(post had no added paragraph)',
    formatAfter: cur => cur.insertedAfterHeading ? `${cur.addedParagraph} (added at the end of "${cur.insertedAfterHeading}")` : cur.addedParagraph,
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

// One block per suggested paragraph. Each is independent: its own target
// section, its own Apply/Copy button, its own result panel -- applying one
// doesn't affect the others. Placement is stated up front (what the AI
// targeted) and confirmed again in the result panel after Apply (what the
// Worker actually did -- authoritative, since a requested heading can fail
// to match if the post changed since generation).
function crRenderParagraph(siteSlug, page, para, idx) {
  const canApply = page.itemType === 'BLOG_POST' && page.matched;
  const target = para.insertAfterHeading
    ? `at the end of the "${para.insertAfterHeading}" section`
    : 'at the end of the post';

  return `
    <div class="cr-suggestion-block">
      <div class="serp-preview-label">📍 Placement: ${crEsc(target)}</div>
      <div class="ca-issue-reason">Why: ${crEsc(para.reason || 'Covers a GSC query gap for this post.')}</div>
      <div class="diff-preview">
        <div class="diff-add">+ ${crEsc(para.text)}</div>
      </div>
      ${canApply
        ? `<button class="ca-apply-btn cr-apply-paragraph" data-page="${crEsc(page.url)}" data-idx="${idx}">Apply live (add paragraph)</button>`
        : `<button class="ca-apply-btn cr-copy-btn" data-copy="${crEsc(para.text)}">Copy suggestion</button>`}
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
      ${gen ? gen.paragraphs.map((p, i) => crRenderParagraph(siteSlug, page, p, i)).join('') : ''}
      ${gen && !gen.paragraphs.length
        ? `<p class="empty">No paragraph suggestions this time.</p><button class="ca-apply-btn cr-regenerate-btn" data-page="${crEsc(page.url)}">↻ Regenerate</button>`
        : ''}
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
  // Pull in anything already generated in this browser (e.g. before a
  // refresh) so it shows immediately, no re-click needed.
  for (const page of pages) {
    if (crGenerated[crGenKey(page)]) continue;
    const cached = applyPeekCachedSuggestion('content', page.url, `${crPeriodKey()}-page`);
    if (cached) crApplyResult(page, cached);
  }
  document.getElementById('cr-page-list').innerHTML = pages.map(p => crRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.cr-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      crGenerate(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cr-regenerate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      crGenerate(siteSlug, page, btn, true);
    });
  });
  document.querySelectorAll('.cr-apply-paragraph').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      const para = crGenerated[crGenKey(page)].paragraphs[Number(btn.dataset.idx)];
      crApplyParagraph(siteSlug, page, para, btn);
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
