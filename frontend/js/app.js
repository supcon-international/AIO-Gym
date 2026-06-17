// App orchestrator: runs the simulation engine in-browser (no server) and wires
// its telemetry to the schematic, charts and panels, and the top-bar controls
// back to the engine. Rebuilds the whole UI when the scenario changes.
import { Engine, CATALOG } from './sim/engine.js?v=1';
import { buildSchematic } from './schematic.js?v=1';
import { buildCharts } from './charts.js?v=1';
import { buildControls } from './controls.js?v=1';
import { MqttBridge } from './mqtt.js?v=1';

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
  c.textContent = ok ? '● 本地引擎' : '● 已停止';
}

function init() {
  catalog = { disturbances: CATALOG, n_tanks: 3 };
  wireTopbar();
  renderMqtt();
  window.addEventListener('resize', () => charts && charts.resize());
  setConn(true);
  engine.start(onFrame);   // 20 Hz frames, identical shape to the old WS stream
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
  $('#auto-events').addEventListener('change', (e) => bus.send({ type: 'set_auto_events', on: e.target.checked }));
  setRunBtn();
}

// ---------------- MQTT / UNS panel ----------------
function renderMqtt() {
  const host = $('#mqtt-body'); if (!host) return;
  host.innerHTML = `
    <div class="mqtt-row"><input id="mqtt-url" type="text" value="wss://broker.emqx.io:8084/mqtt" placeholder="ws(s)://broker:port/mqtt"></div>
    <div class="mqtt-row"><input id="mqtt-line" type="text" value="env-1" placeholder="line id"><button id="mqtt-btn" class="btn-secondary mqtt-go">连接</button></div>
    <div class="mqtt-base mono" id="mqtt-base"></div>
    <div class="hint">外部 agent 订阅 <code>base/obs</code> + <code>base/reward</code>,向 <code>base/action</code> 发动作即接管控制(自动切到「外部」)。详见 docs/MQTT_UNS.md。</div>`;
  $('#mqtt-btn').addEventListener('click', async () => {
    if (mqtt.connected) { mqtt.disconnect(); }
    else { $('#mqtt-btn').textContent = '连接中…'; await mqtt.connect($('#mqtt-url').value.trim(), $('#mqtt-line').value); }
    syncMqtt();
  });
  syncMqtt();
}
function syncMqtt() {
  const st = mqtt.getStatus();
  const tag = $('#mqtt-status'); if (tag) { tag.textContent = st.connected ? '已连接' : '未连接'; tag.className = 'tag' + (st.connected ? ' on' : ''); }
  const b = $('#mqtt-base'); if (b) b.textContent = st.base;
  const btn = $('#mqtt-btn'); if (btn) btn.textContent = st.connected ? '断开' : '连接';
}
const setRunBtn = () => { const b = $('#btn-run'); b.textContent = running ? '暂停' : '运行'; b.classList.toggle('paused', !running); };
const syncModeSeg = (m) => $('#mode-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
function syncSegs(f) {
  $('#scenario-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.scenario === f.scenario));
  syncModeSeg(f.mode);
}
function updateTopbar(f) {
  $('#clock').textContent = f.t.toFixed(1) + 's';
  if (f.mode !== mode) { mode = f.mode; syncModeSeg(mode); controls.renderControl($('#control-body'), mode, f, $('#control-sub')); }
  if (f.running !== running) { running = f.running; setRunBtn(); }
  const t = $('#scn-title'); if (t && f.meta) t.textContent = f.meta.name;
  const MK = { cascade: '▤', quadruple: '◫', cstr: '⊚', hvac: '⌂' };
  const mk = $('#scn-mark'); if (mk) mk.textContent = MK[f.scenario] || '▤';
  const p = $('#scn-path'); if (p) p.textContent = `process / ${f.scenario} · ${f.n_tanks}-unit`;
  $('#env-readout').textContent = f.scenario === 'hvac'
    ? `室外 ${f.state.t_amb.toFixed(1)}°C`
    : `进料 ${f.state.t_cold.toFixed(1)}°C · 环境 ${f.state.t_amb.toFixed(1)}°C`;
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
      ${kpi('温度误差', k.avg_temp_err, '°C avg')}${kpi('液位误差', k.avg_level_err_cm, 'cm avg')}
      ${kpi('累计能耗', k.energy_kwh, 'kWh')}${kpi('超额能耗', k.excess_kwh, 'kWh')}
      ${kpi('联锁时长', k.interlock_seconds, 's')}${kpi('跳闸次数', k.trip_events, '次')}
    </div>
    <div class="pen-title">扣分项 PENALTIES</div>
    ${pen('温度跟踪', comp.tracking_temp)}${pen('液位跟踪', comp.tracking_level)}${pen('能耗', comp.energy)}${pen('安全', comp.safety)}`;
}
const kpi = (k, v, u) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small> ${u}</small></div></div>`;
const pen = (k, v) => `<div class="pen-row"><span>${k}</span><span>-${v}</span></div>`;

// ---------------- alarms ----------------
function renderAlarms(alarms, interlocks) {
  alarms = alarms || [];
  const body = $('#alarm-body'), crit = alarms.filter((a) => a.severity === 'critical').length;
  const badge = $('#alarm-count');
  badge.textContent = alarms.length;
  badge.className = 'badge ' + (crit ? 'crit' : alarms.length ? 'warn' : '');
  if (!alarms.length) { body.innerHTML = '<div class="no-alarm">— 无报警 · 系统正常 —</div>'; return; }
  alarms.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  body.innerHTML = alarms.map((a) => `<div class="alarm ${a.severity}"><span class="dot"></span><span>${a.message}</span></div>`).join('');
}

init();
