const charts = {};

function fmtPct(v) { return (v * 100).toFixed(2) + '%'; }

function pctDelta(cur, prev) {
  if (prev === 0) return cur === 0 ? 0 : Infinity;
  return ((cur - prev) / prev) * 100;
}

function deltaBadge(cur, prev, invert = false) {
  const p = pctDelta(cur, prev);
  if (!isFinite(p) || Math.abs(p) < 0.05) return `<span class="delta flat">flat</span>`;
  const good = invert ? p < 0 : p > 0;
  const sign = p > 0 ? '+' : '';
  return `<span class="delta ${good ? 'up' : 'down'}">${sign}${p.toFixed(1)}%</span>`;
}

function shortPath(url) {
  try {
    const u = new URL(url);
    return (u.pathname === '/' ? '/ (home)' : u.pathname) + u.hash;
  } catch {
    return url;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderKpis(data) {
  const c = data.headline.current, p = data.headline.previous;
  const rows = [
    ['Clicks', c.clicks.toLocaleString(), deltaBadge(c.clicks, p.clicks)],
    ['Impressions', c.impressions.toLocaleString(), deltaBadge(c.impressions, p.impressions)],
    ['CTR', fmtPct(c.ctr), deltaBadge(c.ctr, p.ctr)],
    ['Avg position', c.position.toFixed(1), deltaBadge(c.position, p.position, true)],
  ];
  document.getElementById('kpi-row').innerHTML = rows.map(([label, value, badge]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${badge}
    </div>
  `).join('');
}

function renderTrendChart(data) {
  const ctx = document.getElementById('trend-chart');
  if (charts.trend) charts.trend.destroy();
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.trend.map(d => d.date.slice(5)),
      datasets: [
        {
          label: 'Clicks', data: data.trend.map(d => d.clicks),
          borderColor: '#4285f4', backgroundColor: 'rgba(66,133,244,.12)',
          fill: true, tension: .3, yAxisID: 'y', pointRadius: 0, borderWidth: 2,
        },
        {
          label: 'Impressions', data: data.trend.map(d => d.impressions),
          borderColor: '#a142f4', backgroundColor: 'rgba(161,66,244,.08)',
          fill: true, tension: .3, yAxisID: 'y1', pointRadius: 0, borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Clicks' }, grid: { color: '#eef0f7' } },
        y1: { position: 'right', title: { display: true, text: 'Impressions' }, grid: { display: false } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderMoversChart(data) {
  const decliners = data.decliners.filter(r => r.delta_clicks < 0).slice(0, 8);
  const risers = data.risers.filter(r => r.delta_clicks > 0).slice(0, 5);
  const rows = [...decliners, ...risers].sort((a, b) => a.delta_clicks - b.delta_clicks);

  const ctx = document.getElementById('movers-chart');
  if (charts.movers) charts.movers.destroy();
  charts.movers = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => shortPath(r.page)),
      datasets: [{
        data: rows.map(r => r.delta_clicks),
        backgroundColor: rows.map(r => r.delta_clicks < 0 ? '#d93025' : '#1e8e3e'),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: 'Δ clicks' }, grid: { color: '#eef0f7' } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

function renderQuickWinsChart(data) {
  const rows = data.quickWins.slice(0, 10);
  const ctx = document.getElementById('quickwins-chart');
  if (charts.quickwins) charts.quickwins.destroy();
  charts.quickwins = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.query),
      datasets: [{
        data: rows.map(r => r.impressions),
        backgroundColor: '#f9ab00',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { title: { display: true, text: 'Impressions' }, grid: { color: '#eef0f7' } },
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 30, minRotation: 30 } },
      },
    },
  });
}

function renderQuickWinsTable(data) {
  const rows = data.quickWins.slice(0, 15);
  if (!rows.length) { document.getElementById('quickwins-table').innerHTML = '<p class="empty">No quick wins detected in this period.</p>'; return; }
  document.getElementById('quickwins-table').innerHTML = `
    <table>
      <tr><th>Query</th><th>Page</th><th>Position</th><th>CTR</th><th>Impressions</th></tr>
      ${rows.map(r => `
        <tr>
          <td>${esc(r.query)}</td>
          <td><a href="${esc(r.page)}" target="_blank">${esc(shortPath(r.page))}</a></td>
          <td>${r.position.toFixed(1)}</td>
          <td>${fmtPct(r.ctr)}</td>
          <td>${r.impressions.toLocaleString()}</td>
        </tr>
      `).join('')}
    </table>
  `;
}

function renderMoversTable(rows, elId, isDecline) {
  const filtered = rows.filter(r => isDecline ? r.delta_clicks <= 0 : r.delta_clicks >= 0).slice(0, 10);
  if (!filtered.length) { document.getElementById(elId).innerHTML = '<p class="empty">Nothing notable.</p>'; return; }
  document.getElementById(elId).innerHTML = `
    <table>
      <tr><th>Page</th><th>Clicks</th><th>Δ Impr</th><th>Δ Pos</th><th>Cause</th></tr>
      ${filtered.map(r => `
        <tr>
          <td><a href="${esc(r.page)}" target="_blank">${esc(shortPath(r.page))}</a></td>
          <td>${r.clicks_old} → ${r.clicks_new} <span class="${r.delta_clicks < 0 ? 'num-neg' : 'num-pos'}">(${r.delta_clicks > 0 ? '+' : ''}${r.delta_clicks})</span></td>
          <td>${r.delta_impressions > 0 ? '+' : ''}${r.delta_impressions.toLocaleString()}</td>
          <td>${r.delta_position > 0 ? '+' : ''}${r.delta_position}</td>
          <td><span class="pill ${r.cause}">${r.cause.replace('-', ' ')}</span></td>
        </tr>
      `).join('')}
    </table>
  `;
}

function renderKeywordMap(data) {
  if (!data.keywordMap.length) { document.getElementById('keyword-map').innerHTML = '<p class="empty">No keyword data.</p>'; return; }
  document.getElementById('keyword-map').innerHTML = data.keywordMap.map(pg => `
    <div class="keyword-block">
      <h3><a href="${esc(pg.page)}" target="_blank">${esc(shortPath(pg.page))}</a></h3>
      <table>
        <tr><th>Query</th><th>Clicks</th><th>Impressions</th><th>Position</th></tr>
        ${pg.keywords.map((k, i) => `
          <tr>
            <td>${i === 0 ? `<span class="tag primary-tag">primary</span> ` : ''}${esc(k.query)}</td>
            <td>${k.clicks}</td>
            <td>${k.impressions.toLocaleString()}</td>
            <td>${k.position.toFixed(1)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `).join('');
}

function renderCannibalization(data) {
  if (!data.cannibalization.length) { document.getElementById('cannibalization-table').innerHTML = '<p class="empty">No cannibalization detected.</p>'; return; }
  document.getElementById('cannibalization-table').innerHTML = `
    <table>
      <tr><th>Query</th><th>Competing pages</th></tr>
      ${data.cannibalization.slice(0, 12).map(c => `
        <tr>
          <td>${esc(c.query)}</td>
          <td>${c.pages.map(p => `<div>${esc(shortPath(p.page))} <span style="color:var(--ink-soft)">(${p.impressions.toLocaleString()} impr, pos ${p.position.toFixed(1)})</span></div>`).join('')}</td>
        </tr>
      `).join('')}
    </table>
  `;
}

function renderOrphans(data) {
  if (!data.orphanPages.length) { document.getElementById('orphan-list').innerHTML = '<p class="empty">No coverage gaps found.</p>'; return; }
  const shown = data.orphanPages.slice(0, 25);
  document.getElementById('orphan-list').innerHTML = `
    <p style="font-size:.82rem;color:var(--ink-soft)">${data.orphanPages.length} of ${data.sitemapUrlCount} sitemap URLs, near-zero impressions this period</p>
    <ul class="page-list">
      ${shown.map(u => `<li><a href="${esc(u)}" target="_blank">${esc(shortPath(u))}</a></li>`).join('')}
    </ul>
  `;
}

async function loadSite(slug) {
  const data = await fetch(`data/${slug}.json`).then(r => r.json());
  document.getElementById('period-label').textContent =
    `${data.label} — ${data.period.curStart} to ${data.period.curEnd} vs ${data.period.prevStart} to ${data.period.prevEnd}`;
  renderKpis(data);
  renderTrendChart(data);
  renderMoversChart(data);
  renderQuickWinsChart(data);
  renderQuickWinsTable(data);
  renderMoversTable(data.decliners, 'decliners-table', true);
  renderMoversTable(data.risers, 'risers-table', false);
  renderKeywordMap(data);
  renderCannibalization(data);
  renderOrphans(data);
}

async function init() {
  const meta = await fetch('data/meta.json').then(r => r.json());
  const select = document.getElementById('site-select');
  select.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${esc(s.label)}</option>`).join('');
  select.addEventListener('change', () => loadSite(select.value));
  document.getElementById('generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
  await loadSite(meta.sites[0].slug);
}

init();
