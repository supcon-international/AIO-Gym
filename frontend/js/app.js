// App orchestrator: runs the simulation engine in-browser (no server) and wires
// its telemetry to the schematic, charts and panels, and the top-bar controls
// back to the engine. Rebuilds the whole UI when the scenario changes.
import { Engine, CATALOG } from './sim/engine.js?v=15';
import { buildSchematic } from './schematic.js?v=15';
import { buildCharts } from './charts.js?v=15';
import { buildControls } from './controls.js?v=15';
import { t, applyStatic, toggleLang, lang, onLang, nextLang } from './i18n.js?v=15';

const $ = (s) => document.querySelector(s);
let schematic, charts, controls, catalog, meta;
let scenario = null, mode = 'manual', running = true, lastFrame = null, pendingHistory = null;

// Local engine; `bus.send` forwards commands to it (keeps controls.js unchanged).
const engine = new Engine();
const bus = { send: (m) => engine.handleCommand(m) };

function setConn(ok) {
  const c = $('#conn'); if (!c) return;
  c.className = 'conn ' + (ok ? 'on' : 'off');
  c.textContent = ok ? t('● 本地引擎', '● Local engine', '● ローカルエンジン') : t('● 已停止', '● Stopped', '● 停止しました');
}

function init() {
  catalog = { disturbances: CATALOG, n_tanks: 3 };
  wireTopbar();
  applyStatic();            // reflect the saved language on the static topbar/panels
  setLangBtn();
  onLang(relayout);         // re-render everything when the language changes
  window.addEventListener('resize', () => charts && charts.resize());
  setConn(true);
  engine.start(onFrame);   // 20 Hz frames, identical shape to the old WS stream
}

// Language switch: static text is already swapped by i18n; rebuild the dynamic
// panels with a fresh (re-localized) telemetry frame.
function relayout() {
  setLangBtn();
  setRunBtn();                                  // run button text is language-dependent
  scenario = null;                              // force rebuildUI with fresh meta
  onFrame(engine.telemetry());
}

function rebuildUI(f) {
  meta = f.meta;
  if (charts) charts.destroy();
  schematic = buildSchematic($('#schematic-host'), meta);
  charts = buildCharts($('#charts-host'), meta.trends, meta.n_tanks);
  controls = buildControls(bus, meta, catalog);
  controls.renderDisturb($('#disturb-body'));
  controls.renderControl($('#control-body'), mode, f, $('#control-sub'));
  setTimeout(() => charts && charts.resize(), 60);
}

function onFrame(f) {
 try {
  if (f.type === 'history') { if (charts) charts.fromHistory(f.samples); else pendingHistory = f.samples; return; }
  if (f.type !== 'telemetry') return;
  setConn(true);
  lastFrame = f;
  if (f.scenario !== scenario) { mode = f.mode; rebuildUI(f); scenario = f.scenario; syncSegs(f); }

  schematic.update(f);
  charts.push(f);
  controls.syncManual(f);
  controls.syncConfig(f);
  controls.syncRL(f);
  controls.syncDisturb($('#disturb-body'), f.disturbances || {});
  notifyDisturb(f.disturbances || {});
  renderScore(f.score, f.episode);
  renderAlarms(f.alarms, f.interlocks);
  updateTopbar(f);
 } catch (e) { console.error('onFrame error:', e && e.stack || e); }
}

// ---------------- top bar ----------------
function wireTopbar() {
  // scenario switcher dropdown
  const scnSwitch = $('#scn-switch'), scnMenu = $('#scenario-seg');
  const closeScn = () => { scnMenu.hidden = true; scnSwitch.classList.remove('open'); };
  $('#scn-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = scnMenu.hidden; scnMenu.hidden = !open; scnSwitch.classList.toggle('open', open);
  });
  scnMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    bus.send({ type: 'set_scenario', scenario: b.dataset.scenario });
    closeScn();
  });
  document.addEventListener('click', (e) => { if (!scnSwitch.contains(e.target)) closeScn(); });
  $('#mode-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    mode = b.dataset.mode; bus.send({ type: 'set_mode', mode }); syncModeSeg(mode);
    controls.renderControl($('#control-body'), mode, lastFrame, $('#control-sub'));
  });
  $('#speed').addEventListener('input', (e) => { $('#speed-val').textContent = (+e.target.value).toFixed(1) + '×'; bus.send({ type: 'set_speed', speed: +e.target.value }); });
  $('#btn-run').addEventListener('click', () => { running = !running; bus.send({ type: 'set_running', running }); setRunBtn(); });
  $('#btn-reset').addEventListener('click', () => bus.send({ type: 'reset' }));
  $('#lang-btn').addEventListener('click', () => toggleLang());
  $('#fidelity-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    bus.send({ type: 'set_fidelity', level: +b.dataset.fid });
    $('#fidelity-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $('#auto-events').addEventListener('change', (e) => bus.send({ type: 'set_auto_events', on: e.target.checked }));
  setRunBtn();
}

const setRunBtn = () => { const b = $('#btn-run'); b.textContent = running ? t('暂停', 'Pause', '一時停止') : t('运行', 'Run', '実行'); b.classList.toggle('paused', !running); };
const setLangBtn = () => {
  const b = $('#lang-btn'); if (b) b.textContent = { zh: '中', en: 'EN', ja: '日本語' }[nextLang()];  // shows the lang you switch TO
  document.title = t('AIO-Gym · 过程控制环境', 'AIO-Gym · Process Control Gym', 'AIO-Gym · プロセス制御ジム');
};
const syncModeSeg = (m) => $('#mode-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
function syncSegs(f) {
  $('#scenario-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.scenario === f.scenario));
  syncModeSeg(f.mode);
}
function updateTopbar(f) {
  $('#clock').textContent = f.t.toFixed(1) + 's';
  if (f.mode !== mode) { mode = f.mode; syncModeSeg(mode); controls.renderControl($('#control-body'), mode, f, $('#control-sub')); }
  if (f.running !== running) { running = f.running; setRunBtn(); }
  const title = $('#scn-title'); if (title && f.meta) title.textContent = f.meta.name;
  const MK = { cascade: '▤', quadruple: '◫', cstr: '⊚', hvac: '⌂' };
  const mk = $('#scn-mark'); if (mk) mk.textContent = MK[f.scenario] || '▤';
  const p = $('#scn-path'); if (p) p.textContent = `process / ${f.scenario} · ${f.n_tanks}-unit`;
  const fseg = $('#fidelity-seg');
  if (fseg && f.fidelity != null) fseg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.fid === (f.fidelity > 0 ? 1 : 0)));
  const c = f.state.t_cold.toFixed(1), a = f.state.t_amb.toFixed(1);
  $('#env-readout').textContent = f.scenario === 'hvac'
    ? t(`室外 ${a}°C`, `Outdoor ${a}°C`, `屋外 ${a}°C`)
    : t(`进料 ${c}°C · 环境 ${a}°C`, `Feed ${c}°C · Amb ${a}°C`, `フィード ${c}°C · 環境 ${a}°C`);
  $('#score-mode').textContent = f.mode.toUpperCase();
}

// ---------------- score ----------------
function renderScore(sc, ep) {
  if (!sc) return;
  const k = sc.kpis, ec = sc.econ || {};
  const es = sc.econ_score ?? 0;
  const ecol = es >= 80 ? '#2E8B3D' : es >= 55 ? '#C77700' : '#C0392B';
  const tcol = sc.score >= 80 ? '#2E8B3D' : sc.score >= 55 ? '#C77700' : '#C0392B';
  // Economic score is the headline = the PER-EPISODE AVERAGE (one episode = 600 s sim,
  // ~1 min at 10x). Control KPI (loop regulation quality) is secondary. Economic
  // primitive is production (reactor) or power draw.
  const econKpi = ec.value === 'production'
    ? kpi(t('产量', 'Production', '生産量'), ec.production, 'mmol/s')
    : kpi(t('能耗功率', 'Power', '消費電力'), k.avg_power_kw, 'kW');
  ep = ep || { n: 1, elapsed: 0, length: 600, history: [] };
  const hist = ep.history || [];
  const last = hist[hist.length - 1];
  const recent = hist.slice(-5);
  const avg = recent.length ? Math.round(recent.reduce((a, b) => a + b.econ, 0) / recent.length) : null;
  // sparkline of recent episode economic scores
  const spark = hist.slice(-12).map((s) => {
    const c = s.econ >= 80 ? '#2E8B3D' : s.econ >= 55 ? '#C77700' : '#C0392B';
    return `<i title="${s.econ}" style="height:${Math.max(6, s.econ)}%;background:${c}"></i>`;
  }).join('');
  $('#score-body').innerHTML = `
    <div class="score-big"><span class="score-num" style="color:${ecol}">${es.toFixed(0)}</span><span class="score-unit">/ 100 ${t('经济得分', 'Economic', '経済スコア')}</span></div>
    <div class="score-bar"><i style="width:${es}%;background:${ecol}"></i></div>
    <div class="score-sub">${t('回合', 'Episode', 'エピソード')} #${ep.n} · ${ep.elapsed}/${ep.length}s${last ? ` · ${t('上回合', 'last', '前回')} <b>${last.econ}</b>` : ''}${avg != null ? ` · ${t('近' + recent.length + '回合均', 'avg' + recent.length, '直近' + recent.length + '回平均')} <b>${avg}</b>` : ''}</div>
    ${spark ? `<div class="ep-spark">${spark}</div>` : ''}
    <div class="score-sub">${t('收益率', 'Profit', '収益率')} <b>${ec.profit_rate ?? 0}</b>/${t('步', 'step', 'ステップ')} · ${t('控制 KPI', 'Control KPI', '制御 KPI')} <b style="color:${tcol}">${sc.score.toFixed(0)}</b>/100</div>
    <div class="kpi-grid">
      ${econKpi}${kpi(t('累计能耗', 'Energy', '累積エネルギー'), k.energy_kwh, 'kWh')}
      ${kpi(t('联锁时长', 'Interlock', 'インターロック時間'), k.interlock_seconds, 's')}${kpi(t('跳闸次数', 'Trips', 'トリップ回数'), k.trip_events, t('次', '×', '回'))}
    </div>
    <div class="hint" style="margin-top:9px">${t('每回合 = 600s 仿真(10×约 1 分钟);经济得分 = 本回合平均「价值−能耗」实现度。',
      'Each episode = 600 s sim (~1 min at 10x); economic score = the episode-average value−energy realization.',
      '1エピソード = 600s シミュレーション（10×で約1分）；経済スコア = 本エピソード平均の「価値−エネルギー」達成度。')}</div>`;
}
const kpi = (k, v, u) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small> ${u}</small></div></div>`;

// ---------------- disturbance toasts ----------------
// Pop a transient notification when a disturbance/fault fires, so it's legible.
let _prevDisturb = {};
const DTOAST = {
  cold_inlet: (p) => t(`冷进料温度 +${(+p.value).toFixed(1)}°C`, `Cold inlet +${(+p.value).toFixed(1)}°C`, `冷フィード温度 +${(+p.value).toFixed(1)}°C`),
  ambient: (p) => t(`环境温度 ${+p.value >= 0 ? '+' : ''}${(+p.value).toFixed(1)}°C`, `Ambient ${+p.value >= 0 ? '+' : ''}${(+p.value).toFixed(1)}°C`, `環境温度 ${+p.value >= 0 ? '+' : ''}${(+p.value).toFixed(1)}°C`),
  demand_surge: () => t('下游需求激增', 'Downstream demand surge', '下流需要の急増'),
  sensor_noise: () => t('传感器噪声注入', 'Sensor noise injected', 'センサーノイズ注入'),
  heater_fault: (p) => t(`加热器 ${(p.index | 0) + 1} 失效（卡关）`, `Heater ${(p.index | 0) + 1} dead (stuck off)`, `ヒーター ${(p.index | 0) + 1} 故障（オフ固着）`),
  valve_stuck: (p) => t(`阀 ${(p.index | 0) + 1} 卡死`, `Valve ${(p.index | 0) + 1} stuck`, `バルブ ${(p.index | 0) + 1} 固着`),
  pump_trip: () => t('泵跳闸 · 无进料', 'Pump trip · no inflow', 'ポンプトリップ · 進料なし'),
};
function notifyDisturb(dist) {
  for (const k in dist) {
    if (!(k in _prevDisturb)) {
      const fn = DTOAST[k];
      showToast(fn ? fn(dist[k].params || {}) : (dist[k].label || k), dist[k].kind === 'fault');
    }
  }
  _prevDisturb = { ...dist };
}
function showToast(msg, isFault) {
  const host = $('#toast-host'); if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (isFault ? ' fault' : '');
  const tag = isFault ? t('故障', 'Fault', '故障') : t('扰动', 'Disturbance', '外乱');
  el.innerHTML = `<span class="tdot"></span><span><b>${tag}</b> · ${msg}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 3600);
}

// ---------------- alarms ----------------
// Alarms carry a stable type + tank + value (the raw `message` stays English for
// logging); the UI renders a localized string from those fields.
function alarmText(a) {
  const u = a.tank >= 0 ? a.tank + 1 : '';
  switch (a.type) {
    case 'level_high': return t(`T-${u} 液位偏高 (${a.value.toFixed(2)} m)`, `Tank ${u} level HIGH (${a.value.toFixed(2)} m)`, `T-${u} 液位高め (${a.value.toFixed(2)} m)`);
    case 'level_low': return t(`T-${u} 液位偏低 (${a.value.toFixed(2)} m)`, `Tank ${u} level LOW (${a.value.toFixed(2)} m)`, `T-${u} 液位低め (${a.value.toFixed(2)} m)`);
    case 'temp_high': return t(`机组 ${u} 温度偏高 (${a.value.toFixed(1)} °C)`, `Unit ${u} temperature HIGH (${a.value.toFixed(1)} °C)`, `ユニット ${u} 温度高め (${a.value.toFixed(1)} °C)`);
    case 'heater_interlock': return t(`机组 ${u} 加热器联锁跳闸`, `Unit ${u} heater TRIPPED`, `ユニット ${u} ヒーターがトリップ`);
    case 'pump_interlock': return t('泵联锁跳闸(溢流保护)', 'Pump TRIPPED (overflow protection)', 'ポンプがトリップ（オーバーフロー保護）');
    case 'overtemp_interlock': return t('进料联锁跳闸(超温/失控保护)', 'Feed TRIPPED (over-temp / runaway protection)', 'フィードがトリップ（過温/暴走保護）');
    default: return a.message;
  }
}
function renderAlarms(alarms, interlocks) {
  alarms = alarms || [];
  const body = $('#alarm-body'), crit = alarms.filter((a) => a.severity === 'critical').length;
  const badge = $('#alarm-count');
  badge.textContent = alarms.length;
  badge.className = 'badge ' + (crit ? 'crit' : alarms.length ? 'warn' : '');
  if (!alarms.length) { body.innerHTML = `<div class="no-alarm">${t('— 无报警 · 系统正常 —', '— No alarms · all normal —', '— アラームなし · システム正常 —')}</div>`; return; }
  alarms.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  body.innerHTML = alarms.map((a) => `<div class="alarm ${a.severity}"><span class="dot"></span><span>${alarmText(a)}</span></div>`).join('');
}

init();
