// Animated P&ID schematics — HMI v2, informed by high-performance-HMI practice
// (ISA-101): neutral greys are the NORMAL state, colour is a SIGNAL (amber =
// deviation, red = interlock), and analog values get moving-indicator bars with
// their acceptance/alarm bands drawn in, so "in band / off band" reads at a
// glance. Every actuator carries a tag badge (name + % + physical rate) — what
// the controller is DOING is first-class information. Media fills keep the
// temperature colour ramp (a deliberate teaching aid, kept low-saturation).
// A `compact` option strips badges/bars for small embeds (the challenge page).
import { t as L } from './i18n.js?v=25';   // aliased: `t` is used locally for tank refs

const SVG = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && n.appendChild(c));
  return n;
}
const txt = (s) => document.createTextNode(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- palette (HP-HMI: grey = normal, colour = signal) ----
const INK = '#5A626C', INK2 = '#8A93A0', MONO = 'IBM Plex Mono, monospace';
const WARN = '#E4A11B', CRIT = '#D64545', SPG = '#73B200';
const WARN_BG = 'rgba(228,161,27,.28)', CRIT_BG = 'rgba(214,69,69,.30)', NORM_BG = 'rgba(115,178,0,.14)';

const STOPS = [[10, [30, 90, 200]], [38, [20, 170, 160]], [60, [230, 150, 40]], [88, [225, 60, 60]]];
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function tempColor(T) {
  if (T <= STOPS[0][0]) return rgb(STOPS[0][1]);
  if (T >= STOPS[STOPS.length - 1][0]) return rgb(STOPS[STOPS.length - 1][1]);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i], [t1, c1] = STOPS[i + 1];
    if (T >= t0 && T <= t1) {
      const f = (T - t0) / (t1 - t0);
      return rgb(c0.map((c, j) => Math.round(c + f * (c1[j] - c))));
    }
  }
  return rgb(STOPS[0][1]);
}
// comfort colouring for occupied spaces: in-band = calm green, cold = blue, hot = orange
function comfortColor(T, lo = 20, hi = 24) {
  if (T >= lo && T <= hi) return '#BFE0C2';
  if (T < lo) { const f = clamp((lo - T) / 8, 0, 1); return rgb([191 - f * 60, 224 - f * 30, 194 + f * 46]); }
  const f = clamp((T - hi) / 8, 0, 1); return rgb([191 + f * 55, 224 - f * 60, 194 - f * 80]);
}
function setFlow(flowEl, q, qref) {
  if (q > 1e-7) {
    flowEl.setAttribute('opacity', Math.min(0.95, 0.35 + q / qref));
    flowEl.style.animationDuration = `${clamp(0.9 / (0.2 + q / qref), 0.25, 2.5)}s`;
  } else flowEl.setAttribute('opacity', 0);
}
function glowFilter(id, dev) {
  const f = el('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' });
  f.appendChild(el('feGaussianBlur', { stdDeviation: dev, result: 'b' }));
  const m = el('feMerge');
  m.appendChild(el('feMergeNode', { in: 'b' }));
  m.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
  f.appendChild(m);
  return f;
}
function defsBlock() {
  const defs = el('defs');
  defs.appendChild(glowFilter('glowHeat', 3.2));
  defs.appendChild(glowFilter('glowPump', 2.0));
  const m = el('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5.5, markerHeight: 5.5, orient: 'auto' });
  m.appendChild(el('path', { d: 'M0.5,0.5 L8,4 L0.5,7.5 Z', fill: 'context-stroke' }));
  defs.appendChild(m);
  return defs;
}
const HALO = { stroke: '#ffffff', 'stroke-width': 3.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round' };
const hoverable = (node, title) => { if (title) node.appendChild(el('title', {}, txt(title))); return node; };

// ---- moving analog indicator (the HP-HMI signature component) ----
// Vertical strip with alarm/acceptance bands painted on the span; a black PV
// pointer and a green SP caret move along it. zones: [lo, hi, 'norm'|'warn'|'crit'].
function analogBar(svg, x, y, h, { min, max, zones = [], ticks = [] }) {
  const g = el('g');
  const yOf = (v) => y + h - clamp((v - min) / (max - min), 0, 1) * h;
  g.appendChild(el('rect', { x, y, width: 9, height: h, rx: 2.5, fill: '#EFF2F4', stroke: '#D5DAE0', 'stroke-width': 0.8 }));
  const Z = { norm: NORM_BG, warn: WARN_BG, crit: CRIT_BG };
  for (const [lo, hi, kind] of zones) {
    const y1 = yOf(Math.min(hi, max)), y2 = yOf(Math.max(lo, min));
    g.appendChild(el('rect', { x: x + 0.8, y: y1, width: 7.4, height: Math.max(0, y2 - y1), fill: Z[kind] || NORM_BG }));
  }
  for (const [v, label, color] of ticks) {
    g.appendChild(el('line', { x1: x - 1.5, x2: x + 10.5, y1: yOf(v), y2: yOf(v), stroke: color || INK2, 'stroke-width': 1 }));
    if (label) g.appendChild(el('text', { x: x + 13, y: yOf(v) + 3, fill: color || INK2, 'font-size': 8.5, 'font-family': MONO }, txt(label)));
  }
  const pv = el('path', { d: 'M0,0 l-7,-4.5 v9 Z', fill: '#1F2733' });
  const sp = el('path', { d: 'M0,0 l7,-4 v8 Z', fill: SPG });
  g.appendChild(pv); g.appendChild(sp);
  svg.appendChild(g);
  return {
    g,
    set(pvV, spV) {
      pv.setAttribute('transform', `translate(${x},${yOf(pvV)})`);
      if (spV == null) sp.setAttribute('opacity', 0);
      else { sp.setAttribute('opacity', 1); sp.setAttribute('transform', `translate(${x + 9},${yOf(spV)})`); }
    },
  };
}

// ---- actuator/instrument tag badge: name over value, with a status edge ----
function tagBadge(svg, x, y, w, name, title) {
  const g = hoverable(el('g'), title || name);
  g.appendChild(el('rect', { x, y, width: w, height: 30, rx: 4, fill: '#FFFFFF', stroke: '#D9DDE2', 'stroke-width': 1 }));
  const edge = el('rect', { x, y, width: 3, height: 30, rx: 1.5, fill: '#C3C9D0' });
  g.appendChild(edge);
  g.appendChild(el('text', { x: x + 8, y: y + 12, fill: INK2, 'font-size': 8.5, 'font-weight': 600, 'letter-spacing': '.4' }, txt(name)));
  const val = el('text', { x: x + 8, y: y + 25, fill: '#1F2733', 'font-size': 11.5, 'font-weight': 700, 'font-family': MONO }, txt('--'));
  g.appendChild(val);
  svg.appendChild(g);
  return { g, set(text, level) { val.textContent = text; edge.setAttribute('fill', level === 'crit' ? CRIT : level === 'warn' ? WARN : '#C3C9D0'); } };
}

// ---- interlock badge (hidden until tripped) ----
function tripBadge(svg, cx, cy, label) {
  const g = el('g', { opacity: 0, 'pointer-events': 'none' });
  const wid = 12 * label.length * 0.9 + 30;
  g.appendChild(el('rect', { x: cx - wid / 2, y: cy - 13, width: wid, height: 26, rx: 6, fill: CRIT, stroke: '#fff', 'stroke-width': 1.5 }));
  g.appendChild(el('text', { x: cx, y: cy + 4.5, fill: '#fff', 'font-size': 12.5, 'font-weight': 800, 'text-anchor': 'middle' }, txt('⛔ ' + label)));
  svg.appendChild(g);
  return { show(on) { g.setAttribute('opacity', on ? 1 : 0); } };
}

// Reusable tank cell: water + heater coil + glass + readouts.
function tankCell(g, x, y, w, h, label) {
  const innerH = h - 16, bottomY = y + h - 8;
  const water = el('rect', { x: x + 4, y: bottomY, width: w - 8, height: 0, fill: '#9CC2F0', rx: 2, opacity: 0.55 });
  const cap = el('rect', { x: x + 4, y: bottomY, width: w - 8, height: 2.5, fill: '#050B14', opacity: 0.12 });
  const coil = el('path', { d: coilPath(x + 14, bottomY - 12, w - 28), stroke: '#C3C7CC', 'stroke-width': 3.2, fill: 'none', 'stroke-linecap': 'round' });
  const glass = el('rect', { x, y, width: w, height: h, rx: 6, fill: 'none', stroke: INK, 'stroke-width': 1.6 });
  const spLine = el('line', { x1: x, y1: bottomY, x2: x + w, y2: bottomY, stroke: SPG, 'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0 });
  const tempT = el('text', { x: x + w / 2, y: y + h / 2 - 2, fill: '#0B1220', 'font-size': 21, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('--'));
  const tspT = el('text', { x: x + w / 2, y: y + h / 2 + 16, fill: '#3F6B00', 'font-size': 10, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt(''));
  const lvlT = el('text', { x: x + w / 2, y: bottomY - 6, fill: '#0B1220', 'font-size': 11, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('--'));
  const title = el('text', { x: x + w / 2, y: y - 7, fill: '#585C62', 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle' }, txt(label));
  [water, cap, coil, glass, spLine, tempT, tspT, lvlT, title].forEach((e) => g.appendChild(e));
  hoverable(g, label);
  return { water, cap, coil, spLine, tempT, tspT, lvlT, x, y, w, h, innerH, bottomY };
}
function coilPath(x, y, w) {
  const seg = w / 5;
  let d = `M${x},${y}`;
  for (let i = 0; i < 5; i++) d += ` q${seg / 2},${i % 2 ? 10 : -10} ${seg},0`;
  return d;
}
function paintTank(t, level, temp, hmax, tHigh) {
  const hpx = clamp(level / hmax, 0, 1) * t.innerH;
  t.water.setAttribute('y', t.bottomY - hpx);
  t.water.setAttribute('height', hpx);
  t.water.setAttribute('fill', tempColor(temp));
  t.cap.setAttribute('y', t.bottomY - hpx);
  t.cap.setAttribute('opacity', hpx > 2 ? 0.12 : 0);
  t.tempT.textContent = temp.toFixed(1);
  t.tempT.setAttribute('fill', temp >= (tHigh || 80) ? CRIT : '#0B1220');
  t.lvlT.textContent = `${level.toFixed(2)} m`;
}
function paintHeater(coil, frac, tripped) {
  if (tripped) { coil.setAttribute('stroke', CRIT); coil.setAttribute('filter', ''); coil.setAttribute('opacity', 0.95); coil.setAttribute('stroke-width', 3.6); }
  else if (frac > 0.01) {
    coil.setAttribute('stroke', `rgb(${Math.round(225 - frac * 30)},${Math.round(140 - frac * 95)},20)`);
    coil.setAttribute('filter', 'url(#glowHeat)');
    coil.setAttribute('opacity', 0.65 + frac * 0.35);
    coil.setAttribute('stroke-width', 3.2 + frac * 1.8);
  } else { coil.setAttribute('stroke', '#C3C7CC'); coil.setAttribute('filter', ''); coil.setAttribute('opacity', 1); coil.setAttribute('stroke-width', 3.2); }
}
function pumpSymbol(svg, x, y, label) {
  const g = hoverable(el('g'), label);
  const c = el('circle', { cx: x, cy: y, r: 15, fill: '#fff', stroke: '#B0B4B9', 'stroke-width': 1.8 });
  g.appendChild(c);
  g.appendChild(el('path', { d: `M${x - 6},${y - 7} L${x + 8},${y} L${x - 6},${y + 7} Z`, fill: SPG }));
  g.appendChild(el('text', { x, y: y + 28, fill: '#585C62', 'font-size': 10, 'text-anchor': 'middle' }, txt(label)));
  svg.appendChild(g);
  return c;
}
function flowPipe(svg, d, color = '#5B8DEF') {
  svg.appendChild(el('path', { d, stroke: '#DCE0E5', 'stroke-width': 6, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const f = el('path', {
    d, stroke: color, 'stroke-width': 3, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    class: 'pipe-flow', 'stroke-dasharray': '7 7', opacity: 0, 'marker-end': 'url(#arrow)',
  });
  svg.appendChild(f);
  return f;
}
const pct = (v) => `${Math.round(v * 100)}%`;

export function buildSchematic(host, meta, opts = {}) {
  const f = { quadruple: buildQuadruple, cstr: buildCSTR, hvac: buildHVAC, heater: buildHeater }[meta.topology];
  return (f || buildCascade)(host, meta, opts);
}

// ---------------- Refinery fired heater (firebox + coil + stack O₂) ----------------
function buildHeater(host, meta, opts = {}) {
  host.innerHTML = '';
  const compact = !!opts.compact;
  const W = 720, H = 400;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const bx = 250, by = 90, bw = 220, bh = 240, cx = bx + bw / 2, bbot = by + bh;
  svg.appendChild(el('rect', { x: bx - 8, y: by - 8, width: bw + 16, height: bh + 16, rx: 10, fill: '#F3EDE4', stroke: '#B99D7B', 'stroke-width': 3 }));
  svg.appendChild(el('rect', { x: bx, y: by, width: bw, height: bh, rx: 6, fill: '#1c2430', stroke: INK, 'stroke-width': 1.5 }));
  svg.appendChild(el('text', { x: cx, y: by - 16, fill: '#9fb0c2', 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle' }, txt(meta.tank_labels[0])));

  // stack + flue O₂ readout + O₂ analog bar with the trip/acceptance bands
  const sx = bx + bw - 34;
  svg.appendChild(el('rect', { x: sx, y: by - 62, width: 30, height: 58, fill: '#E8EBEF', stroke: '#B0B4B9', 'stroke-width': 1.6 }));
  const flue = flowPipe(svg, `M${sx + 15},${by - 8} V${by - 66} H${sx + 78}`, '#9aa6b5');
  svg.appendChild(el('text', { x: sx + 84, y: by - 62, fill: '#585C62', 'font-size': 10 }, txt(L('烟气', 'Flue', '排ガス'))));
  const o2T = el('text', { x: sx + 84, y: by - 40, fill: '#0E8aa0', 'font-size': 15, 'font-weight': 700, 'font-family': MONO, ...HALO }, txt('O₂ --'));
  const o2SpT = el('text', { x: sx + 84, y: by - 24, fill: SPG, 'font-size': 10.5, 'font-family': MONO, ...HALO }, txt('SP --'));
  svg.appendChild(o2T); svg.appendChild(o2SpT);
  // O₂ bar: <1.2 trip (red), 1.2-1.6 warn, 1.6-5.5 economic band (norm), >5.5 wasteful (warn)
  const o2Bar = compact ? null : analogBar(svg, sx + 176, by - 70, 66,
    { min: 0, max: 8, zones: [[0, 1.2, 'crit'], [1.2, 1.6, 'warn'], [1.6, 5.5, 'norm'], [5.5, 8, 'warn']], ticks: [[1.2, '1.2⛔', CRIT], [5.5, '5.5', INK2]] });

  // process coil: feed in (left) -> outlet (right)
  const cy0 = by + 52;
  const coil = `M${bx - 90},${cy0} H${bx + 18} l14,-16 l24,32 l24,-32 l24,32 l24,-32 l24,32 l14,-16 H${bx + bw + 26} V${cy0 + 10}`;
  svg.appendChild(el('path', { d: coil, stroke: '#8B939C', 'stroke-width': 7, fill: 'none', 'stroke-linejoin': 'round' }));
  const feed = flowPipe(svg, `M${bx - 90},${cy0} H${bx + 10}`, '#2563EB');
  const prod = flowPipe(svg, `M${bx + bw - 4},${cy0} H${bx + bw + 26} V${cy0 + 64} H${bx + bw + 96}`, '#E4572E');
  const feedBadge = compact ? null : tagBadge(svg, bx - 158, cy0 - 16, 128, L('进料', 'FEED', '供給'), L('进料温度 · 流量', 'Feed temperature · rate', '供給温度・流量'));
  if (compact) svg.appendChild(el('text', { x: bx - 88, y: cy0 - 12, fill: '#585C62', 'font-size': 11 }, txt(L('进料', 'Feed', '供給'))));
  const outT = el('text', { x: bx + bw + 100, y: cy0 + 52, fill: '#0B1220', 'font-size': 26, 'font-weight': 700, 'font-family': MONO, ...HALO }, txt('--'));
  const outSp = el('text', { x: bx + bw + 100, y: cy0 + 72, fill: SPG, 'font-size': 11, 'font-family': MONO, ...HALO }, txt('SP --'));
  svg.appendChild(el('text', { x: bx + bw + 100, y: cy0 + 30, fill: '#585C62', 'font-size': 11 }, txt(L('出口温度', 'Outlet', '出口温度'))));
  svg.appendChild(outT); svg.appendChild(outSp);
  // outlet-temp bar: 362-378 spec band, up to 395 warn, 395-415 warn, >415 tube trip
  const outBar = compact ? null : analogBar(svg, bx + bw + 190, cy0 - 6, 116,
    { min: 330, max: 430, zones: [[330, 362, 'warn'], [362, 378, 'norm'], [378, 415, 'warn'], [415, 430, 'crit']], ticks: [[415, '415⛔', CRIT], [370, '370', INK2]] });

  // burners + fuel / air with actuator badges
  const flames = [];
  for (let i = 0; i < 3; i++) {
    const fx = cx - 56 + i * 56;
    const fl = el('path', { d: `M${fx - 12},${bbot - 6} Q${fx},${bbot - 66} ${fx + 12},${bbot - 6} Z`, fill: '#FF9E2C', opacity: 0.9 });
    svg.appendChild(fl); flames.push(fl);
  }
  const fuel = flowPipe(svg, `M${cx - 150},${bbot + 34} H${cx - 8} V${bbot - 2}`, '#C77700');
  const air = flowPipe(svg, `M${cx + 150},${bbot + 34} H${cx + 8} V${bbot - 2}`, '#0EA5C0');
  let fuelBadge = null, airBadge = null, fuelT = null, airT = null;
  if (compact) {
    svg.appendChild(el('text', { x: cx - 150, y: bbot + 22, fill: '#585C62', 'font-size': 11 }, txt(L('燃料气', 'Fuel gas', '燃料ガス'))));
    fuelT = el('text', { x: cx - 150, y: bbot + 52, fill: '#C77700', 'font-size': 11, 'font-weight': 600, 'font-family': MONO }, txt('--'));
    svg.appendChild(fuelT);
    svg.appendChild(el('text', { x: cx + 106, y: bbot + 22, fill: '#585C62', 'font-size': 11 }, txt(L('助燃风', 'Comb. air', '燃焼空気'))));
    airT = el('text', { x: cx + 106, y: bbot + 52, fill: '#0E8aa0', 'font-size': 11, 'font-weight': 600, 'font-family': MONO }, txt('--'));
    svg.appendChild(airT);
  } else {
    fuelBadge = tagBadge(svg, cx - 212, bbot + 20, 142, (meta.actuators.heaters[0] || 'FV-1'), L('燃料阀 · 开度与火力', 'Fuel valve · opening and duty', '燃料弁・開度と火力'));
    airBadge = tagBadge(svg, cx + 78, bbot + 20, 112, (meta.actuators.valves[0] || 'FD-1'), L('风门 · 开度', 'Air damper · opening', 'ダンパー・開度'));
  }
  const tfbT = el('text', { x: cx, y: bbot - 92, fill: '#ffd9a0', 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle', 'font-family': MONO }, txt('--'));
  svg.appendChild(tfbT);
  const trip = tripBadge(svg, cx, by + bh / 2, L('燃料联锁切断', 'FUEL TRIPPED', '燃料遮断'));
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, act = f.actuators, il = f.interlocks || {};
      const uf = act.heaters[0], ua = act.valves[0], O2 = s.levels[0], Tout = s.temps[0], Tfb = (s.tfb || [0])[0];
      const tripped = il.heater_trip && il.heater_trip[0];
      flames.forEach((fl, i) => {
        const fx = cx - 56 + i * 56, hgt = 6 + (tripped ? 0 : uf) * 62;
        fl.setAttribute('d', `M${fx - 12},${bbot - 6} Q${fx},${bbot - 6 - hgt} ${fx + 12},${bbot - 6} Z`);
        fl.setAttribute('fill', tripped || uf < 0.02 ? '#3a4552' : O2 < 1.6 ? '#E4572E' : O2 > 6 ? '#7FB8FF' : '#FF9E2C');
        fl.setAttribute('opacity', tripped || uf < 0.02 ? 0.5 : 0.92);
      });
      o2T.textContent = `O₂ ${O2.toFixed(2)}%`;
      o2T.setAttribute('fill', O2 < 1.8 ? CRIT : '#0E8aa0');
      o2SpT.textContent = `SP ${f.setpoints.h_sp[0].toFixed(1)}%`;
      if (o2Bar) o2Bar.set(O2, f.setpoints.h_sp[0]);
      outT.textContent = `${Tout.toFixed(1)}°`;
      outT.setAttribute('fill', Tout >= 395 ? CRIT : (Tout < 362 || Tout > 378) ? WARN : '#0B1220');
      outSp.textContent = `SP ${f.setpoints.t_sp[0].toFixed(0)}°`;
      if (outBar) outBar.set(Tout, f.setpoints.t_sp[0]);
      const feedTxt = `${s.t_cold.toFixed(0)}°C · ${(s.feed_rate ? s.feed_rate[0] : 0).toFixed(0)} kg/s`;
      const fuelTxt = `${pct(uf)} · ${(s.heater_power[0] * 1e-6).toFixed(1)} MW`;
      if (feedBadge) feedBadge.set(feedTxt);
      if (fuelBadge) fuelBadge.set(fuelTxt, tripped ? 'crit' : null);
      if (airBadge) airBadge.set(pct(ua), O2 < 1.6 ? 'warn' : null);
      if (fuelT) fuelT.textContent = fuelTxt;
      if (airT) airT.textContent = pct(ua);
      tfbT.textContent = `${L('炉膛', 'firebox', '炉内')} ${Tfb.toFixed(0)}°C`;
      setFlow(feed, 1, 1); setFlow(prod, 1, 1); setFlow(flue, tripped ? 0 : uf, 1);
      setFlow(fuel, tripped ? 0 : uf, 1); setFlow(air, ua, 1);
      trip.show(!!tripped);
    },
  };
}

// ---------------- Cascade ----------------
// Per-tank spec bands (mirror scoring.js ECON) + alarm caps (alarms.js LIMITS)
const CASCADE_BANDS = [[34, 44], [48, 58], [60, 72]];
function buildCascade(host, meta, opts = {}) {
  host.innerHTML = '';
  const compact = !!opts.compact;
  const n = meta.n_tanks, TW = 134, TH = 196, TY = 78, GAP = 226, X0 = 176;
  const tankX = (i) => X0 + i * GAP;
  const W = X0 + (n - 1) * GAP + TW + 168, H = compact ? 350 : 368;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const bottomY = TY + TH - 8, innerY = TY + 8;
  const refs = { tanks: [], pipes: [], vBadges: [], hBadges: [], tBars: [] };

  const pumpX = 92, pumpY = bottomY - 24;
  svg.appendChild(el('text', { x: 18, y: pumpY - 28, fill: '#585C62', 'font-size': 12 }, txt(L('冷水进料', 'Cold feed', '冷フィード'))));
  refs.coldT = el('text', { x: 18, y: pumpY - 13, fill: '#2563EB', 'font-size': 13, 'font-family': MONO }, txt('15°C'));
  svg.appendChild(refs.coldT);
  refs.feedFlow = flowPipe(svg, `M${pumpX + 16},${pumpY} H${tankX(0) - 26} V${innerY + 6} H${tankX(0) + 10}`);
  refs.pumpC = pumpSymbol(svg, pumpX, pumpY, meta.actuators.pumps[0] || 'P-01');
  refs.pumpBadge = compact ? null : tagBadge(svg, pumpX - 74, pumpY + 36, 132, meta.actuators.pumps[0] || 'P-01', L('进料泵 · 开度与流量', 'Feed pump · opening and flow', '供給ポンプ・開度と流量'));

  for (let i = 0; i < n; i++) {
    const x = tankX(i), g = el('g');
    svg.appendChild(g);
    const t = tankCell(g, x, TY, TW, TH, meta.tank_labels[i]);
    refs.tanks.push(t);
    // per-tank moving indicator: spec band + high/trip caps
    refs.tBars.push(compact ? null : analogBar(svg, x + TW + 7, TY + 8, TH - 26,
      { min: 10, max: 95, zones: [[CASCADE_BANDS[i][0], CASCADE_BANDS[i][1], 'norm'], [80, 92, 'warn'], [92, 95, 'crit']], ticks: [[CASCADE_BANDS[i][0], `${CASCADE_BANDS[i][0]}`], [CASCADE_BANDS[i][1], `${CASCADE_BANDS[i][1]}`]] }));
    // outlet pipe + valve
    const lowY = bottomY - 10, vx = x + TW + (GAP - TW) / 2;
    let d;
    if (i < n - 1) d = `M${x + TW},${lowY} H${vx} V${innerY + 6} H${tankX(i + 1) + 6}`;
    else { const dy = bottomY + 44; d = `M${x + TW},${lowY} H${vx} V${dy} H${vx + 60}`; svg.appendChild(el('text', { x: vx + 68, y: dy + 4, fill: '#585C62', 'font-size': 11 }, txt(L('排放', 'Drain', '排出')))); }
    refs.pipes.push(flowPipe(svg, d));
    const valG = hoverable(el('g', { transform: `translate(${vx},${lowY})` }), `${meta.actuators.valves[i] || 'V-' + (i + 1)}`);
    const bow = el('path', { d: 'M-10,-8 L0,0 L-10,8 Z M10,-8 L0,0 L10,8 Z', fill: '#CDCED0', stroke: '#B0B4B9', 'stroke-width': 1 });
    valG.appendChild(bow); svg.appendChild(valG);
    if (compact) svg.appendChild(el('text', { x: vx, y: lowY + 24, fill: '#585C62', 'font-size': 10, 'text-anchor': 'middle' }, txt(`V-${i + 1}`)));
    refs.vBadges.push(compact ? null : tagBadge(svg, vx - 31, lowY + 14, 62, `V-${i + 1}`, meta.actuators.valves[i]));
    refs.hBadges.push(compact ? null : tagBadge(svg, x + 6, bottomY + 26, 122, `E-${i + 1}`, meta.actuators.heaters[i]));
    t.valveBow = bow;
  }
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, sp = f.setpoints, act = f.actuators, lim = f.limits || {};
      const il = f.interlocks || { heater_trip: [], pump_trip: false };
      const hmax = lim.height_max || Array(n).fill(0.8);
      const pumpOn = s.pump_flow[0] > 1e-7 && !il.pump_trip;
      refs.pumpC.setAttribute('stroke', pumpOn ? SPG : '#B0B4B9');
      refs.pumpC.setAttribute('filter', pumpOn ? 'url(#glowPump)' : '');
      setFlow(refs.feedFlow, s.pump_flow[0], 0.0016);
      refs.coldT.textContent = `${s.t_cold.toFixed(1)}°C`;
      if (refs.pumpBadge) refs.pumpBadge.set(`${pct(act.pumps[0])} · ${(s.pump_flow[0] * 1000).toFixed(2)} L/s`, il.pump_trip ? 'crit' : null);
      for (let i = 0; i < n; i++) {
        const t = refs.tanks[i];
        paintTank(t, s.levels[i], s.temps[i], hmax[i], lim.t_high);
        if (s.temps[i] < (lim.t_high || 80) && (s.temps[i] < CASCADE_BANDS[i][0] || s.temps[i] > CASCADE_BANDS[i][1]))
          t.tempT.setAttribute('fill', WARN);
        t.tspT.textContent = `SP ${sp.t_sp[i].toFixed(0)}°`;
        const yOf = (h) => t.bottomY - clamp(h / hmax[i], 0, 1) * t.innerH;
        t.spLine.setAttribute('opacity', 0.85); t.spLine.setAttribute('y1', yOf(sp.h_sp[i])); t.spLine.setAttribute('y2', yOf(sp.h_sp[i]));
        paintHeater(t.coil, act.heaters[i], il.heater_trip[i]);
        const v = act.valves[i];
        t.valveBow.setAttribute('fill', v > 0.02 ? `rgb(56,${120 + Math.round(v * 80)},${180 + Math.round(v * 40)})` : '#CDCED0');
        setFlow(refs.pipes[i], s.tank_outflow[i], 0.0024);
        if (refs.tBars[i]) refs.tBars[i].set(s.temps[i], sp.t_sp[i]);
        if (refs.vBadges[i]) refs.vBadges[i].set(pct(v));
        if (refs.hBadges[i]) {
          const kw = s.heater_power[i] / 1000;
          const off = CASCADE_BANDS[i] && (s.temps[i] < CASCADE_BANDS[i][0] || s.temps[i] > CASCADE_BANDS[i][1]);
          refs.hBadges[i].set(`${pct(act.heaters[i])} · ${kw.toFixed(1)} kW`, il.heater_trip[i] ? 'crit' : off ? 'warn' : null);
        }
      }
    },
  };
}

// ---------------- Quadruple tank (Johansson) ----------------
const C1 = '#2563EB', C2 = '#7C3AED', CG = '#14B8A6';
const QUAD_BANDS = [[46, 58], [46, 58], [32, 46], [32, 46]];
function buildQuadruple(host, meta, opts = {}) {
  host.innerHTML = '';
  const compact = !!opts.compact;
  const TW = 152, TH = 104, W = 760, H = 492;
  const colL = 150, colR = 458, yUp = 50, yLo = 242;
  const cL = colL + TW / 2, cR = colR + TW / 2;
  const upBot = yUp + TH, loBot = yLo + TH;
  const Sy = 396, Py = 418, P1x = 346, P2x = 414;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const refs = { tanks: [], pumps: [], pipes: {}, tBars: [] };

  refs.pipes.r1 = flowPipe(svg, `M${P1x},${Py - 13} V${Sy}`, C1);
  refs.pipes.r2 = flowPipe(svg, `M${P2x},${Py - 13} V${Sy}`, C2);
  refs.pipes.p1d = flowPipe(svg, `M${P1x},${Sy} V312 H${colL + TW}`, C1);
  refs.pipes.p2d = flowPipe(svg, `M${P2x},${Sy} V312 H${colR}`, C2);
  refs.pipes.p1c = flowPipe(svg, `M${P1x},${Sy} L${colR},116`, C1);
  refs.pipes.p2c = flowPipe(svg, `M${P2x},${Sy} L${colL + TW},116`, C2);
  refs.pipes.d31 = flowPipe(svg, `M${cL},${upBot} V${yLo}`, CG);
  refs.pipes.d42 = flowPipe(svg, `M${cR},${upBot} V${yLo}`, CG);
  refs.pipes.o1 = flowPipe(svg, `M${cL},${loBot} V${loBot + 24} H${colL - 44}`, CG);
  refs.pipes.o2 = flowPipe(svg, `M${cR},${loBot} V${loBot + 24} H${colR + TW + 44}`, CG);

  // dynamic split fractions at the gamma valves (the teaching core of this rig)
  const tag = (x, y, color, s) => { const e = el('text', { x, y, fill: color, 'font-size': 10, 'font-weight': 600, 'text-anchor': 'middle', 'font-family': MONO }, txt(s)); svg.appendChild(e); return e; };
  refs.g1T = tag(P1x - 30, 302, C1, 'γ₁ --');
  refs.g2T = tag(P2x + 30, 302, C2, 'γ₂ --');
  refs.g1cT = tag(colR - 40, 210, C1, '--');
  refs.g2cT = tag(colL + TW + 40, 210, C2, '--');

  const pos = [[colL, yLo], [colR, yLo], [colL, yUp], [colR, yUp]];
  for (let i = 0; i < 4; i++) {
    const g = el('g'); svg.appendChild(g);
    refs.tanks.push(tankCell(g, pos[i][0], pos[i][1], TW, TH, meta.tank_labels[i]));
    refs.tBars.push(compact ? null : analogBar(svg, pos[i][0] + TW + 6, pos[i][1] + 4, TH - 8,
      { min: 10, max: 95, zones: [[QUAD_BANDS[i][0], QUAD_BANDS[i][1], 'norm'], [80, 92, 'warn'], [92, 95, 'crit']], ticks: [] }));
  }
  [cL, cR].forEach((cx) => svg.appendChild(el('text', { x: cx, y: yUp - 22, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('预热 · 进料', 'Preheat / feed', '予熱 · 供給')))));
  [cL, cR].forEach((cx) => svg.appendChild(el('text', { x: cx, y: loBot + 16, fill: '#585C62', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('受控液位', 'Controlled level', '制御液位')))));
  svg.appendChild(el('text', { x: colL - 50, y: loBot + 20, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('出料', 'Out', '産出'))));
  svg.appendChild(el('text', { x: colR + TW + 50, y: loBot + 20, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('出料', 'Out', '産出'))));

  const splitValve = (x, color) => svg.appendChild(el('path', { d: `M${x},${Sy - 6} L${x + 6},${Sy} L${x},${Sy + 6} L${x - 6},${Sy} Z`, fill: color, stroke: '#fff', 'stroke-width': 1.2 }));
  refs.pumps.push(pumpSymbol(svg, P1x, Py, meta.actuators.pumps[0]));
  refs.pumps.push(pumpSymbol(svg, P2x, Py, meta.actuators.pumps[1]));
  splitValve(P1x, C1); splitValve(P2x, C2);
  refs.p1Badge = compact ? null : tagBadge(svg, P1x - 196, Py - 16, 128, meta.actuators.pumps[0], L('泵1 · 开度与流量', 'Pump 1 · opening and flow', 'ポンプ1・開度と流量'));
  refs.p2Badge = compact ? null : tagBadge(svg, P2x + 66, Py - 16, 128, meta.actuators.pumps[1], L('泵2 · 开度与流量', 'Pump 2 · opening and flow', 'ポンプ2・開度と流量'));

  const legend = (x, color, label) => {
    svg.appendChild(el('rect', { x, y: H - 30, width: 11, height: 11, rx: 2, fill: color }));
    svg.appendChild(el('text', { x: x + 16, y: H - 21, fill: '#585C62', 'font-size': 10 }, txt(label)));
  };
  if (!compact) { legend(150, C1, L('泵1 回路', 'Pump-1', 'ポンプ1 回路')); legend(250, C2, L('泵2 回路', 'Pump-2', 'ポンプ2 回路')); legend(350, CG, L('重力 / 出料', 'Gravity / out', '重力 / 産出')); }
  refs.phase = el('text', { x: W / 2, y: H - 6, fill: '#585C62', 'font-size': 11, 'text-anchor': 'middle', 'font-weight': 600 }, txt(''));
  svg.appendChild(refs.phase);
  host.appendChild(svg);

  const ctrl = meta.controlled_levels || [0, 1];
  return {
    update(f) {
      const s = f.state, sp = f.setpoints, act = f.actuators, lim = f.limits || {};
      const il = f.interlocks || { heater_trip: [], pump_trip: false };
      const hmax = lim.height_max || Array(4).fill(0.8);
      const cfg = (f.meta && f.meta.config) || {};
      const Qmax = (lim.pump_flow_max && lim.pump_flow_max[0]) || 0.0013;
      for (let i = 0; i < 4; i++) {
        const t = refs.tanks[i];
        paintTank(t, s.levels[i], s.temps[i], hmax[i], lim.t_high);
        paintHeater(t.coil, act.heaters[i], il.heater_trip[i]);
        if (ctrl.includes(i)) {
          const yOf = (h) => t.bottomY - clamp(h / hmax[i], 0, 1) * t.innerH;
          t.spLine.setAttribute('opacity', 0.85); t.spLine.setAttribute('y1', yOf(sp.h_sp[i])); t.spLine.setAttribute('y2', yOf(sp.h_sp[i]));
        }
        t.tspT.textContent = `SP ${sp.t_sp[i].toFixed(0)}°`;
        if (refs.tBars[i]) refs.tBars[i].set(s.temps[i], sp.t_sp[i]);
      }
      const Q1 = s.pump_flow[0], Q2 = s.pump_flow[1];
      const g1 = cfg.gamma1 != null ? cfg.gamma1 : 0.7, g2 = cfg.gamma2 != null ? cfg.gamma2 : 0.7;
      [refs.pumps[0], refs.pumps[1]].forEach((c, k) => {
        const on = (k ? Q2 : Q1) > 1e-7 && !il.pump_trip;
        c.setAttribute('stroke', on ? SPG : '#B0B4B9');
        c.setAttribute('filter', on ? 'url(#glowPump)' : '');
      });
      if (refs.p1Badge) refs.p1Badge.set(`${pct(act.pumps[0])} · ${(Q1 * 1000).toFixed(2)} L/s`, il.pump_trip ? 'crit' : null);
      if (refs.p2Badge) refs.p2Badge.set(`${pct(act.pumps[1])} · ${(Q2 * 1000).toFixed(2)} L/s`, il.pump_trip ? 'crit' : null);
      refs.g1T.textContent = `γ₁ ${g1.toFixed(2)}`; refs.g2T.textContent = `γ₂ ${g2.toFixed(2)}`;
      refs.g1cT.textContent = `1−γ₁ ${(1 - g1).toFixed(2)}`; refs.g2cT.textContent = `1−γ₂ ${(1 - g2).toFixed(2)}`;
      setFlow(refs.pipes.r1, Q1, Qmax); setFlow(refs.pipes.r2, Q2, Qmax);
      setFlow(refs.pipes.p1d, g1 * Q1, Qmax); setFlow(refs.pipes.p1c, (1 - g1) * Q1, Qmax);
      setFlow(refs.pipes.p2d, g2 * Q2, Qmax); setFlow(refs.pipes.p2c, (1 - g2) * Q2, Qmax);
      setFlow(refs.pipes.d31, s.tank_outflow[2], Qmax); setFlow(refs.pipes.d42, s.tank_outflow[3], Qmax);
      setFlow(refs.pipes.o1, s.tank_outflow[0], Qmax); setFlow(refs.pipes.o2, s.tank_outflow[1], Qmax);
      refs.phase.textContent = cfg.phase
        ? `γ₁=${g1.toFixed(2)}  γ₂=${g2.toFixed(2)}  ·  ${L('传输零点', 'Zero', '伝送零点')}: ${cfg.phase}`
        : '';
    },
  };
}

// ---------------- CSTR (exothermic reactor + cooling jacket) ----------------
function buildCSTR(host, meta, opts = {}) {
  host.innerHTML = '';
  const compact = !!opts.compact;
  const W = 720, H = 400;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const rx = 280, ry = 86, rw = 180, rh = 214, cx = rx + rw / 2, rbot = ry + rh;
  const feed = flowPipe(svg, `M120,150 V${ry - 14} H${cx} V${ry}`, '#2563EB');
  const prod = flowPipe(svg, `M${cx},${rbot} V${rbot + 26} H${rx + rw + 70}`, '#5B8DEF');
  svg.appendChild(el('text', { x: 120, y: 138, fill: '#585C62', 'font-size': 11, 'text-anchor': 'middle' }, txt(L('进料', 'Feed', '供給'))));
  const feedPump = pumpSymbol(svg, 120, 150, meta.actuators.pumps[0]);
  const feedBadge = compact ? null : tagBadge(svg, 56, 176, 128, meta.actuators.pumps[0], L('进料 · 开度', 'Feed · opening', '供給・開度'));
  svg.appendChild(el('text', { x: rx + rw + 78, y: rbot + 30, fill: '#585C62', 'font-size': 11 }, txt(L('产品', 'Product', '製品'))));
  const jacket = el('rect', { x: rx - 12, y: ry - 8, width: rw + 24, height: rh + 16, rx: 14, fill: 'none', stroke: '#9AD3DA', 'stroke-width': 6 });
  svg.appendChild(jacket);
  const coolIn = flowPipe(svg, `M${rx - 70},${ry + 30} H${rx - 12}`, '#0EA5C0');
  const coolOut = flowPipe(svg, `M${rx - 12},${rbot - 30} H${rx - 70}`, '#0EA5C0');
  svg.appendChild(el('text', { x: rx - 78, y: ry + 22, fill: '#0E8aa0', 'font-size': 10 }, txt(L('冷却水', 'Coolant', '冷却水'))));
  const coolBadge = compact ? null : tagBadge(svg, rx - 200, ry + 44, 128, meta.actuators.heaters[0], L('冷却 · 开度与功率', 'Cooling · opening and duty', '冷却・開度と出力'));
  const liquid = el('rect', { x: rx + 3, y: ry + 3, width: rw - 6, height: rh - 6, rx: 8, fill: '#9CC2F0', opacity: 0.62 });
  svg.appendChild(liquid);
  svg.appendChild(el('rect', { x: rx, y: ry, width: rw, height: rh, rx: 10, fill: 'none', stroke: INK, 'stroke-width': 1.8 }));
  // stirrer with a gentle SMIL sweep (alive without being noisy)
  svg.appendChild(el('line', { x1: cx, y1: ry - 4, x2: cx, y2: ry + rh * 0.55, stroke: INK, 'stroke-width': 2 }));
  const paddle = el('line', { x1: cx - 22, y1: ry + rh * 0.55, x2: cx + 22, y2: ry + rh * 0.55, stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round' });
  paddle.appendChild(el('animate', { attributeName: 'x1', values: `${cx - 22};${cx - 6};${cx - 22}`, dur: '1.6s', repeatCount: 'indefinite' }));
  paddle.appendChild(el('animate', { attributeName: 'x2', values: `${cx + 22};${cx + 6};${cx + 22}`, dur: '1.6s', repeatCount: 'indefinite' }));
  svg.appendChild(paddle);
  svg.appendChild(el('text', { x: cx, y: ry - 14, fill: '#9fb0c2', 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle' }, txt(meta.tank_labels[0])));
  const tempT = el('text', { x: cx, y: ry + 92, fill: '#0B1220', 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('--'));
  const caT = el('text', { x: cx, y: ry + 122, fill: '#3F6B00', 'font-size': 14, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('Cₐ --'));
  const spT = el('text', { x: cx, y: ry + 142, fill: SPG, 'font-size': 11, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('SP --'));
  svg.appendChild(tempT); svg.appendChild(caT); svg.appendChild(spT);
  // reactor-temp indicator: economics hug <88, 88-92 amber, >92 runaway trip
  const tBar = compact ? null : analogBar(svg, rx + rw + 26, ry + 4, rh - 8,
    { min: 30, max: 110, zones: [[30, 88, 'norm'], [88, 92, 'warn'], [92, 110, 'crit']], ticks: [[88, '88', WARN], [92, '92⛔', CRIT]] });
  const trip = tripBadge(svg, cx, ry + 172, L('进料联锁切断', 'FEED TRIPPED', '供給遮断'));
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, act = f.actuators, il = f.interlocks || {}, lim = f.limits || {};
      const T = s.temps[0], Ca = (s.conc || [0])[0], uc = act.heaters[0];
      liquid.setAttribute('fill', tempColor(T));
      tempT.textContent = T.toFixed(1); tempT.setAttribute('fill', T >= (lim.t_high || 80) ? CRIT : '#0B1220');
      caT.textContent = `Cₐ ${Ca.toFixed(3)}`;
      spT.textContent = `SP ${f.setpoints.t_sp[0].toFixed(0)}°`;
      if (tBar) tBar.set(T, f.setpoints.t_sp[0]);
      if (uc > 0.02) { jacket.setAttribute('stroke', `rgb(${Math.round(150 - uc * 130)},${Math.round(200 - uc * 40)},220)`); jacket.setAttribute('filter', 'url(#glowPump)'); jacket.setAttribute('stroke-width', 6 + uc * 3); }
      else { jacket.setAttribute('stroke', '#cdd6da'); jacket.setAttribute('filter', ''); jacket.setAttribute('stroke-width', 6); }
      const feedOn = s.pump_flow[0] > 1e-9 && !il.pump_trip;
      feedPump.setAttribute('stroke', feedOn ? '#2dd4bf' : '#B0B4B9'); feedPump.setAttribute('filter', feedOn ? 'url(#glowPump)' : '');
      if (feedBadge) feedBadge.set(pct(act.pumps[0]), il.pump_trip ? 'crit' : null);
      if (coolBadge) coolBadge.set(`${pct(uc)} · ${(s.heater_power[0] / 1000).toFixed(1)} kW`, T >= 88 ? 'warn' : null);
      setFlow(feed, s.pump_flow[0], 0.02); setFlow(prod, s.pump_flow[0], 0.02);
      setFlow(coolIn, uc * 0.02, 0.02); setFlow(coolOut, uc * 0.02, 0.02);
      trip.show(!!il.pump_trip);
    },
  };
}

// ---------------- Two-zone HVAC ----------------
function buildHVAC(host, meta, opts = {}) {
  host.innerHTML = '';
  const compact = !!opts.compact;
  const W = 720, H = 380;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const outdoorT = el('text', { x: W / 2, y: 26, fill: '#585C62', 'font-size': 13, 'font-weight': 600, 'text-anchor': 'middle' }, txt(L('室外', 'Outdoor', '室外') + ' --'));
  svg.appendChild(outdoorT);
  const rooms = [];
  const RW = 220, RH = 180, RY = 110, xs = [110, 110 + RW + 60];
  for (let i = 0; i < 2; i++) {
    const x = xs[i], cx = x + RW / 2;
    const fill = el('rect', { x: x + 3, y: RY + 3, width: RW - 6, height: RH - 6, rx: 8, fill: '#BFE0C2', opacity: 0.75 });
    svg.appendChild(fill);
    svg.appendChild(el('rect', { x, y: RY, width: RW, height: RH, rx: 10, fill: 'none', stroke: INK, 'stroke-width': 1.8 }));
    const unit = el('rect', { x: cx - 34, y: RY - 26, width: 68, height: 22, rx: 4, fill: '#eef1f4', stroke: '#B0B4B9', 'stroke-width': 1.4 });
    svg.appendChild(hoverable(unit, meta.actuators.heaters[i]));
    svg.appendChild(el('text', { x: cx, y: RY + 20, fill: '#7C8894', 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle' }, txt(meta.tank_labels[i])));
    const tempT = el('text', { x: cx, y: RY + 86, fill: '#0B1220', 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('--'));
    const spT = el('text', { x: cx, y: RY + 110, fill: SPG, 'font-size': 12, 'text-anchor': 'middle', 'font-family': MONO, ...HALO }, txt('SP --'));
    svg.appendChild(tempT); svg.appendChild(spT);
    flowPipe(svg, `M${i === 0 ? x : x + RW},${RY + 30} H${i === 0 ? x - 46 : x + RW + 46}`, '#cbd5e1');
    // comfort-band indicator (20-24 = the money band) beside each room
    const bar = compact ? null : analogBar(svg, i === 0 ? x - 26 : x + RW + 12, RY + 12, RH - 24,
      { min: 12, max: 32, zones: [[12, 20, 'warn'], [20, 24, 'norm'], [24, 32, 'warn']], ticks: [[20, '20'], [24, '24']] });
    const badge = compact ? null : tagBadge(svg, cx - 60, RY - 62, 120, meta.actuators.heaters[i], L('空调 · 模式与功率', 'AC unit · mode and power', '空調・モードと出力'));
    rooms.push({ fill, unit, tempT, spT, cx, bar, badge });
  }
  const couple = el('line', { x1: xs[0] + RW, y1: RY + RH / 2, x2: xs[1], y2: RY + RH / 2, stroke: '#C77700', 'stroke-width': 2, 'stroke-dasharray': '5 4' });
  svg.appendChild(couple);
  svg.appendChild(el('text', { x: (xs[0] + RW + xs[1]) / 2, y: RY + RH / 2 - 8, fill: '#C77700', 'font-size': 10, 'text-anchor': 'middle' }, txt(L('热耦合', 'Coupling', '熱結合'))));
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, act = f.actuators;
      const amb = s.t_amb;
      outdoorT.textContent = `${amb < 8 ? '❄ ' : amb > 26 ? '☀ ' : ''}${L('室外', 'Outdoor', '室外')} ${amb.toFixed(1)}°C`;
      for (let i = 0; i < 2; i++) {
        const r = rooms[i], T = s.temps[i], u = act.heaters[i];
        r.fill.setAttribute('fill', comfortColor(T));
        r.tempT.textContent = T.toFixed(1);
        r.tempT.setAttribute('fill', (T < 20 || T > 24) ? WARN : '#0B1220');
        r.spT.textContent = `SP ${f.setpoints.t_sp[i].toFixed(0)}°`;
        if (r.bar) r.bar.set(T, f.setpoints.t_sp[i]);
        const k = Math.abs(u - 0.5) * 2, kw = Math.abs((u - 0.5) * 2 * 1.8);
        if (u > 0.52) { r.unit.setAttribute('fill', `rgb(${Math.round(230 - k * 20)},${Math.round(150 - k * 90)},60)`); r.unit.setAttribute('filter', 'url(#glowHeat)'); }
        else if (u < 0.48) { r.unit.setAttribute('fill', `rgb(${Math.round(120 - k * 60)},${Math.round(180 - k * 20)},230)`); r.unit.setAttribute('filter', 'url(#glowPump)'); }
        else { r.unit.setAttribute('fill', '#eef1f4'); r.unit.setAttribute('filter', ''); }
        if (r.badge) {
          const mode = u > 0.52 ? L('制热', 'HEAT', '暖房') : u < 0.48 ? L('制冷', 'COOL', '冷房') : L('关', 'OFF', 'オフ');
          const off = T < 20 || T > 24;
          r.badge.set(`${mode} ${pct(k)} · ${kw.toFixed(2)} kW`, off ? 'warn' : null);
        }
      }
    },
  };
}
