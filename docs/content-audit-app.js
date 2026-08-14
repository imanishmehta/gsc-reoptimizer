// Content Audit tab. Fully independent of app.js -- own data files, own
// render functions, only shares the page's password lock (this tab lives
// inside the same locked page) and the site <select> pattern for consistency.

const WORKER_URL = 'https://gsc-reoptimizer-apply.mimic-gsc.workers.dev';
let caLoaded = false;
let caData = null;
let caSessionPassword = null;

function caEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

async function caGetPassword() {
  if (caSessionPassword) return caSessionPassword;
  const pw = prompt('Password to apply live changes:');
  caSessionPassword = pw;
  return pw;
}

async function caApply(siteSlug, page, issue, btn) {
  const password = await caGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password, pageUrl: page.url };
  if (issue.field === 'title') payload.title = issue.suggested;
  if (issue.field === 'metaDescription') payload.metaDescription = issue.suggested;
  if (issue.field === 'focusKeywords') payload.focusKeywords = issue.suggested;

  btn.disabled = true;
  btn.textContent = 'Applying...';
  const resultEl = btn.parentElement.querySelector('.ca-result');

  try {
    const res = await fetch(`${WORKER_URL}/apply-seo-tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const field = issue.field;
    const prevVal = field === 'focusKeywords' ? caFocusKeywordsText(data.previous.focusKeywords) : (data.previous[field] || '(empty)');
    const curVal = field === 'focusKeywords' ? caFocusKeywordsText(data.current.focusKeywords) : data.current[field];

    resultEl.hidden = false;
    resultEl.className = 'ca-result ok';
    resultEl.innerHTML = `
      <strong>Applied ${new Date(data.appliedAt).toLocaleTimeString()}</strong><br>
      Before: ${caEsc(prevVal)}<br>
      After: ${caEsc(curVal)}<br>
      <a href="${caEsc(page.url)}" target="_blank">View live page &rarr;</a>
    `;
    btn.textContent = 'Applied';
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = 'ca-result error';
    resultEl.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'Apply live';
    if (err.message.includes('password') || err.message.includes('401')) caSessionPassword = null;
  }
}

function caRenderIssue(siteSlug, page, issue, idx) {
  const canApply = issue.suggested !== null && issue.suggested !== undefined && page.matched;
  const suggestedText = issue.field === 'focusKeywords' ? caFocusKeywordsText(issue.suggested) : issue.suggested;

  return `
    <div class="ca-issue">
      <div class="ca-issue-msg">${caEsc(issue.message)}</div>
      ${canApply ? `<div class="ca-issue-suggested">Suggested: ${caEsc(suggestedText)}</div>` : ''}
      ${canApply ? `<button class="ca-apply-btn" data-page="${caEsc(page.url)}" data-issue="${idx}">Apply live</button>` : ''}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function caRenderPage(siteSlug, page) {
  const linkSuggestion = page.internalLinkSuggestion?.length
    ? `<div class="ca-current">Internal link suggestions: ${page.internalLinkSuggestion.map(u => caShortPath(u)).join(', ')}</div>`
    : '';

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
    </div>
  `;
}

function caRenderSite(siteSlug) {
  const site = caData[siteSlug];
  document.getElementById('ca-page-list').innerHTML = site.pages.map(p => caRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.ca-apply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const issue = page.issues[Number(btn.dataset.issue)];
      caApply(siteSlug, page, issue, btn);
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
