// Meta Optimization tab. Fully independent of app.js -- own data files, own
// render functions; shares the page's password lock, the site <select>
// pattern, and the apply-live plumbing (apply-shared.js) with the Content
// Reoptimization tab for consistency.

let caLoaded = false;
let caData = null;

function caEsc(s) { return applyEsc(s); }

function caShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function caFocusKeywordsText(fk) {
  if (!fk || !fk.length) return '(none set)';
  return fk.map(k => (typeof k === 'string' ? k : k.term)).join(', ');
}

async function caApply(siteSlug, page, issue, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password, pageUrl: page.url };
  if (issue.field === 'title') payload.title = issue.suggested;
  if (issue.field === 'metaDescription') payload.metaDescription = issue.suggested;
  if (issue.field === 'focusKeywords') payload.focusKeywords = issue.suggested;

  const resultEl = btn.parentElement.querySelector('.ca-result');
  const field = issue.field;
  await applyRun({
    endpoint: '/apply-seo-tags',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: prev => field === 'focusKeywords' ? caFocusKeywordsText(prev.focusKeywords) : (prev[field] || '(empty)'),
    formatAfter: cur => field === 'focusKeywords' ? caFocusKeywordsText(cur.focusKeywords) : cur[field],
  });
}

// Google-SERP-style preview: blue title, green URL, gray snippet -- so
// "how it will look" is literal, not a guess from raw field values.
function caSerpBlock(label, url, title, meta) {
  return `
    <div class="serp-preview">
      <div class="serp-preview-label">${caEsc(label)}</div>
      <div class="serp-title">${caEsc(title || '(no title)')}</div>
      <div class="serp-url">${caEsc(url)}</div>
      <div class="serp-snippet">${caEsc(meta || '(no meta description)')}</div>
    </div>
  `;
}

function caRenderIssue(siteSlug, page, issue, idx) {
  const canApply = issue.suggested !== null && issue.suggested !== undefined && page.matched;
  const suggestedText = issue.field === 'focusKeywords' ? caFocusKeywordsText(issue.suggested) : issue.suggested;
  const isSerpField = issue.field === 'title' || issue.field === 'metaDescription';

  const serpPreview = canApply && isSerpField
    ? `<div class="serp-preview-pair">
        ${caSerpBlock('Before', page.url, page.current.title, page.current.metaDescription)}
        ${caSerpBlock('After', page.url, issue.field === 'title' ? issue.suggested : page.current.title, issue.field === 'metaDescription' ? issue.suggested : page.current.metaDescription)}
      </div>`
    : '';

  const awaitingAi = issue.needsAi && issue.suggested === null;

  return `
    <div class="ca-issue">
      <div class="ca-issue-msg">${caEsc(issue.message)}</div>
      ${issue.reason ? `<div class="ca-issue-reason">Why: ${caEsc(issue.reason)}</div>` : ''}
      ${awaitingAi ? '<p class="ca-unmatched-note">Click "Generate AI suggestions" below to get a title/meta rewrite for this page.</p>' : ''}
      ${canApply && !isSerpField ? `<div class="ca-issue-suggested">Suggested: ${caEsc(suggestedText)}</div>` : ''}
      ${serpPreview}
      ${canApply ? `<button class="ca-apply-btn" data-page="${caEsc(page.url)}" data-issue="${idx}">Apply live</button>` : ''}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

async function caGenerateSuggestions(siteSlug, page, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const result = await applyGenerateSuggestion('meta', page.url, {
      pageUrl: page.url,
      currentTitle: page.current.title,
      currentMeta: page.current.metaDescription,
      primary: page.primary,
      secondary: page.secondary,
      bodyExcerpt: page.bodyExcerpt,
    }, { cacheSuffix: 'page' });

    for (const issue of page.issues) {
      if (issue.type === 'title' && issue.needsAi) { issue.suggested = result.title; issue.reason = result.titleReason; }
      if ((issue.type === 'meta' || issue.type === 'meta-missing') && issue.needsAi) { issue.suggested = result.metaDescription; issue.reason = result.metaReason; }
    }
    caRenderSite(siteSlug);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✨ Generate AI suggestions';
    alert(`Failed to generate suggestions: ${err.message}`);
  }
}

function caRenderPage(siteSlug, page) {
  const linkSuggestion = page.internalLinkSuggestion?.length
    ? `<div class="ca-current">Internal link suggestions: ${page.internalLinkSuggestion.map(u => caShortPath(u)).join(', ')}</div>`
    : '';
  const hasUngenerated = page.issues.some(i => i.needsAi && i.suggested === null);

  return `
    <div class="ca-page-card">
      <div class="ca-page-head">
        <a href="${caEsc(page.url)}" target="_blank">${caEsc(caShortPath(page.url))}</a>
        <span class="pill ${page.matched ? 'ranking-rise' : 'fluctuation'}">${page.matched ? page.itemType : 'unmatched'}</span>
      </div>
      <div class="ca-current">
        <strong>Title:</strong> ${caEsc(page.current.title || '(none)')}<br>
        <strong>Meta:</strong> ${caEsc(page.current.metaDescription || '(none)')}<br>
        <strong>Focus keywords:</strong> ${caEsc(caFocusKeywordsText(page.current.focusKeywords))}
      </div>
      ${!page.matched ? '<p class="ca-unmatched-note">Could not match this URL to a Wix SEO item -- apply-live unavailable, audit-only.</p>' : ''}
      ${linkSuggestion}
      ${page.issues.length ? page.issues.map((iss, i) => caRenderIssue(siteSlug, page, iss, i)).join('') : '<p class="empty">No issues flagged.</p>'}
      ${hasUngenerated ? `<button class="ca-apply-btn cr-generate-btn" data-page="${caEsc(page.url)}">✨ Generate AI suggestions</button>` : ''}
    </div>
  `;
}

function caRenderSite(siteSlug) {
  const site = caData[siteSlug];
  document.getElementById('ca-page-list').innerHTML = site.pages.map(p => caRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.ca-apply-btn:not(.cr-generate-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const issue = page.issues[Number(btn.dataset.issue)];
      caApply(siteSlug, page, issue, btn);
    });
  });
  document.querySelectorAll('.cr-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      caGenerateSuggestions(siteSlug, page, btn);
    });
  });
}

async function caLoadAll() {
  const meta = await fetch(`data/content-audit-meta.json?v=${Date.now()}`).then(r => r.json());
  caData = {};
  for (const s of meta.sites) {
    caData[s.slug] = await fetch(`data/content-audit-${s.slug}.json?v=${Date.now()}`).then(r => r.json());
  }

  const select = document.getElementById('ca-site-select');
  select.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${caEsc(s.label)}</option>`).join('');
  select.addEventListener('change', () => caRenderSite(select.value));

  document.getElementById('ca-generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
  caRenderSite(meta.sites[0].slug);
}

window.initContentAudit = function () {
  if (caLoaded) return;
  caLoaded = true;
  caLoadAll().catch(err => {
    document.getElementById('ca-page-list').innerHTML = `<p class="ca-result error" style="display:block">Failed to load: ${caEsc(err.message)}</p>`;
  });
};
