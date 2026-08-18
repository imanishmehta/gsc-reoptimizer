// Wix Analytics tab. Fully independent of app.js and content-audit-app.js --
// own state, own site/period selectors, own render functions. Shares only
// the page's password lock (this tab lives inside the same locked page).

let waSiteData = null; // full { label, trend, periods } for the currently selected site
const waCharts = {};

function waEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function waPctDelta(cur, prev) {
  if (prev === 0) return cur === 0 ? 0 : Infinity;
  return ((cur - prev) / prev) * 100;
}

function waDeltaBadge(cur, prev) {
  const p = waPctDelta(cur, prev);
  if (!isFinite(p) || Math.abs(p) < 0.05) return `<span class="delta flat">flat</span>`;
  const sign = p > 0 ? '+' : '';
  return `<span class="delta ${p > 0 ? 'up' : 'down'}">${sign}${p.toFixed(1)}%</span>`;
}

const WIX_METRIC_LABELS = {
  TOTAL_SESSIONS: 'Sessions',
  TOTAL_UNIQUE_VISITORS: 'Unique visitors',
  TOTAL_FORMS_SUBMITTED: 'Forms submitted',
  CLICKS_TO_CONTACT: 'Clicks to contact',
};

// rows: [{label, count, countPrev}]. Shows a %-change badge per row
// whenever the period has a real previous-period comparison.
function waRenderBreakdown(elId, rows, hasComparison, className) {
  if (!rows.length) { document.getElementById(elId).innerHTML = '<p class="empty">No data.</p>'; return; }
  const max = Math.max(...rows.map(r => r.count));
  document.getElementById(elId).innerHTML = rows.map(r => `
    <div class="breakdown-row ${className || ''}">
      <div class="breakdown-label">${waEsc(r.label)}</div>
      <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${max > 0 ? (r.count / max * 100) : 0}%"></div></div>
      <div class="breakdown-count">${r.count.toLocaleString()}</div>
      ${hasComparison ? `<div class="breakdown-delta">${waDeltaBadge(r.count, r.countPrev)}</div>` : ''}
    </div>
  `).join('');
}

function waFmtReferrerLabel(label) {
  const names = { direct: 'Direct', organic_search: 'Google/search (organic)', referral: 'Referral', social: 'Social', ai_platform: 'AI platforms', paid_search: 'Paid search', other: 'Other' };
  return names[label] || label;
}

function waFmtSeconds(s) {
  if (!s) return '0s';
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function waRenderReferrerTable(rows, hasComparison) {
  const el = document.getElementById('wix-referrer-table');
  if (!rows.length) { el.innerHTML = '<p class="empty">No traffic source data.</p>'; return; }
  el.innerHTML = `
    <table>
      <tr><th>Source</th><th>Category</th><th>Sessions</th><th>Unique visitors</th></tr>
      ${rows.map(r => `
        <tr>
          <td>${waEsc(r.source)}</td>
          <td>${waEsc(waFmtReferrerLabel(r.category))}</td>
          <td>${r.sessions.toLocaleString()} ${hasComparison ? waDeltaBadge(r.sessions, r.sessionsPrev) : ''}</td>
          <td>${r.visitors.toLocaleString()}</td>
        </tr>
      `).join('')}
    </table>
  `;
}

function waRenderBotTable(elId, rows, hasComparison) {
  const el = document.getElementById(elId);
  if (!rows.length) { el.innerHTML = '<p class="empty">No crawl activity detected this period.</p>'; return; }
  el.innerHTML = `
    <table>
      <tr><th>Bot</th><th>Hits</th></tr>
      ${rows.map(r => `
        <tr>
          <td>${waEsc(r.label)}</td>
          <td>${r.count.toLocaleString()} ${hasComparison ? waDeltaBadge(r.count, r.countPrev) : ''}</td>
        </tr>
      `).join('')}
    </table>
  `;
}

function waRenderPeriod() {
  const periodKey = document.getElementById('wix-tab-period-select').value;
  const data = waSiteData?.periods?.[periodKey];
  const section = document.getElementById('wix-analytics-section');
  const blogSection = document.getElementById('wix-blog-section');
  const wa = data?.wixAnalytics;

  if (!wa) { section.hidden = true; blogSection.hidden = true; return; }
  section.hidden = false;
  const hasComparison = wa.period.hasComparison;

  document.getElementById('wix-analytics-sub').textContent = hasComparison
    ? `Actual site traffic from Wix -- ${wa.period.curStart} to ${wa.period.curEnd} vs ${wa.period.prevStart} to ${wa.period.prevEnd}.`
    : `Actual site traffic from Wix -- ${wa.period.curStart} to ${wa.period.curEnd} (no prior-period comparison available for this window).`;

  const cappedNote = document.getElementById('wix-capped-note');
  cappedNote.hidden = !wa.period.capped;
  if (wa.period.capped) {
    cappedNote.textContent = `⚠️ Wix only retains ~60 days of analytics data -- this period was capped to the earliest available date (${wa.period.curStart}) rather than the full selected range.`;
  }

  const rows = Object.entries(WIX_METRIC_LABELS).map(([key, label]) => {
    const cur = wa.current[key]?.total ?? 0;
    const prev = wa.previous[key]?.total ?? 0;
    return [label, cur.toLocaleString(), hasComparison ? waDeltaBadge(cur, prev) : ''];
  });
  document.getElementById('wix-kpi-row').innerHTML = rows.map(([label, value, badge]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${badge}
    </div>
  `).join('');

  const sessionsTrend = wa.current.TOTAL_SESSIONS?.trend || [];
  const visitorsTrend = wa.current.TOTAL_UNIQUE_VISITORS?.trend || [];
  const ctx = document.getElementById('wix-trend-chart');
  if (waCharts.trend) waCharts.trend.destroy();
  waCharts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: sessionsTrend.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Sessions', data: sessionsTrend.map(d => d.value), borderColor: '#18C1A5', backgroundColor: 'rgba(24,193,165,.12)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
        { label: 'Unique visitors', data: visitorsTrend.map(d => d.value), borderColor: '#7A61FD', backgroundColor: 'rgba(122,97,253,.08)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } },
      scales: { y: { grid: { color: '#eef0f7' } }, x: { grid: { display: false } } },
    },
  });

  waRenderBreakdown('wix-device-list', wa.traffic.device, hasComparison);
  waRenderBreakdown('wix-country-list', wa.traffic.country, hasComparison);
  waRenderBreakdown('wix-visitor-type-list', wa.traffic.visitorType.map(r => ({ ...r, label: r.label === 'first_time_visitor' ? 'New' : 'Returning' })), hasComparison);

  waRenderReferrerTable(wa.traffic.referrerAll, hasComparison);

  if (wa.traffic.aiPlatforms.length) {
    waRenderBreakdown('wix-ai-platforms', wa.traffic.aiPlatforms, hasComparison, 'ai-platform-row');
  } else {
    document.getElementById('wix-ai-platforms').innerHTML = '<p class="empty">No AI-platform-attributed referral traffic (ChatGPT, Claude, Gemini, Perplexity, etc.) detected this period.</p>';
  }

  waRenderBotTable('wix-ai-bots', wa.bots.aiBots, hasComparison);
  waRenderBotTable('wix-other-bots', wa.bots.otherBots, hasComparison);

  blogSection.hidden = !wa.blogPosts.length;
  if (wa.blogPosts.length) {
    document.getElementById('wix-blog-table').innerHTML = `
      <table>
        <tr><th>Post</th><th>Views</th><th>Clicks</th><th>Visitors</th><th>Avg read time</th><th>Engagements</th></tr>
        ${wa.blogPosts.map(p => `
          <tr>
            <td><a href="${waEsc(p.url)}" target="_blank">${waEsc(p.title)}</a></td>
            <td>${p.views.toLocaleString()} ${hasComparison ? waDeltaBadge(p.views, p.viewsPrev) : ''}</td>
            <td>${p.clicks.toLocaleString()} ${hasComparison ? waDeltaBadge(p.clicks, p.clicksPrev) : ''}</td>
            <td>${p.visitors.toLocaleString()}</td>
            <td>${waFmtSeconds(p.avgReadSeconds)}</td>
            <td>${p.engagements.toLocaleString()}</td>
          </tr>
        `).join('')}
      </table>
    `;
  }
}

async function waLoadSite(slug) {
  waSiteData = await fetch(`data/${slug}.json?v=${Date.now()}`).then(r => r.json());
  waRenderPeriod();
}

let waLoaded = false;
window.initWixAnalyticsTab = function () {
  if (waLoaded) { waRenderPeriod(); return; }
  waLoaded = true;

  fetch(`data/meta.json?v=${Date.now()}`).then(r => r.json()).then(meta => {
    const siteSelect = document.getElementById('wix-tab-site-select');
    siteSelect.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${waEsc(s.label)}</option>`).join('');
    siteSelect.addEventListener('change', () => waLoadSite(siteSelect.value));
    document.getElementById('wix-tab-period-select').addEventListener('change', waRenderPeriod);
    document.getElementById('wix-tab-generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
    waLoadSite(meta.sites[0].slug);
  });
};
