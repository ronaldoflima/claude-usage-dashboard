const state = { range: '5h', custom: null, data: null, limits: null, profile: null, weeklyData: null, metric: 'total_tokens' };
const COLORS = ['#d97757', '#7c9ec7', '#7dbb84', '#dfae57', '#a184c4', '#d7809e', '#79b7b1'];
const DURATIONS = { '15m': 15 * 60e3, '30m': 30 * 60e3, '1h': 60 * 60e3, '5h': 5 * 60 * 60e3, '24h': 24 * 60 * 60e3, '7d': 7 * 24 * 60 * 60e3 };
const nf = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('pt-BR');

function formatTokens(value) { return nf.format(value || 0); }
function formatDate(value) { return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function countdown(value) {
  if (!value) return 'reset não informado';
  let seconds = Math.max(0, (new Date(value).getTime() - Date.now()) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}min` : `${minutes}min`;
}
function tone(pct) { return pct >= 90 ? '#db6b64' : pct >= 70 ? '#dfae57' : '#7dbb84'; }
function esc(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }
function profileProgress(profile, elapsedHours) {
  const slots = profile?.weekly?.slots;
  if (!Array.isArray(slots) || slots.length !== 168) return null;
  const position = Math.max(0, Math.min(168, elapsedHours));
  const whole = Math.floor(position); const fraction = position - whole;
  const completed = slots.slice(0, whole).reduce((sum, value) => sum + value, 0);
  return Math.min(100, (completed + (whole < 168 ? slots[whole] * fraction : 0)) * 100);
}
function profileProjection(profile, targetPercent, startMs) {
  const slots = profile?.weekly?.slots;
  if (!Array.isArray(slots) || targetPercent > 100) return null;
  let cumulative = 0;
  for (let slot = 0; slot < slots.length; slot++) {
    const next = cumulative + slots[slot] * 100;
    if (next >= targetPercent) {
      const fraction = slots[slot] > 0 ? (targetPercent - cumulative) / (slots[slot] * 100) : 0;
      return startMs + (slot + fraction) * 36e5;
    }
    cumulative = next;
  }
  return null;
}
function paceFor(limit) {
  const durationMs = limit.kind === 'session' ? 5 * 60 * 60e3 : 7 * 24 * 60 * 60e3;
  const resetMs = new Date(limit.resets_at).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const now = Date.now(); const startMs = resetMs - durationMs;
  const elapsedMs = Math.max(60e3, Math.min(durationMs, now - startMs));
  const remainingMs = Math.max(0, resetMs - now);
  const historical = limit.kind !== 'session' && state.profile?.ok;
  const historicalExpected = historical ? profileProgress(state.profile, elapsedMs / 36e5) : null;
  const expected = historicalExpected ?? Math.max(0, Math.min(100, elapsedMs / durationMs * 100));
  const actualRate = limit.utilization / (elapsedMs / 36e5);
  const sustainableRate = remainingMs > 0 ? (100 - limit.utilization) / (remainingMs / 36e5) : 0;
  const ratio = expected > 0 ? limit.utilization / expected : 0;
  const targetProfile = ratio > 0 ? expected + (100 - limit.utilization) / ratio : null;
  const projectedMs = historical
    ? profileProjection(state.profile, targetProfile, startMs)
    : actualRate > 0 ? startMs + (100 / actualRate) * 36e5 : null;
  const margin = expected - limit.utilization;
  let label = 'No ritmo'; let className = 'steady';
  if (limit.utilization >= 100) { label = 'Limite atingido'; className = 'hot'; }
  else if (ratio > 1.08) { label = 'Ritmo acelerado'; className = 'hot'; }
  else if (ratio < .82) { label = 'Ritmo tranquilo'; className = 'cool'; }
  return {
    expected, actualRate, sustainableRate, projectedMs, margin, label, className, historical,
    pressure: ratio,
    futureBudgetRatio: expected < 100 ? (100 - limit.utilization) / (100 - expected) : 0,
    reachesBeforeReset: projectedMs && projectedMs < resetMs,
  };
}
function clock(value) { return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

async function loadWeeklyData() {
  const weekly = state.limits?.limits?.find(limit => limit.kind === 'weekly_all');
  if (!weekly?.resets_at) return null;
  const resetMs = new Date(weekly.resets_at).getTime();
  const startMs = resetMs - 7 * 24 * 36e5;
  const endMs = Math.min(Date.now(), resetMs);
  const response = await fetch(`/api/dashboard?from=${startMs}&to=${endMs}&bucket=3600000`);
  const data = await response.json();
  return data.ok ? { ...data, resetMs, startMs, official: weekly.utilization } : null;
}

async function load(custom) {
  if (custom) state.custom = custom;
  const selected = state.custom;
  const end = selected?.end ?? Date.now();
  const start = selected?.start ?? end - DURATIONS[state.range];
  try {
    const [usageResponse, limitsResponse, profileResponse] = await Promise.all([
      fetch(`/api/dashboard?from=${start}&to=${end}`), fetch('/api/limits'), fetch('/api/profile')
    ]);
    state.data = await usageResponse.json(); state.limits = await limitsResponse.json(); state.profile = await profileResponse.json();
    if (!state.data.ok) throw new Error(state.data.error);
    state.weeklyData = await loadWeeklyData();
    render();
    document.getElementById('updated').textContent = `atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    document.getElementById('updated').textContent = 'falha na atualização';
    document.getElementById('limits').innerHTML = `<div class="panel error">${esc(error.message)}</div>`;
  }
}

function render() {
  const d = state.data, t = d.totals;
  document.getElementById('totalTokens').textContent = formatTokens(t.total_tokens);
  document.getElementById('freshTokens').textContent = formatTokens(t.fresh_tokens);
  document.getElementById('sessions').textContent = exact.format(t.sessions || 0);
  document.getElementById('messages').textContent = exact.format(t.messages || 0);
  document.getElementById('coverage').textContent = d.coverage.last_event_ms ? `último evento ${formatDate(d.coverage.last_event_ms)}` : 'sem eventos';
  renderLimits(); renderWeeklyCurve(); renderTimeline(); renderRanking('models', d.models, 'model'); renderRanking('sessionList', d.sessions, 'session');
}

function renderLimits() {
  const root = document.getElementById('limits');
  if (!state.limits?.ok) {
    root.innerHTML = `<article class="panel error">Limites oficiais indisponíveis: ${esc(state.limits?.error || 'erro desconhecido')}</article>`;
    return;
  }
  const primary = state.limits.limits.filter(x => x.kind === 'session' || x.kind === 'weekly_all');
  const scoped = state.limits.limits.filter(x => x.kind !== 'session' && x.kind !== 'weekly_all');
  const ordered = [...primary, ...scoped];
  root.innerHTML = ordered.map(limit => {
    const pct = Math.max(0, Math.min(100, limit.utilization)); const color = tone(pct);
    const pace = paceFor(limit);
    const paceMarkup = pace ? `<div class="pace-head"><span class="pace-badge ${pace.className}">${pace.label}</span><span>${pace.historical ? 'ideal histórico' : 'ideal agora'}: ${pace.expected.toFixed(0)}%</span></div>
      <div class="bar pace-bar" style="--bar-color:${color}"><i style="--value:${pct}%"></i><b style="--target:${pace.expected}%" title="ritmo ideal"></b></div>
      <div class="pace-grid"><span><small>${pace.historical ? 'Pressão vs padrão' : 'Ritmo médio'}</small><strong>${pace.historical ? pace.pressure.toFixed(2) + 'x' : pace.actualRate.toFixed(1) + '%/h'}</strong></span><span><small>${pace.historical ? 'Folga futura' : 'Pode gastar'}</small><strong>${pace.historical ? pace.futureBudgetRatio.toFixed(2) + 'x' : pace.sustainableRate.toFixed(1) + '%/h'}</strong></span><span><small>Margem</small><strong>${pace.margin >= 0 ? '+' : ''}${pace.margin.toFixed(0)} pp</strong></span></div>
      <p class="projection ${pace.reachesBeforeReset ? 'warning' : ''}">${pace.reachesBeforeReset ? `Mantendo seu padrão, chega a 100% ${clock(pace.projectedMs)}` : 'Mantendo seu padrão, não chega a 100% antes do reset'}</p>
      ${pace.historical ? `<p class="profile-source">Curva pessoal · ${state.profile.lookback_days} dias · ${state.profile.weekly.business_days_share.toFixed(0)}% seg–sex</p>` : ''}` : '';
    return `<article class="limit panel" style="--ring-color:${color}">
      <div class="limit-title"><strong>${esc(limit.label)}</strong><span>plano oficial</span></div>
      <div class="limit-value"><strong>${limit.utilization.toFixed(limit.utilization % 1 ? 1 : 0)}%</strong><span>utilizado</span></div>
      <div class="limit-meta"><span>restam ${(100 - pct).toFixed(0)}%</span><span>reset em ${countdown(limit.resets_at)}</span></div>
      ${paceMarkup}
    </article>`;
  }).join('') || '<article class="panel error">A API não retornou janelas de limite ativas.</article>';
}

function renderWeeklyCurve() {
  const root = document.getElementById('weeklyCurve');
  const summary = document.getElementById('weeklyCurveSummary');
  const data = state.weeklyData; const slots = state.profile?.weekly?.slots;
  if (!data || !Array.isArray(slots) || slots.length !== 168) {
    root.innerHTML = '<div class="empty">Gere o perfil histórico para visualizar a curva.</div>';
    summary.textContent = '';
    return;
  }

  const elapsedHours = Math.max(0, Math.min(168, (Date.now() - data.startMs) / 36e5));
  const expectedNow = profileProgress(state.profile, elapsedHours);
  const hourly = Array(168).fill(0);
  for (const row of data.timeline) {
    const slot = Math.floor((row.bucket_ms - data.startMs) / 36e5);
    if (slot >= 0 && slot < 168) hourly[slot] += row.fresh_tokens || 0;
  }
  const elapsedSlots = Math.min(168, Math.ceil(elapsedHours));
  const observedTotal = hourly.slice(0, elapsedSlots).reduce((sum, value) => sum + value, 0);

  const expectedPoints = [{ slot: 0, value: 0 }];
  let expectedSum = 0;
  for (let slot = 0; slot < 168; slot++) {
    expectedSum += slots[slot] * 100;
    expectedPoints.push({ slot: slot + 1, value: expectedSum });
  }

  const actualPoints = [{ slot: 0, value: 0 }];
  let actualSum = 0;
  for (let slot = 0; slot < elapsedSlots; slot++) {
    actualSum += hourly[slot];
    actualPoints.push({
      slot: Math.min(slot + 1, elapsedHours),
      value: observedTotal > 0 ? actualSum / observedTotal * data.official : 0,
    });
  }
  if (actualPoints.at(-1).slot !== elapsedHours) actualPoints.push({ slot: elapsedHours, value: data.official });
  else actualPoints[actualPoints.length - 1] = { slot: elapsedHours, value: data.official };

  const width = 1000, height = 290, left = 48, right = 18, top = 16, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = slot => left + slot / 168 * plotWidth;
  const y = value => top + (100 - Math.max(0, Math.min(100, value))) / 100 * plotHeight;
  const path = points => points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.slot).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  const actualPath = path(actualPoints);
  const areaPath = `${actualPath} L ${x(elapsedHours).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const horizontal = [0, 25, 50, 75, 100].map(value =>
    `<g><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="curve-grid-line"/><text x="${left - 9}" y="${y(value) + 4}" class="curve-axis-label" text-anchor="end">${value}%</text></g>`
  ).join('');
  const dayFormatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
  const vertical = Array.from({ length: 8 }, (_, day) => {
    const slot = day * 24; const date = new Date(data.startMs + slot * 36e5);
    return `<g><line x1="${x(slot)}" y1="${top}" x2="${x(slot)}" y2="${height - bottom}" class="curve-day-line"/><text x="${x(slot)}" y="${height - 13}" class="curve-axis-label" text-anchor="${day === 0 ? 'start' : day === 7 ? 'end' : 'middle'}">${dayFormatter.format(date)}</text></g>`;
  }).join('');
  const currentX = x(elapsedHours), currentY = y(data.official);

  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="actualArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7dbb84" stop-opacity=".28"/><stop offset="100%" stop-color="#7dbb84" stop-opacity="0"/></linearGradient></defs>
    ${horizontal}${vertical}
    <path d="${areaPath}" fill="url(#actualArea)"/>
    <path d="${path(expectedPoints)}" class="curve-expected-line"/>
    <path d="${actualPath}" class="curve-actual-line"/>
    <line x1="${currentX}" y1="${top}" x2="${currentX}" y2="${height - bottom}" class="curve-now-line"/>
    <circle cx="${currentX}" cy="${currentY}" r="6" class="curve-now-point"/>
    <circle cx="${currentX}" cy="${y(expectedNow)}" r="4" class="curve-expected-point"/>
  </svg>`;

  const delta = data.official - expectedNow;
  summary.innerHTML = `<strong>${data.official.toFixed(0)}%</strong> usado · ideal <strong>${expectedNow.toFixed(0)}%</strong> · <span class="${delta > 0 ? 'negative' : 'positive'}">${delta > 0 ? '+' : ''}${delta.toFixed(0)} pp</span>`;
}

function renderTimeline() {
  const timeline = document.getElementById('timeline'); const legend = document.getElementById('legend');
  const rows = state.data.timeline; const metric = state.metric;
  const oldAxis = timeline.parentElement.querySelector('.axis'); if (oldAxis) oldAxis.remove();
  if (!rows.length) { timeline.innerHTML = '<div class="empty">Sem atividade neste intervalo.</div>'; legend.innerHTML = ''; return; }
  const models = [...new Set(rows.map(x => x.model))]; const colors = Object.fromEntries(models.map((m, i) => [m, COLORS[i % COLORS.length]]));
  legend.innerHTML = models.map(m => `<span><i style="background:${colors[m]}"></i>${esc(shortModel(m))}</span>`).join('');
  const byBucket = new Map();
  for (const row of rows) { if (!byBucket.has(row.bucket_ms)) byBucket.set(row.bucket_ms, []); byBucket.get(row.bucket_ms).push(row); }
  const buckets = [...byBucket.entries()]; const max = Math.max(...buckets.map(([, values]) => values.reduce((sum, x) => sum + x[metric], 0)), 1);
  timeline.innerHTML = buckets.map(([bucket, values]) => `<div class="column" title="${formatDate(bucket)} · ${formatTokens(values.reduce((s,x)=>s+x[metric],0))}">
    ${values.map(x => `<i class="segment" style="height:${Math.max(.4, x[metric] / max * 100)}%;background:${colors[x.model]}" title="${esc(shortModel(x.model))}: ${exact.format(x[metric])}"></i>`).join('')}
  </div>`).join('');
  timeline.insertAdjacentHTML('afterend', `<div class="axis"><span>${formatDate(buckets[0][0])}</span><span>${formatDate(buckets.at(-1)[0])}</span></div>`);
}

function renderRanking(id, rows, type) {
  const root = document.getElementById(id); const metric = state.metric; const max = Math.max(...rows.map(x => x[metric]), 1);
  root.innerHTML = rows.slice(0, type === 'model' ? 8 : 12).map((row, i) => {
    const name = type === 'model' ? shortModel(row.model) : row.project;
    const detail = type === 'model' ? `${exact.format(row.messages)} respostas` : `${row.session_id.slice(0, 8)} · ${exact.format(row.messages)} respostas`;
    return `<div class="rank-row"><div class="rank-name"><strong>${i + 1}. ${esc(name)}</strong><small title="${esc(type === 'session' ? row.cwd : row.model)}">${esc(detail)}</small></div>
      <div class="mini-bar"><i style="--value:${row[metric] / max * 100}%;background:${COLORS[i % COLORS.length]}"></i></div>
      <div class="rank-value">${formatTokens(row[metric])}<small>${metricLabel(metric)}</small></div></div>`;
  }).join('') || '<div class="empty">Sem dados.</div>';
}

function shortModel(model) { return model.replace(/^claude-/, '').replace(/-\d{8}$/, ''); }
function metricLabel(metric) { return ({ total_tokens: 'processados', fresh_tokens: 'novos', output_tokens: 'saída', thinking_tokens: 'thinking' })[metric]; }
function localInputValue(timestamp) { const d = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }

document.getElementById('presets').addEventListener('click', event => {
  const button = event.target.closest('[data-range]'); if (!button) return;
  state.range = button.dataset.range; state.custom = null; document.querySelectorAll('[data-range]').forEach(x => x.classList.toggle('active', x === button)); load();
});
document.getElementById('metricSelect').addEventListener('change', event => { state.metric = event.target.value; renderTimeline(); renderRanking('models', state.data.models, 'model'); renderRanking('sessionList', state.data.sessions, 'session'); });
document.getElementById('applyCustom').addEventListener('click', () => {
  const start = new Date(document.getElementById('fromInput').value).getTime(); const end = new Date(document.getElementById('toInput').value).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && start < end) { document.querySelectorAll('[data-range]').forEach(x => x.classList.remove('active')); load({ start, end }); }
});
document.getElementById('fromInput').value = localInputValue(Date.now() - DURATIONS['5h']);
document.getElementById('toInput').value = localInputValue(Date.now());
load(); setInterval(() => load(), 30_000); setInterval(() => { if (state.limits) renderLimits(); }, 60_000);
