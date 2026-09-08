// Internal Linking tab. Fully independent of app.js -- own data files, own
// render functions; shares the page's password lock, the site <select>
// pattern, and the apply-live plumbing (apply-shared.js) with the Meta
// Optimization/Content Reoptimization tabs for consistency.
//
// Suggestions (target page + anchor text + reason) are generated on-demand
// per page via applyGenerateSuggestion('links', ...). Live Apply only ever
// works for blog posts with an anchor phrase verified verbatim in the post's
// body text (see worker/src/index.js) -- static pages, and any unverified
// anchor, are copy-paste only since there's no write API for static-page
// body content.

let clLoaded = false;
let clData = null;
const clGenerated = {}; // `${periodKey}:${pageUrl}` -> [{targetUrl, anchorText, reason, applyable}]

function clEsc(s) { return applyEsc(s); }

function clShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function clPeriodKey() { return document.getElementById('cl-period-select').value; }
function clGenKey(page) { return `${clPeriodKey()}:${page.url}`; }

function clCopyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

async function clGenerate(siteSlug, page, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const result = await applyGenerateSuggestion('links', page.url, {
      pageUrl: page.url,
      currentTitle: page.currentTitle,
      cause: page.cause,
      currentInternalLinks: page.currentInternalLinks,
      linkCandidates: page.linkCandidates,
      bodyExcerpt: page.bodyExcerpt,
    }, { cacheSuffix: `${clPeriodKey()}-page` });

    clGenerated[clGenKey(page)] = (result.suggestions || []).map(s => {
      const anchorVerified = page.applyableLive && page.bodyExcerpt && s.anchorText && page.bodyExcerpt.includes(s.anchorText);
      return { ...s, applyable: !!anchorVerified };
    });
    clRenderSite(siteSlug);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✨ Generate link suggestions';
    alert(`Failed to generate suggestions: ${err.message}`);
  }
}

async function clApplyLink(siteSlug, page, suggestion, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = {
    site: siteSlug, postId: page.itemId, password,
    operation: 'add_internal_link', anchorText: suggestion.anchorText, targetUrl: suggestion.targetUrl, pageUrl: page.url,
  };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => `"${suggestion.anchorText}" as plain text`,
    formatAfter: cur => `"${suggestion.anchorText}" linked to ${cur.targetUrl}`,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

function clRenderCurrentLinks(links) {
  if (!links?.length) return '<p class="empty">No internal links found on this page.</p>';
  return `
    <table>
      <tr><th>Anchor text</th><th>Links to</th></tr>
      ${links.slice(0, 20).map(l => `<tr><td>${clEsc(l.anchorText)}</td><td>${clEsc(clShortPath(l.href))}</td></tr>`).join('')}
    </table>
  `;
}

function clRenderSuggestion(siteSlug, page, s, idx) {
  return `
    <div class="cr-suggestion-block">
      <div class="ca-issue-reason">Why: ${clEsc(s.reason)}</div>
      <div class="diff-preview">
        <div>Before: <span>${clEsc(s.anchorText)}</span> -- not currently a link</div>
        <div>After: <span class="diff-highlight"><a href="${clEsc(s.targetUrl)}" target="_blank">${clEsc(s.anchorText)}</a></span> &rarr; ${clEsc(clShortPath(s.targetUrl))}</div>
      </div>
      ${s.applyable
        ? `<button class="ca-apply-btn cl-apply-link" data-page="${clEsc(page.url)}" data-idx="${idx}">Apply live (add link)</button>`
        : `<button class="ca-apply-btn cl-copy-btn" data-copy="${clEsc(s.anchorText)} -> ${clEsc(s.targetUrl)}">Copy suggestion</button>`}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function clRenderPage(siteSlug, page) {
  const gen = clGenerated[clGenKey(page)];

  return `
    <div class="ca-page-card">
      <div class="ca-page-head">
        <a href="${clEsc(page.url)}" target="_blank">${clEsc(clShortPath(page.url))}</a>
        <span class="pill ${page.cause === 'ranking-drop' ? 'ranking-drop' : 'ctr-drop'}">${clEsc(page.cause.replace('-', ' '))}</span>
        <span class="pill ranking-rise">${clEsc(page.itemType || 'unmatched')}</span>
      </div>
      <h3>Current internal links on this page</h3>
      ${clRenderCurrentLinks(page.currentInternalLinks)}
      ${gen ? `<h3 style="margin-top:1rem">Suggested new links</h3>${gen.map((s, i) => clRenderSuggestion(siteSlug, page, s, i)).join('')}` : ''}
      ${!gen ? `<button class="ca-apply-btn cl-generate-btn" data-page="${clEsc(page.url)}" style="margin-top:.8rem">✨ Generate link suggestions</button>` : ''}
    </div>
  `;
}

function clRenderSite(siteSlug) {
  const site = clData[siteSlug];
  const periodData = site.periods[clPeriodKey()];
  const pages = periodData ? periodData.pages : [];

  if (!pages.length) {
    document.getElementById('cl-page-list').innerHTML = '<p class="empty">No underperforming pages with link candidates found for this period.</p>';
    return;
  }
  document.getElementById('cl-page-list').innerHTML = pages.map(p => clRenderPage(siteSlug, p)).join('');

  document.querySelectorAll('.cl-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      clGenerate(siteSlug, page, btn);
    });
  });
  document.querySelectorAll('.cl-apply-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pages.find(p => p.url === btn.dataset.page);
      const suggestion = clGenerated[clGenKey(page)][Number(btn.dataset.idx)];
      clApplyLink(siteSlug, page, suggestion, btn);
    });
  });
  document.querySelectorAll('.cl-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => clCopyToClipboard(btn.dataset.copy, btn));
  });
}

async function clLoadAll() {
  const meta = await fetch(`data/content-links-meta.json?v=${Date.now()}`).then(r => r.json());
  clData = {};
  for (const s of meta.sites) {
    clData[s.slug] = await fetch(`data/content-links-${s.slug}.json?v=${Date.now()}`).then(r => r.json());
  }

  const select = document.getElementById('cl-site-select');
  select.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${clEsc(s.label)}</option>`).join('');
  select.addEventListener('change', () => clRenderSite(select.value));
  document.getElementById('cl-period-select').addEventListener('change', () => clRenderSite(select.value));

  document.getElementById('cl-generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
  clRenderSite(meta.sites[0].slug);
}

window.initContentLinks = function () {
  if (clLoaded) return;
  clLoaded = true;
  clLoadAll().catch(err => {
    document.getElementById('cl-page-list').innerHTML = `<p class="ca-result error" style="display:block">Failed to load: ${clEsc(err.message)}</p>`;
  });
};
