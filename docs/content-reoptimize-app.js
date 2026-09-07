// Content Reoptimization tab. Fully independent of app.js -- own data
// files, own render functions; shares the page's password lock, the site
// <select> pattern, and the apply-live plumbing (apply-shared.js) with the
// Meta Optimization tab for consistency.
//
// Suggestions (LSI keywords, a new paragraph, an internal link) are
// generated on-demand per page via applyGenerateSuggestion('content', ...)
// -- nothing is precomputed at fetch time, so nothing calls the configured
// AI provider until you click "Generate" on a specific post.

let crLoaded = false;
let crData = null;
const crGenerated = {}; // pageUrl -> generated suggestion result, kept in memory across re-renders

function crEsc(s) { return applyEsc(s); }

function crShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

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
      bodyExcerpt: page.bodyExcerpt,
      gscQueries: page.gscQueries,
      gscGaps: page.gscGaps,
      linkCandidates: page.linkCandidates,
    }, { cacheSuffix: 'page' });

    // Only trust an anchor the model claims is verbatim if it actually is --
    // this is what makes live-apply safe (see worker/src/index.js).
    const anchorText = result.internalLinkAnchor?.trim();
    const anchorVerified = anchorText && page.bodyExcerpt && page.bodyExcerpt.includes(anchorText);

    crGenerated[page.url] = {
      lsiKeywords: result.lsiKeywords || [],
      suggestedParagraph: result.suggestedParagraph || null,
      internalLink: anchorVerified
        ? { anchorText, targetUrl: page.linkCandidates[0], reason: result.internalLinkReason || '', applyable: true }
        : (anchorText ? { anchorText, targetUrl: page.linkCandidates[0], reason: result.internalLinkReason || '', applyable: false } : null),
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

  const gen = crGenerated[page.url];
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
  });
}

async function crApplyLink(siteSlug, page, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const link = crGenerated[page.url].internalLink;
  const payload = {
    site: siteSlug, postId: page.itemId, password,
    operation: 'add_internal_link', anchorText: link.anchorText, targetUrl: link.targetUrl, pageUrl: page.url,
  };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => `"${link.anchorText}" as plain text`,
    formatAfter: cur => `"${link.anchorText}" linked to ${cur.targetUrl}`,
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

function crRenderParagraph(siteSlug, page, p) {
  if (!p?.text) return '';
  const canApply = page.itemType === 'BLOG_POST' && page.matched;

  return `
    <div class="cr-suggestion-block">
      <h3>Suggested new paragraph</h3>
      <div class="ca-issue-reason">Why: ${crEsc(p.reason || 'Covers a GSC query gap for this post.')}</div>
      <div class="diff-preview">
        <div class="diff-add">+ ${crEsc(p.text)}</div>
      </div>
      ${canApply
        ? `<button class="ca-apply-btn cr-apply-paragraph" data-page="${crEsc(page.url)}">Apply live (append to post)</button>`
        : `<button class="ca-apply-btn cr-copy-btn" data-copy="${crEsc(p.text)}">Copy suggestion</button>`}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function crRenderInternalLink(siteSlug, page, link) {
  if (!link) return '';

  return `
    <div class="cr-suggestion-block">
      <h3>Suggested internal link</h3>
      <div class="ca-issue-reason">Why: ${crEsc(link.reason || 'Topically related page, per URL keyword overlap.')}</div>
      <div class="diff-preview">
        <div>Before: <span>${crEsc(link.anchorText)}</span></div>
        <div>After: <span class="diff-highlight"><a href="${crEsc(link.targetUrl)}" target="_blank">${crEsc(link.anchorText)}</a></span> &rarr; ${crEsc(crShortPath(link.targetUrl))}</div>
      </div>
      ${link.applyable
        ? `<button class="ca-apply-btn cr-apply-link" data-page="${crEsc(page.url)}">Apply live (add link)</button>`
        : `<button class="ca-apply-btn cr-copy-btn" data-copy="${crEsc(link.anchorText)} -> ${crEsc(link.targetUrl)}">Copy suggestion</button>`}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function crRenderPage(siteSlug, page) {
  const gen = crGenerated[page.url];

  return `
    <div class="ca-page-card">
      <div class="ca-page-head">
        <a href="${crEsc(page.url)}" target="_blank">${crEsc(crShortPath(page.url))}</a>
        <span class="pill ${page.matched ? 'ranking-rise' : 'fluctuation'}">${page.matched ? (page.itemType || 'unmatched') : 'unmatched'}</span>
      </div>
      ${!page.hasBodyContent ? '<p class="ca-unmatched-note">No body content available via API for this page type -- any suggestions here must be added manually in the Wix editor.</p>' : ''}
      ${!page.canSuggest && page.hasBodyContent ? '<p class="empty">No GSC query data for this post in the last 30 days -- nothing to base a suggestion on.</p>' : ''}
      ${gen ? crRenderLsiKeywords(gen.lsiKeywords) : ''}
      ${gen ? crRenderParagraph(siteSlug, page, gen.suggestedParagraph) : ''}
      ${gen ? crRenderInternalLink(siteSlug, page, gen.internalLink) : ''}
      ${page.canSuggest && !gen ? `<button class="ca-apply-btn cr-generate-btn" data-page="${crEsc(page.url)}">✨ Generate content suggestions</button>` : ''}
    </div>
  `;
}

function crRenderSite(siteSlug) {
  const site = crData[siteSlug];
  document.getElementById('cr-page-list').innerHTML = site.pages.map(p => crRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.cr-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      crGenerate(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cr-apply-paragraph').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      crApplyParagraph(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cr-apply-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      crApplyLink(siteSlug, page, btn);
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
