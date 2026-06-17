// Animated P&ID schematic. Dispatches on topology metadata: a unidirectional
// cascade, or the Johansson quadruple-tank (2 lower + 2 upper, crossed pump
// feeds). Both bind tank water height/colour, heater glow, pump and pipe-flow
// animation to live telemetry.
import { t as L } from './i18n.js?v=3';   // aliased: `t` is used locally for tank refs

const SVG = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && n.appendChild(c));
  return n;
}
const txt = (s) => document.createTextNode(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
  // flow-direction arrowhead; inherits each pipe's stroke colour via context-stroke
  const m = el('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5.5, markerHeight: 5.5, orient: 'auto' });
  m.appendChild(el('path', { d: 'M0.5,0.5 L8,4 L0.5,7.5 Z', fill: 'context-stroke' }));
  defs.appendChild(m);
  return defs;
}
// Reusable tank cell: water + heater coil + glass + readouts. Returns refs.
const HALO = { stroke: '#ffffff', 'stroke-width': 3.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round' };
function tankCell(g, x, y, w, h, label) {
  const innerH = h - 16, bottomY = y + h - 8;
  const water = el('rect', { x: x + 4, y: bottomY, width: w - 8, height: 0, fill: '#9CC2F0', rx: 2, opacity: 0.62 });
  const cap = el('rect', { x: x + 4, y: bottomY, width: w - 8, height: 2.5, fill: '#050B14', opacity: 0.12 });
  const coil = el('path', { d: coilPath(x + 14, bottomY - 12, w - 28), stroke: '#C3C7CC', 'stroke-width': 3.2, fill: 'none', 'stroke-linecap': 'round' });
  const glass = el('rect', { x, y, width: w, height: h, rx: 6, fill: 'none', stroke: '#5A626C', 'stroke-width': 1.6 });
  const spLine = el('line', { x1: x, y1: bottomY, x2: x + w, y2: bottomY, stroke: '#73B200', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0 });
  const tempT = el('text', { x: x + w / 2, y: y + h / 2 - 2, fill: '#0B1220', 'font-size': 21, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('--'));
  const tspT = el('text', { x: x + w / 2, y: y + h / 2 + 16, fill: '#3F6B00', 'font-size': 10, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt(''));
  const lvlT = el('text', { x: x + w / 2, y: bottomY - 6, fill: '#0B1220', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('--'));
  const title = el('text', { x: x + w / 2, y: y - 7, fill: '#585C62', 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle' }, txt(label));
  [water, cap, coil, glass, spLine, tempT, tspT, lvlT, title].forEach((e) => g.appendChild(e));
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
  t.tempT.setAttribute('fill', temp >= (tHigh || 80) ? '#C0392B' : '#0B1220');
  t.lvlT.textContent = `${level.toFixed(2)} m`;
}
function paintHeater(coil, frac, tripped) {
  if (tripped) { coil.setAttribute('stroke', '#C0392B'); coil.setAttribute('filter', ''); coil.setAttribute('opacity', 0.95); coil.setAttribute('stroke-width', 3.6); }
  else if (frac > 0.01) {
    coil.setAttribute('stroke', `rgb(${Math.round(225 - frac * 30)},${Math.round(140 - frac * 95)},20)`);
    coil.setAttribute('filter', 'url(#glowHeat)');
    coil.setAttribute('opacity', 0.65 + frac * 0.35);
    coil.setAttribute('stroke-width', 3.2 + frac * 1.8);
  } else { coil.setAttribute('stroke', '#C3C7CC'); coil.setAttribute('filter', ''); coil.setAttribute('opacity', 1); coil.setAttribute('stroke-width', 3.2); }
}
function pumpSymbol(svg, x, y, label) {
  const c = el('circle', { cx: x, cy: y, r: 15, fill: '#fff', stroke: '#B0B4B9', 'stroke-width': 1.8 });
  svg.appendChild(c);
  svg.appendChild(el('path', { d: `M${x - 6},${y - 7} L${x + 8},${y} L${x - 6},${y + 7} Z`, fill: '#73B200' }));
  svg.appendChild(el('text', { x, y: y + 28, fill: '#585C62', 'font-size': 10, 'text-anchor': 'middle' }, txt(label)));
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

export function buildSchematic(host, meta) {
  const f = { quadruple: buildQuadruple, cstr: buildCSTR, hvac: buildHVAC }[meta.topology];
  return f ? f(host, meta) : buildCascade(host, meta);
}

// ---------------- Cascade ----------------
function buildCascade(host, meta) {
  host.innerHTML = '';
  const n = meta.n_tanks, TW = 134, TH = 196, TY = 78, GAP = 226, X0 = 176;
  const tankX = (i) => X0 + i * GAP;
  const W = X0 + (n - 1) * GAP + TW + 168, H = 350;   // right margin fits the drain label
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const bottomY = TY + TH - 8, innerY = TY + 8;
  const refs = { tanks: [], pipes: [] };

  const pumpX = 92, pumpY = bottomY - 24;
  svg.appendChild(el('text', { x: 18, y: pumpY - 28, fill: '#585C62', 'font-size': 12 }, txt(L('冷水进料', 'Cold feed'))));
  refs.coldT = el('text', { x: 18, y: pumpY - 13, fill: '#2563EB', 'font-size': 13, 'font-family': 'IBM Plex Mono, monospace' }, txt('15°C'));
  svg.appendChild(refs.coldT);
  refs.feedFlow = flowPipe(svg, `M${pumpX + 16},${pumpY} H${tankX(0) - 26} V${innerY + 6} H${tankX(0) + 10}`);
  refs.pumpC = pumpSymbol(svg, pumpX, pumpY, meta.actuators.pumps[0] || 'P-01');

  for (let i = 0; i < n; i++) {
    const x = tankX(i), g = el('g');
    svg.appendChild(g);
    const t = tankCell(g, x, TY, TW, TH, meta.tank_labels[i]);
    refs.tanks.push(t);
    // outlet pipe + valve
    const lowY = bottomY - 10, vx = x + TW + (GAP - TW) / 2;
    let d;
    if (i < n - 1) d = `M${x + TW},${lowY} H${vx} V${innerY + 6} H${tankX(i + 1) + 6}`;
    else { const dy = bottomY + 44; d = `M${x + TW},${lowY} H${vx} V${dy} H${vx + 60}`; svg.appendChild(el('text', { x: vx + 68, y: dy + 4, fill: '#585C62', 'font-size': 11 }, txt(L('排放', 'Drain')))); }
    refs.pipes.push(flowPipe(svg, d));
    const valG = el('g', { transform: `translate(${vx},${lowY})` });
    const bow = el('path', { d: 'M-10,-8 L0,0 L-10,8 Z M10,-8 L0,0 L10,8 Z', fill: '#CDCED0', stroke: '#B0B4B9', 'stroke-width': 1 });
    valG.appendChild(bow); svg.appendChild(valG);
    svg.appendChild(el('text', { x: vx, y: lowY + 24, fill: '#585C62', 'font-size': 10, 'text-anchor': 'middle' }, txt(`V-${i + 1}`)));
    t.valveBow = bow;
  }
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, sp = f.setpoints, act = f.actuators, lim = f.limits || {};
      const il = f.interlocks || { heater_trip: [], pump_trip: false };
      const hmax = lim.height_max || Array(n).fill(0.8);
      const pumpOn = s.pump_flow[0] > 1e-7 && !il.pump_trip;
      refs.pumpC.setAttribute('stroke', pumpOn ? '#73B200' : '#B0B4B9');
      refs.pumpC.setAttribute('filter', pumpOn ? 'url(#glowPump)' : '');
      setFlow(refs.feedFlow, s.pump_flow[0], (lim.height_max ? 0.0016 : 0.0016));
      refs.coldT.textContent = `${s.t_cold.toFixed(1)}°C`;
      for (let i = 0; i < n; i++) {
        const t = refs.tanks[i];
        paintTank(t, s.levels[i], s.temps[i], hmax[i], lim.t_high);
        t.tspT.textContent = `SP ${sp.t_sp[i].toFixed(0)}°`;
        const yOf = (h) => t.bottomY - clamp(h / hmax[i], 0, 1) * t.innerH;
        t.spLine.setAttribute('opacity', 0.85); t.spLine.setAttribute('y1', yOf(sp.h_sp[i])); t.spLine.setAttribute('y2', yOf(sp.h_sp[i]));
        paintHeater(t.coil, act.heaters[i], il.heater_trip[i]);
        const v = act.valves[i];
        t.valveBow.setAttribute('fill', v > 0.02 ? `rgb(56,${120 + Math.round(v * 80)},${180 + Math.round(v * 40)})` : '#CDCED0');
        setFlow(refs.pipes[i], s.tank_outflow[i], 0.0024);
      }
    },
  };
}

// ---------------- Quadruple tank (Johansson) ----------------
// Colour-coded so the cross-coupling is legible: pump-1 circuit (→ lower-1 +
// upper-4) in blue, pump-2 circuit (→ lower-2 + upper-3) in violet, gravity
// drains in teal. Each pump's three-way split (gamma) is drawn as a diamond
// valve, and every pipe carries a flow-direction arrowhead.
const C1 = '#2563EB', C2 = '#7C3AED', CG = '#14B8A6';
function buildQuadruple(host, meta) {
  host.innerHTML = '';
  const TW = 152, TH = 104, W = 760, H = 492;
  // two stacked columns: upper tank above its lower tank (so "drains down" is obvious)
  const colL = 150, colR = 458, yUp = 50, yLo = 242;   // tank top-left
  const cL = colL + TW / 2, cR = colR + TW / 2;          // column centre  (226 / 534)
  const upBot = yUp + TH, loBot = yLo + TH;              // 154 / 346
  const Sy = 396, Py = 418, P1x = 346, P2x = 414;        // split / pump (centre-bottom)
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const refs = { tanks: [], pumps: [], pipes: {} };

  // reading guide
  svg.appendChild(el('text', { x: W / 2, y: 16, fill: '#585C62', 'font-size': 10.5, 'text-anchor': 'middle' },
    txt(L('泵按 γ 分流：直连本侧下罐，斜穿到对侧上罐 → 交叉耦合', 'Each pump splits by γ: straight to the near lower tank, crossed to the far upper tank → cross-coupling'))));

  // --- pipes (behind tanks) ---
  // pump risers
  refs.pipes.r1 = flowPipe(svg, `M${P1x},${Py - 13} V${Sy}`, C1);
  refs.pipes.r2 = flowPipe(svg, `M${P2x},${Py - 13} V${Sy}`, C2);
  // direct (gamma) -> inner side of the SAME-side lower tank
  refs.pipes.p1d = flowPipe(svg, `M${P1x},${Sy} V312 H${colL + TW}`, C1);
  refs.pipes.p2d = flowPipe(svg, `M${P2x},${Sy} V312 H${colR}`, C2);
  // cross (1-gamma) -> OPPOSITE-side upper tank: two diagonals forming the X
  refs.pipes.p1c = flowPipe(svg, `M${P1x},${Sy} L${colR},116`, C1);
  refs.pipes.p2c = flowPipe(svg, `M${P2x},${Sy} L${colL + TW},116`, C2);
  // gravity: upper -> lower (between stacked tanks) and lower -> drain out
  refs.pipes.d31 = flowPipe(svg, `M${cL},${upBot} V${yLo}`, CG);
  refs.pipes.d42 = flowPipe(svg, `M${cR},${upBot} V${yLo}`, CG);
  refs.pipes.o1 = flowPipe(svg, `M${cL},${loBot} V${loBot + 24} H${colL - 44}`, CG);
  refs.pipes.o2 = flowPipe(svg, `M${cR},${loBot} V${loBot + 24} H${colR + TW + 44}`, CG);

  // branch split labels (gamma on direct, 1-gamma on cross)
  const tag = (x, y, color, s) => svg.appendChild(el('text', { x, y, fill: color, 'font-size': 10, 'font-weight': 600, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace' }, txt(s)));
  tag(P1x - 22, 300, C1, 'γ₁'); tag(P2x + 22, 300, C2, 'γ₂');
  tag(colR - 36, 210, C1, '1−γ₁'); tag(colL + TW + 36, 210, C2, '1−γ₂');

  // --- tanks ---
  const pos = [[colL, yLo], [colR, yLo], [colL, yUp], [colR, yUp]];   // T1,T2 lower · T3,T4 upper
  for (let i = 0; i < 4; i++) {
    const g = el('g'); svg.appendChild(g);
    refs.tanks.push(tankCell(g, pos[i][0], pos[i][1], TW, TH, meta.tank_labels[i]));
  }
  [cL, cR].forEach((cx) => svg.appendChild(el('text', { x: cx, y: yUp - 22, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('预热 · 进料', 'Preheat / feed')))));
  [cL, cR].forEach((cx) => svg.appendChild(el('text', { x: cx, y: loBot + 16, fill: '#585C62', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('受控液位', 'Controlled level')))));
  svg.appendChild(el('text', { x: colL - 50, y: loBot + 20, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('出料', 'Out'))));
  svg.appendChild(el('text', { x: colR + TW + 50, y: loBot + 20, fill: '#8A9099', 'font-size': 9.5, 'text-anchor': 'middle' }, txt(L('出料', 'Out'))));

  // --- pumps + split valves ---
  const splitValve = (x, color) => svg.appendChild(el('path', { d: `M${x},${Sy - 6} L${x + 6},${Sy} L${x},${Sy + 6} L${x - 6},${Sy} Z`, fill: color, stroke: '#fff', 'stroke-width': 1.2 }));
  refs.pumps.push(pumpSymbol(svg, P1x, Py, meta.actuators.pumps[0]));
  refs.pumps.push(pumpSymbol(svg, P2x, Py, meta.actuators.pumps[1]));
  splitValve(P1x, C1); splitValve(P2x, C2);

  // --- legend + phase ---
  const legend = (x, color, label) => {
    svg.appendChild(el('rect', { x, y: H - 30, width: 11, height: 11, rx: 2, fill: color }));
    svg.appendChild(el('text', { x: x + 16, y: H - 21, fill: '#585C62', 'font-size': 10 }, txt(label)));
  };
  legend(150, C1, L('泵1 回路', 'Pump-1')); legend(250, C2, L('泵2 回路', 'Pump-2')); legend(350, CG, L('重力 / 出料', 'Gravity / out'));
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
      }
      const Q1 = s.pump_flow[0], Q2 = s.pump_flow[1];
      const g1 = cfg.gamma1 != null ? cfg.gamma1 : 0.7, g2 = cfg.gamma2 != null ? cfg.gamma2 : 0.7;
      [refs.pumps[0], refs.pumps[1]].forEach((c, k) => {
        const on = (k ? Q2 : Q1) > 1e-7 && !il.pump_trip;
        c.setAttribute('stroke', on ? '#73B200' : '#B0B4B9');
        c.setAttribute('filter', on ? 'url(#glowPump)' : '');
      });
      setFlow(refs.pipes.r1, Q1, Qmax); setFlow(refs.pipes.r2, Q2, Qmax);
      setFlow(refs.pipes.p1d, g1 * Q1, Qmax); setFlow(refs.pipes.p1c, (1 - g1) * Q1, Qmax);
      setFlow(refs.pipes.p2d, g2 * Q2, Qmax); setFlow(refs.pipes.p2c, (1 - g2) * Q2, Qmax);
      setFlow(refs.pipes.d31, s.tank_outflow[2], Qmax); setFlow(refs.pipes.d42, s.tank_outflow[3], Qmax);
      setFlow(refs.pipes.o1, s.tank_outflow[0], Qmax); setFlow(refs.pipes.o2, s.tank_outflow[1], Qmax);
      refs.phase.textContent = cfg.phase
        ? `γ₁=${g1.toFixed(2)}  γ₂=${g2.toFixed(2)}  ·  ${L('传输零点', 'Zero')}: ${cfg.phase}`
        : '';
    },
  };
}

// ---------------- CSTR (exothermic reactor + cooling jacket) ----------------
function buildCSTR(host, meta) {
  host.innerHTML = '';
  const W = 720, H = 400;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  svg.appendChild(el('text', { x: W / 2, y: 18, fill: '#585C62', 'font-size': 10.5, 'text-anchor': 'middle' },
    txt(L('放热反应靠冷却控温;冷却不足 → Arrhenius 正反馈 → 热失控', 'Exothermic reaction held by cooling; too little → Arrhenius runaway'))));

  const rx = 280, ry = 86, rw = 180, rh = 214, cx = rx + rw / 2, rbot = ry + rh;
  // feed (top) + product (bottom) pipes
  const feed = flowPipe(svg, `M120,150 V${ry - 14} H${cx} V${ry}`, '#2563EB');
  const prod = flowPipe(svg, `M${cx},${rbot} V${rbot + 26} H${rx + rw + 70}`, '#5B8DEF');
  svg.appendChild(el('text', { x: 120, y: 138, fill: '#585C62', 'font-size': 11, 'text-anchor': 'middle' }, txt(L('进料', 'Feed'))));
  const feedPump = pumpSymbol(svg, 120, 150, meta.actuators.pumps[0]);
  svg.appendChild(el('text', { x: rx + rw + 78, y: rbot + 30, fill: '#585C62', 'font-size': 11 }, txt(L('产品', 'Product'))));
  // cooling jacket (outer shell, glows when cooling) + coolant arrows
  const jacket = el('rect', { x: rx - 12, y: ry - 8, width: rw + 24, height: rh + 16, rx: 14, fill: 'none', stroke: '#9AD3DA', 'stroke-width': 6 });
  svg.appendChild(jacket);
  const coolIn = flowPipe(svg, `M${rx - 70},${ry + 30} H${rx - 12}`, '#0EA5C0');
  const coolOut = flowPipe(svg, `M${rx - 12},${rbot - 30} H${rx - 70}`, '#0EA5C0');
  svg.appendChild(el('text', { x: rx - 78, y: ry + 22, fill: '#0E8aa0', 'font-size': 10 }, txt(L('冷却水', 'Coolant'))));
  // reactor liquid (full, temperature-coloured) + glass
  const liquid = el('rect', { x: rx + 3, y: ry + 3, width: rw - 6, height: rh - 6, rx: 8, fill: '#9CC2F0', opacity: 0.62 });
  svg.appendChild(liquid);
  svg.appendChild(el('rect', { x: rx, y: ry, width: rw, height: rh, rx: 10, fill: 'none', stroke: '#5A626C', 'stroke-width': 1.8 }));
  // stirrer
  svg.appendChild(el('line', { x1: cx, y1: ry - 4, x2: cx, y2: ry + rh * 0.55, stroke: '#5A626C', 'stroke-width': 2 }));
  svg.appendChild(el('line', { x1: cx - 22, y1: ry + rh * 0.55, x2: cx + 22, y2: ry + rh * 0.55, stroke: '#5A626C', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  svg.appendChild(el('text', { x: cx, y: ry - 14, fill: '#9fb0c2', 'font-size': 12, 'font-weight': 600, 'text-anchor': 'middle' }, txt(meta.tank_labels[0])));
  const tempT = el('text', { x: cx, y: ry + 92, fill: '#0B1220', 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('--'));
  const caT = el('text', { x: cx, y: ry + 122, fill: '#3F6B00', 'font-size': 14, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('Cₐ --'));
  const spT = el('text', { x: cx, y: ry + 142, fill: '#73B200', 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('SP --'));
  svg.appendChild(tempT); svg.appendChild(caT); svg.appendChild(spT);
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, act = f.actuators, il = f.interlocks || {}, lim = f.limits || {};
      const T = s.temps[0], Ca = (s.conc || [0])[0], uc = act.heaters[0];
      liquid.setAttribute('fill', tempColor(T));
      tempT.textContent = T.toFixed(1); tempT.setAttribute('fill', T >= (lim.t_high || 80) ? '#C0392B' : '#0B1220');
      caT.textContent = `Cₐ ${Ca.toFixed(3)}`;
      spT.textContent = `SP ${f.setpoints.t_sp[0].toFixed(0)}°`;
      // jacket cooling glow (blue)
      if (uc > 0.02) { jacket.setAttribute('stroke', `rgb(${Math.round(150 - uc * 130)},${Math.round(200 - uc * 40)},220)`); jacket.setAttribute('filter', 'url(#glowPump)'); jacket.setAttribute('stroke-width', 6 + uc * 3); }
      else { jacket.setAttribute('stroke', '#cdd6da'); jacket.setAttribute('filter', ''); jacket.setAttribute('stroke-width', 6); }
      const feedOn = s.pump_flow[0] > 1e-9 && !il.pump_trip;
      feedPump.setAttribute('stroke', feedOn ? '#2dd4bf' : '#B0B4B9'); feedPump.setAttribute('filter', feedOn ? 'url(#glowPump)' : '');
      setFlow(feed, s.pump_flow[0], 0.02); setFlow(prod, s.pump_flow[0], 0.02);
      setFlow(coolIn, uc * 0.02, 0.02); setFlow(coolOut, uc * 0.02, 0.02);
    },
  };
}

// ---------------- Two-zone HVAC ----------------
function buildHVAC(host, meta) {
  host.innerHTML = '';
  const W = 720, H = 380;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(defsBlock());
  const outdoorT = el('text', { x: W / 2, y: 24, fill: '#585C62', 'font-size': 12, 'text-anchor': 'middle' }, txt(L('室外', 'Outdoor') + ' --'));
  svg.appendChild(outdoorT);
  const rooms = [];
  const RW = 220, RH = 180, RY = 110, xs = [110, 110 + RW + 60];
  for (let i = 0; i < 2; i++) {
    const x = xs[i], cx = x + RW / 2;
    const fill = el('rect', { x: x + 3, y: RY + 3, width: RW - 6, height: RH - 6, rx: 8, fill: '#9CC2F0', opacity: 0.55 });
    svg.appendChild(fill);
    svg.appendChild(el('rect', { x, y: RY, width: RW, height: RH, rx: 10, fill: 'none', stroke: '#5A626C', 'stroke-width': 1.8 }));
    // HVAC unit on top
    const unit = el('rect', { x: cx - 34, y: RY - 26, width: 68, height: 22, rx: 4, fill: '#eef1f4', stroke: '#B0B4B9', 'stroke-width': 1.4 });
    svg.appendChild(unit);
    svg.appendChild(el('text', { x: cx, y: RY - 30, fill: '#9fb0c2', 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle' }, txt(meta.actuators.heaters[i])));
    svg.appendChild(el('text', { x: cx, y: RY - 8, fill: '#9fb0c2', 'font-size': 11, 'text-anchor': 'middle' }, txt(meta.tank_labels[i])));
    const tempT = el('text', { x: cx, y: RY + 86, fill: '#0B1220', 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('--'));
    const spT = el('text', { x: cx, y: RY + 110, fill: '#73B200', 'font-size': 12, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', ...HALO }, txt('SP --'));
    svg.appendChild(tempT); svg.appendChild(spT);
    // heat-loss arrow to outdoor
    flowPipe(svg, `M${i === 0 ? x : x + RW},${RY + 30} H${i === 0 ? x - 46 : x + RW + 46}`, '#cbd5e1');
    rooms.push({ fill, unit, tempT, spT, cx });
  }
  // inter-zone coupling
  const couple = el('line', { x1: xs[0] + RW, y1: RY + RH / 2, x2: xs[1], y2: RY + RH / 2, stroke: '#C77700', 'stroke-width': 2, 'stroke-dasharray': '5 4' });
  svg.appendChild(couple);
  svg.appendChild(el('text', { x: (xs[0] + RW + xs[1]) / 2, y: RY + RH / 2 - 8, fill: '#C77700', 'font-size': 10, 'text-anchor': 'middle' }, txt(L('热耦合', 'Coupling'))));
  host.appendChild(svg);

  return {
    update(f) {
      const s = f.state, act = f.actuators;
      outdoorT.textContent = `${L('室外', 'Outdoor')} ${s.t_amb.toFixed(1)}°C`;
      for (let i = 0; i < 2; i++) {
        const r = rooms[i], T = s.temps[i], u = act.heaters[i];
        r.fill.setAttribute('fill', tempColor(T));
        r.tempT.textContent = T.toFixed(1);
        r.spT.textContent = `SP ${f.setpoints.t_sp[i].toFixed(0)}°`;
        if (u > 0.52) { const k = (u - 0.5) * 2; r.unit.setAttribute('fill', `rgb(${Math.round(230 - k * 20)},${Math.round(150 - k * 90)},60)`); r.unit.setAttribute('filter', 'url(#glowHeat)'); }
        else if (u < 0.48) { const k = (0.5 - u) * 2; r.unit.setAttribute('fill', `rgb(${Math.round(120 - k * 60)},${Math.round(180 - k * 20)},230)`); r.unit.setAttribute('filter', 'url(#glowPump)'); }
        else { r.unit.setAttribute('fill', '#eef1f4'); r.unit.setAttribute('filter', ''); }
      }
    },
  };
}
