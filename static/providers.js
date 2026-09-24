/* Provider-specific data stays separate; quota percentages are never added. */
function quotaSamples(samples, limit) {
  const reset = Date.parse(limit?.resets_at);
  const duration = (limit?.window_minutes || 10080) * 60000;
  return (samples || []).filter(sample => sample.key === limit?.key &&
    Date.parse(sample.resets_at) === reset && sample.observed_ms >= reset - duration &&
    sample.observed_ms < reset && Number.isFinite(sample.utilization))
    .sort((a, b) => a.observed_ms - b.observed_ms);
}

async function loadCodex(start, end, sync, force) {
  try {
    const results = await Promise.allSettled([
      fetch(`/api/codex/dashboard?from=${start}&to=${end}${sync ? '&sync=1' : ''}`).then(r => r.json()),
      fetch(`/api/codex/limits${force ? '?force=1' : sync ? '?sync=1' : ''}`).then(r => r.json()),
    ]);
    const [activity, limits] = results.map(result => result.status === 'fulfilled'
      ? result.value : { ok: false, error: tr('falha na atualização') });
    state.codex = { activity, limits };
    if (!limits.ok && activity.local_limits?.ok) {
      state.codex.limits = { ...activity.local_limits, stale: true, error: limits.error };
    }
  } catch {
    state.codex = { activity: { ok: false }, limits: { ok: false } };
  }
}

function providerStatus(payload) {
  const local = payload?.source === 'codex_local_snapshot';
  const label = local ? tr('Snapshot local') : tr('Último sync oficial:');
  const timestamp = payload?.fetched_at ? new Date(payload.fetched_at).toLocaleString(locale()) : tr('Sem sync oficial');
  return `${label} ${timestamp}${payload?.stale ? ` · ${tr('Dados desatualizados')}` : ''}${payload?.error ? ` · ${payload.error}` : ''}`;
}

function renderProviders() {
  document.getElementById('claudeSync').textContent = providerStatus(state.limits);
  const { activity, limits } = state.codex || {};
  document.getElementById('codexSync').textContent = providerStatus(limits);
  const root = document.getElementById('codexLimits');
  root.innerHTML = (limits?.limits || []).map(limit => {
    const pct = limit.utilization;
    const pace = paceFor(limit, activity?.profile, limits.fetched_at);
    const weekly = limit.window_minutes === 10080;
    const duration = weekly ? tr('Semanal') : `${limit.window_minutes / 60}h`;
    const live = limits.source === 'codex_app_server';
    return `<article class="limit panel" style="--ring-color:${tone(pct)}">
      <div class="limit-title"><strong>${esc(limit.label)} · ${duration}</strong><span>${live ? tr('plano oficial') : tr('Snapshot local')}</span></div>
      <div class="limit-value"><strong>${pct.toFixed(1)}%</strong><span>${tr('utilizado')}</span></div>
      <div class="bar" style="--bar-color:${tone(pct)}"><i style="--value:${pct}%"></i></div>
      <div class="limit-meta"><span>${tr('restam')} ${(100 - pct).toFixed(0)}%</span><span>${tr('reset em')} ${countdown(limit.resets_at)} · ${formatDate(limit.resets_at)}</span></div>
      ${pace ? `<div class="pace-head"><span class="pace-badge ${pace.className}">${pace.label}</span><span>${tr('ideal do modo')}: ${pace.expected.toFixed(0)}%</span></div>
        <div class="pace-grid"><span><small>${tr('Pressão vs padrão')}</small><strong>${pace.pressure.toFixed(2)}×</strong></span><span><small>${tr('Pode gastar')}</small><strong>${pace.sustainableRate.toFixed(1)}%/h</strong></span><span><small>${tr('Margem')}</small><strong>${pace.margin.toFixed(0)} pp</strong></span></div>
        <p class="projection ${pace.reachesBeforeReset ? 'warning' : ''}">${pace.reachesBeforeReset ? `${tr('Mantendo seu padrão, chega a 100%')} ${clock(pace.projectedMs)}` : tr('Mantendo seu padrão, não chega a 100% antes do reset')}</p>
        <p class="profile-source">${pace.historical ? paceModeLabel() : tr('Estimativa linear')} · ${tr('Estimativa na data do snapshot')}</p>`
        : `<p class="projection">${tr('Janela encerrada ou dados insuficientes. Sincronize para atualizar.')}</p>`}
    </article>`;
  }).join('') || `<div class="panel empty">${tr('Codex indisponível. Use Sync ou verifique o login do CLI.')}</div>`;
  renderCodexCurve();
  const totals = activity?.totals || {};
  const metrics = [[tr('Volume processado'), 'total_tokens'], [tr('Input sem cache'), 'input_tokens'],
    ['Output', 'output_tokens'], [tr('Leitura de cache'), 'cache_read_tokens'], ['Thinking', 'thinking_tokens']];
  document.getElementById('codexMetrics').innerHTML = metrics.map(([label, key]) =>
    `<article class="metric panel"><span>${label}</span><strong>${activity?.ok ? formatTokens(totals[key]) : '—'}</strong><small>${key === 'thinking_tokens' ? tr('parte do output; não somar novamente') : tr('no intervalo selecionado')}</small></article>`).join('');
  renderRanking('codexModels', activity?.models || [], 'model', true);
  renderRanking('codexSessions', activity?.sessions || [], 'session', true);
  renderProviderActivity();
}

function renderCodexCurve() {
  const root = document.getElementById('codexCurve');
  const note = document.getElementById('codexCurveNote');
  const { activity, limits } = state.codex || {};
  const limit = limits?.limits?.find(item => item.window_minutes === 10080 && item.bucket === 'codex')
    || limits?.limits?.find(item => item.window_minutes === 10080);
  if (!limit || Date.parse(limit.resets_at) <= Date.now()) {
    root.innerHTML = `<div class="empty">${tr('Janela encerrada ou dados insuficientes. Sincronize para atualizar.')}</div>`;
    note.textContent = '';
    return;
  }
  const reset = Date.parse(limit.resets_at), start = reset - 168 * 36e5;
  const profile = activity?.profile?.ok ? activity.profile : null;
  const slots = profile ? selectedProfileSlots(profile, start) : Array(168).fill(1 / 168);
  const samples = quotaSamples(state.snapshots?.codex, limit);
  const width = 600, height = 270, left = 38, bottom = 235;
  const x = ms => left + (ms - start) / (reset - start) * 545;
  const y = percent => bottom - Math.max(0, Math.min(100, percent)) * 2.1;
  const expected = [{ ms: start, pct: 0 }];
  let sum = 0;
  slots.forEach((weight, index) => { sum += weight * 100; expected.push({ ms: start + (index + 1) * 36e5, pct: sum }); });
  const path = points => points.map((point, i) => `${i ? 'L' : 'M'}${x(point.ms).toFixed(2)},${y(point.pct).toFixed(2)}`).join(' ');
  // Break observed lines at long gaps and downward corrections; no invented history.
  const observedPath = samples.map((sample, i) => {
    const prev = samples[i - 1];
    const connected = prev && sample.observed_ms - prev.observed_ms <= 30 * 60000 && sample.utilization >= prev.utilization;
    return `${connected ? 'L' : 'M'}${x(sample.observed_ms).toFixed(2)},${y(sample.utilization).toFixed(2)}`;
  }).join(' ');
  const pace = paceFor(limit, profile, limits.fetched_at);
  const observedMs = Date.parse(limits.fetched_at);
  const projection = pace && observedMs >= start && observedMs < reset
    ? [{ ms: observedMs, pct: limit.utilization }, ...expected.filter(p => p.ms > observedMs).map(p => ({ ms: p.ms, pct: p.pct * pace.pressure }))] : [];
  const grid = [0, 25, 50, 75, 100].map(p => `<line x1="${left}" y1="${y(p)}" x2="583" y2="${y(p)}" class="curve-grid-line"/><text x="30" y="${y(p) + 4}" text-anchor="end" class="curve-axis-label">${p}%</text>`).join('');
  const labels = [0, 2, 4, 6].map(day => {
    const ms = start + day * 24 * 36e5;
    return `<text x="${x(ms)}" y="258" class="curve-axis-label">${esc(new Date(ms).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric' }))}</text>`;
  }).join('');
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="presentation">${grid}${labels}<path d="${path(expected)}" class="curve-expected-line"/><path d="${observedPath}" class="curve-actual-line"/><path d="${path(projection)}" class="curve-projection-line"/>${samples.map(s => `<circle cx="${x(s.observed_ms)}" cy="${y(s.utilization)}" r="3" class="curve-now-point"><title>${esc(formatDate(s.observed_ms))} · ${s.utilization}%</title></circle>`).join('')}</svg>`;
  note.textContent = `${limit.label} · ${profile ? `${paceModeLabel()} · ${profile.sample_hours} ${tr('horas com dados')}` : tr('Estimativa linear')} · ${samples.length} ${tr('snapshots neste ciclo')}. ${tr('Sem interpolação em lacunas maiores que 30 min. Projeção não é medição.')}`;
}

function renderProviderActivity() {
  const providers = [['Claude', state.data, '#d97757'], ['Codex', state.codex?.activity, '#79b7b1']];
  const start = state.data.range.start_ms, end = state.data.range.end_ms;
  const count = 60;
  const rows = providers.map(([name, data, color]) => {
    const buckets = Array(count).fill(0);
    for (const event of data?.timeline || []) {
      const index = Math.min(count - 1, Math.max(0, Math.floor((event.bucket_ms - start) / (end - start) * count)));
      buckets[index] += event.total_tokens;
    }
    return { name, data, color, buckets };
  });
  const max = Math.max(1, ...rows.flatMap(row => row.buckets));
  document.getElementById('providerActivity').innerHTML = rows.map(({ name, data, color, buckets }) =>
    `<div class="provider-activity-row"><span>${name}<small>${data?.totals?.sessions || 0} ${tr('sessões ativas')}</small></span><svg class="activity-spark" viewBox="0 0 600 60" preserveAspectRatio="none" role="img" aria-label="${name}">${buckets.map((n, i) => `<rect x="${i * 10}" y="${60 - n / max * 60}" width="8" height="${n / max * 60}" fill="${color}"><title>${esc(formatDate(start + i / count * (end - start)))} · ${formatTokens(n)}</title></rect>`).join('')}</svg><strong>${data?.ok ? formatTokens(data.totals.total_tokens) : '—'}<small>${tr('processados')}</small></strong></div>`).join('');
}

if (typeof module !== 'undefined') module.exports = { quotaSamples };
