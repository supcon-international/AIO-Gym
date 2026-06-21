// App orchestrator: runs the simulation engine in-browser (no server) and wires
// its telemetry to the schematic, charts and panels, and the top-bar controls
// back to the engine. Rebuilds the whole UI when the scenario changes.
import { Engine, CATALOG } from './sim/engine.js?v=5';
import { buildSchematic } from './schematic.js?v=5';
import { buildCharts } from './charts.js?v=5';
import { buildControls } from './controls.js?v=5';
import { MqttBridge } from './mqtt.js?v=5';
import { t, applyStatic, toggleLang, lang, onLang } from './i18n.js?v=5';

const $ = (s) => document.querySelector(s);
let schematic, charts, controls, catalog, meta;
let scenario = null, mode = 'manual', running = true, lastFrame = null, pendingHistory = null;

// Local engine; `bus.send` forwards commands to it (keeps controls.js unchanged).
const engine = new Engine();
const bus = { send: (m) => engine.handleCommand(m) };
const mqtt = new MqttBridge(engine);

function setConn(ok) {
  const c = $('#conn'); if (!c) return;
  c.className = 'conn ' + (ok ? 'on' : 'off');
  c.textContent = ok ? t('● 本地引擎', '● Local engine') : t('● 已停止', '● Stopped');
}

function init() {
  catalog = { disturbances: CATALOG, n_tanks: 3 };
  wireTopbar();
  renderMqtt();
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
  renderMqtt();
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
  renderScore(f.score);
  renderAlarms(f.alarms, f.interlocks);
  updateTopbar(f);
  mqtt.publish(f);
  syncMqtt();
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

// ---------------- MQTT / UNS panel ----------------
function renderMqtt() {
  const host = $('#mqtt-body'); if (!host) return;
  host.innerHTML = `
    <div class="mqtt-row"><input id="mqtt-url" type="text" value="wss://broker.emqx.io:8084/mqtt" placeholder="ws(s)://broker:port/mqtt"></div>
    <div class="mqtt-row"><input id="mqtt-line" type="text" value="env-1" placeholder="line id"><button id="mqtt-btn" class="btn-secondary mqtt-go"></button></div>
    <div class="mqtt-base mono" id="mqtt-base"></div>
    <div class="hint">${t('外部 agent 经 MQTT 读 <code>obs</code>/<code>reward</code>、写 <code>action</code> 即接管控制。', 'External agents read <code>obs</code>/<code>reward</code> and write <code>action</code> over MQTT to take control.')}</div>`;
  $('#mqtt-btn').addEventListener('click', async () => {
    if (mqtt.connected) { mqtt.disconnect(); }
    else { $('#mqtt-btn').textContent = t('连接中…', 'Connecting…'); await mqtt.connect($('#mqtt-url').value.trim(), $('#mqtt-line').value); }
    syncMqtt();
  });
  syncMqtt();
}
function syncMqtt() {
  const st = mqtt.getStatus();
  const tag = $('#mqtt-status'); if (tag) { tag.textContent = st.connected ? t('已连接', 'Connected') : t('未连接', 'Offline'); tag.className = 'tag' + (st.connected ? ' on' : ''); }
  const b = $('#mqtt-base'); if (b) b.textContent = st.base;
  const btn = $('#mqtt-btn'); if (btn) btn.textContent = st.connected ? t('断开', 'Disconnect') : t('连接', 'Connect');
}
const setRunBtn = () => { const b = $('#btn-run'); b.textContent = running ? t('暂停', 'Pause') : t('运行', 'Run'); b.classList.toggle('paused', !running); };
const setLangBtn = () => {
  const b = $('#lang-btn'); if (b) b.textContent = lang() === 'en' ? '中' : 'EN';
  document.title = t('AIO-Gym · 过程控制环境', 'AIO-Gym · Process Control Gym');
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
    ? t(`室外 ${a}°C`, `Outdoor ${a}°C`)
    : t(`进料 ${c}°C · 环境 ${a}°C`, `Feed ${c}°C · Amb ${a}°C`);
  $('#score-mode').textContent = f.mode.toUpperCase();
}

// ---------------- score ----------------
function renderScore(sc) {
  if (!sc) return;
  const k = sc.kpis, comp = sc.components;
  const col = sc.score >= 80 ? '#2E8B3D' : sc.score >= 55 ? '#C77700' : '#C0392B';
  $('#score-body').innerHTML = `
    <div class="score-big"><span class="score-num" style="color:${col}">${sc.score.toFixed(0)}</span><span class="score-unit">/ 100</span></div>
    <div class="score-bar"><i style="width:${sc.score}%;background:${col}"></i></div>
    <div class="kpi-grid">
      ${kpi(t('温度误差', 'Temp err'), k.avg_temp_err, t('°C 均', '°C avg'))}${kpi(t('液位误差', 'Level err'), k.avg_level_err_cm, t('cm 均', 'cm avg'))}
      ${kpi(t('累计能耗', 'Energy'), k.energy_kwh, 'kWh')}${kpi(t('超额能耗', 'Excess'), k.excess_kwh, 'kWh')}
      ${kpi(t('联锁时长', 'Interlock'), k.interlock_seconds, 's')}${kpi(t('跳闸次数', 'Trips'), k.trip_events, t('次', '×'))}
    </div>
    <div class="pen-title">${t('扣分项', 'Penalties')}</div>
    ${pen(t('温度跟踪', 'Temp tracking'), comp.tracking_temp)}${pen(t('液位跟踪', 'Level tracking'), comp.tracking_level)}${pen(t('能耗', 'Energy'), comp.energy)}${pen(t('安全', 'Safety'), comp.safety)}`;
}
const kpi = (k, v, u) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small> ${u}</small></div></div>`;
const pen = (k, v) => `<div class="pen-row"><span>${k}</span><span>-${v}</span></div>`;

// ---------------- alarms ----------------
// Alarms carry a stable type + tank + value (the raw `message` stays English for
// MQTT/logging); the UI renders a localized string from those fields.
function alarmText(a) {
  const u = a.tank >= 0 ? a.tank + 1 : '';
  switch (a.type) {
    case 'level_high': return t(`T-${u} 液位偏高 (${a.value.toFixed(2)} m)`, `Tank ${u} level HIGH (${a.value.toFixed(2)} m)`);
    case 'level_low': return t(`T-${u} 液位偏低 (${a.value.toFixed(2)} m)`, `Tank ${u} level LOW (${a.value.toFixed(2)} m)`);
    case 'temp_high': return t(`机组 ${u} 温度偏高 (${a.value.toFixed(1)} °C)`, `Unit ${u} temperature HIGH (${a.value.toFixed(1)} °C)`);
    case 'heater_interlock': return t(`机组 ${u} 加热器联锁跳闸`, `Unit ${u} heater TRIPPED`);
    case 'pump_interlock': return t('泵联锁跳闸(溢流保护)', 'Pump TRIPPED (overflow protection)');
    case 'overtemp_interlock': return t('进料联锁跳闸(超温/失控保护)', 'Feed TRIPPED (over-temp / runaway protection)');
    default: return a.message;
  }
}
function renderAlarms(alarms, interlocks) {
  alarms = alarms || [];
  const body = $('#alarm-body'), crit = alarms.filter((a) => a.severity === 'critical').length;
  const badge = $('#alarm-count');
  badge.textContent = alarms.length;
  badge.className = 'badge ' + (crit ? 'crit' : alarms.length ? 'warn' : '');
  if (!alarms.length) { body.innerHTML = `<div class="no-alarm">${t('— 无报警 · 系统正常 —', '— No alarms · all normal —')}</div>`; return; }
  alarms.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  body.innerHTML = alarms.map((a) => `<div class="alarm ${a.severity}"><span class="dot"></span><span>${alarmText(a)}</span></div>`).join('');
}

init();
