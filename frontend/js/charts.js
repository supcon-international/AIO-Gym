// Real-time strip charts (uPlot), driven by the active model's `trends` spec —
// each scenario declares what to plot (levels, temps, power, concentration, …),
// so the charts adapt automatically. Builds its own panels into a container.

const WINDOW = 2200;
export const TANK_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#0D9488', '#D97706', '#0891B2'];
const MONO = '"IBM Plex Mono", monospace';

function h(tag, props = {}, html) {
  const e = document.createElement(tag);
  for (const k in props) e.setAttribute(k, props[k]);
  if (html != null) e.innerHTML = html;
  return e;
}

function makeChart(chartDiv, n, spIdx = [], fmtY = (v) => v) {
  const series = [{}];
  for (let i = 0; i < n; i++) series.push({ stroke: TANK_COLORS[i % TANK_COLORS.length], width: 2 });
  for (const k of spIdx) series.push({ stroke: TANK_COLORS[k % TANK_COLORS.length], width: 1.2, dash: [4, 4] });
  const data = [[]]; for (let i = 0; i < n + spIdx.length; i++) data.push([]);
  const opts = {
    width: chartDiv.clientWidth || 600, height: 132, padding: [8, 10, 0, 6], legend: { show: false },
    cursor: { show: true, points: { show: false }, drag: { x: false, y: false } },
    scales: { x: { time: false }, y: {} },
    axes: [
      { stroke: '#585C62', grid: { stroke: '#ECECEC', width: 1 }, ticks: { stroke: '#ECECEC' }, font: `10px ${MONO}`, values: (u, v) => v.map((x) => `${x | 0}s`) },
      { stroke: '#585C62', grid: { stroke: '#ECECEC', width: 1 }, ticks: { stroke: '#ECECEC' }, font: `10px ${MONO}`, size: 42, values: (u, v) => v.map(fmtY) },
    ],
    series,
  };
  return { u: new uPlot(opts, data, chartDiv), data, n, spIdx };
}

export function buildCharts(host, trends, n) {
  host.innerHTML = '';
  const charts = trends.map((tr) => {
    const spIdx = tr.spIdx || [];
    let legend = '';
    for (let i = 0; i < n; i++) legend += `<span><i style="background:${TANK_COLORS[i % TANK_COLORS.length]}"></i>${i + 1}</span>`;
    if (spIdx.length) legend += `<span><i style="background:#9aa0a6"></i>SP</span>`;
    const panel = h('div', { class: 'panel chart-panel' });
    panel.append(h('div', { class: 'panel-h' }, `<span>${tr.label}</span><span class="legend">${legend}</span>`));
    const chartDiv = h('div', { class: 'chart' });
    panel.append(chartDiv); host.append(panel);
    const fmtY = (v) => v.toFixed(tr.fmt ?? 1);
    return { tr, ...makeChart(chartDiv, n, spIdx, fmtY), chartDiv };
  });

  const trim = (c) => { if (c.data[0].length > WINDOW) { const cut = c.data[0].length - WINDOW; for (const col of c.data) col.splice(0, cut); } };
  function pushOne(c, t, frame) {
    const arr = (frame.state[c.tr.field] || []).map((v) => v * (c.tr.scale || 1));
    c.data[0].push(t);
    for (let i = 0; i < c.n; i++) c.data[1 + i].push(arr[i]);
    if (c.tr.sp) { const sp = frame.setpoints[c.tr.sp] || []; for (let k = 0; k < c.spIdx.length; k++) c.data[1 + c.n + k].push(sp[c.spIdx[k]]); }
    trim(c);
  }
  const redraw = (reset) => charts.forEach((c) => c.u.setData(c.data, reset));
  let last = 0;
  return {
    push(frame) {
      charts.forEach((c) => pushOne(c, frame.t, frame));
      const now = performance.now(); if (now - last > 90) { redraw(false); last = now; }
    },
    fromHistory() {},
    resize() { charts.forEach((c) => c.u.setSize({ width: c.chartDiv.clientWidth, height: 132 })); },
    destroy() { charts.forEach((c) => c.u.destroy()); },
  };
}
