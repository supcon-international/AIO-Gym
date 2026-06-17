// Interactive control panels, driven entirely by the active model's metadata:
// manual actuator sliders (per pump/valve/heater), PID setpoints (only the
// controlled levels + every tank temperature) with gain tuning, the
// scenario-specific config (quadruple-tank split ratios gamma), and the
// disturbance/fault toggles. All actions go to the engine via the bus.
import { t } from './i18n.js?v=3';

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    if (k === 'class') e.className = props[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), props[k]);
    else e.setAttribute(k, props[k]);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// Bilingual labels for the disturbance catalogue (keyed by CATALOG key).
const DIST_LABEL = {
  cold_inlet: () => t('冷进料温度阶跃', 'Cold inlet temp step'),
  ambient: () => t('环境温度变化', 'Ambient temp change'),
  demand_surge: () => t('下游需求激增', 'Downstream demand surge'),
  sensor_noise: () => t('传感器噪声', 'Sensor noise'),
  heater_fault: () => t('加热器失效（卡关）', 'Heater dead (stuck off)'),
  valve_stuck: () => t('阀卡死', 'Valve stuck'),
  pump_trip: () => t('泵跳闸（无进料）', 'Pump trip (no inflow)'),
};

export function buildControls(bus, meta, catalog) {
  const dragging = new Set();
  let mode = 'manual';
  const n = meta.n_tanks;
  const A = meta.actuators;
  const heaterKW = (meta.heater_max || []).map((w) => w / 1000);

  function slider(kind, index, label, fmt, init, cls) {
    const sid = `${kind}${index}`;
    const val = h('span', { class: 'val' }, fmt(init));
    const inp = h('input', {
      type: 'range', min: 0, max: 1, step: 0.01, value: init, class: cls,
      oninput: (e) => { val.textContent = fmt(+e.target.value); bus.send({ type: 'manual_cmd', kind, index, value: +e.target.value }); },
      onpointerdown: () => dragging.add(sid), onpointerup: () => dragging.delete(sid),
    });
    inp.dataset.sid = sid;
    return h('div', { class: 'ctrl-row' }, h('div', { class: 'ctrl-label' }, h('span', { class: 'name' }, label), val), inp);
  }

  function manualPanel() {
    const w = h('div');
    w.append(h('div', { class: 'group-title' }, t('进料泵', 'Pumps')));
    A.pumps.forEach((lab, i) => w.append(slider('pump', i, lab, (v) => `${(v * 100).toFixed(0)}%`, 0.3, '')));
    if (A.valves.length) {
      w.append(h('div', { class: 'divider' }), h('div', { class: 'group-title' }, t('出料阀', 'Valves')));
      A.valves.forEach((lab, i) => w.append(slider('valve', i, lab, (v) => `${(v * 100).toFixed(0)}%`, 0.5, 'valve')));
    }
    w.append(h('div', { class: 'divider' }), h('div', { class: 'group-title' }, t('加热器', 'Heaters')));
    A.heaters.forEach((lab, i) => w.append(slider('heater', i, lab, (v) => `${(v * (heaterKW[i] || 90)).toFixed(1)} kW`, 0, 'heater')));
    return w;
  }

  function pidPanel(frame) {
    const sp = frame?.setpoints || { h_sp: [], t_sp: [] };
    const cfg = frame?.pid;
    const ctrl = meta.controlled_levels || [];
    const w = h('div');

    // level setpoints (only controlled)
    w.append(h('div', { class: 'group-title' }, t('液位设定 (m)', 'Level SP (m)')));
    ctrl.forEach((idx) => {
      const inp = h('input', { type: 'number', step: 0.01, min: 0, max: 0.8, value: (sp.h_sp[idx] ?? 0.4).toFixed(2), onchange: sendSP });
      inp.dataset.hsp = idx;
      w.append(h('div', { class: 'sp-row' }, h('label', {}, meta.tank_labels[idx]), inp, h('span')));
    });
    // temperature setpoints (every tank)
    w.append(h('div', { class: 'group-title', style: 'margin-top:10px' }, t('温度设定 (°C)', 'Temp SP (°C)')));
    for (let i = 0; i < n; i++) {
      const inp = h('input', { type: 'number', step: 1, min: 10, max: 90, value: (sp.t_sp[i] ?? 50).toFixed(0), onchange: sendSP });
      inp.dataset.tsp = i;
      w.append(h('div', { class: 'sp-row' }, h('label', {}, meta.tank_labels[i]), inp, h('span')));
    }
    function sendSP() {
      const h_sp = Array(n).fill(0);
      w.querySelectorAll('[data-hsp]').forEach((e) => { h_sp[+e.dataset.hsp] = +e.value; });
      const t_sp = Array(n).fill(50);
      w.querySelectorAll('[data-tsp]').forEach((e) => { t_sp[+e.dataset.tsp] = +e.value; });
      bus.send({ type: 'set_setpoints', h_sp, t_sp });
    }

    // demand valve (cascade only)
    if (A.valves.length) {
      const dv = cfg?.demand_valve ?? 0.5;
      const dval = h('span', { class: 'val' }, `${(dv * 100) | 0}%`);
      w.append(h('div', { class: 'divider' }), h('div', { class: 'group-title' }, t('需求阀（扰动）', 'Demand valve (disturbance)')),
        h('div', { class: 'ctrl-row' }, h('div', { class: 'ctrl-label' }, h('span', { class: 'name' }, t('下游需求', 'Downstream demand')), dval),
          h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: dv, class: 'valve', oninput: (e) => { dval.textContent = `${(e.target.value * 100) | 0}%`; bus.send({ type: 'set_pid', demand_valve: +e.target.value }); } })));
    }

    // PID gains
    const tune = h('details', { class: 'tune' }, h('summary', {}, t('PID 整定', 'PID tuning')));
    const g = cfg?.gains || {};
    const grid = h('div', { class: 'gain-grid' }, h('span'), h('span', { class: 'gh' }, 'Kp'), h('span', { class: 'gh' }, 'Ki'), h('span', { class: 'gh' }, 'Kd'));
    const loops = A.valves.length
      ? [['level_pump', t('液位·泵', 'Level·pump')], ['level_valve', t('液位·阀', 'Level·valve')], ['temp', t('温度', 'Temp')]]
      : [['level_pump', t('液位·泵', 'Level·pump')], ['temp', t('温度', 'Temp')]];
    for (const [key, label] of loops) {
      grid.append(h('label', {}, label));
      for (const p of ['kp', 'ki', 'kd']) {
        const gi = h('input', { type: 'number', step: 0.001, value: (g[key]?.[p] ?? 0), onchange: sendGains });
        gi.dataset.gk = key; gi.dataset.gp = p; grid.append(gi);
      }
    }
    function sendGains() {
      const gains = {};
      grid.querySelectorAll('[data-gk]').forEach((e) => { (gains[e.dataset.gk] = gains[e.dataset.gk] || {})[e.dataset.gp] = +e.value; });
      bus.send({ type: 'set_pid', gains });
    }
    tune.append(grid); w.append(tune);
    return w;
  }

  // quadruple-tank split-ratio config (the RHP-zero knob)
  function configPanel(frame) {
    const cfg = (frame?.meta?.config) || meta.config || {};
    if (cfg.gamma1 == null) return null;
    const w = h('div');
    w.append(h('div', { class: 'group-title' }, t('分流比 γ', 'Split ratio γ')));
    const phase = h('div', { class: 'phase-tag', id: 'phase-tag' }, cfg.phase || '');
    for (const key of ['gamma1', 'gamma2']) {
      const val = h('span', { class: 'val' }, (cfg[key] ?? 0.7).toFixed(2));
      const inp = h('input', { type: 'range', min: 0.05, max: 0.95, step: 0.01, value: cfg[key] ?? 0.7, class: 'gamma',
        oninput: (e) => { val.textContent = (+e.target.value).toFixed(2); bus.send({ type: 'set_model_config', config: { [key]: +e.target.value } }); } });
      inp.dataset.gamma = key;
      w.append(h('div', { class: 'ctrl-row' }, h('div', { class: 'ctrl-label' }, h('span', { class: 'name' }, key === 'gamma1' ? t('γ₁ (泵1→下罐1)', 'γ₁ (pump1→tank1)') : t('γ₂ (泵2→下罐2)', 'γ₂ (pump2→tank2)')), val), inp));
    }
    w.append(phase);
    w.append(h('div', { class: 'hint' }, t('γ₁+γ₂ < 1 → 非最小相位（RHP 零点，更难控）', 'γ₁+γ₂ < 1 → non-minimum-phase (RHP zero, harder)')));
    return w;
  }

  // disturbances — auto by default (header checkbox); manual injection collapsed below
  function disturbPanel() {
    const w = h('div'), cat = catalog.disturbances;
    const det = h('details', { class: 'tune' }, h('summary', {}, t('手动注入', 'Manual inject')));
    const box0 = h('div');
    for (const key in cat) {
      const def = cat[key];
      if (def.needs === 'valves' && !A.valves.length) continue;  // hide valve faults when no valves
      const toggle = h('div', { class: 'toggle', 'data-dist': key, onclick: (e) => {
        const on = e.target.classList.toggle('on');
        if (on) bus.send({ type: 'set_disturbance', dtype: key, params: readParams(key) });
        else bus.send({ type: 'clear_disturbance', dtype: key });
      } });
      const label = (DIST_LABEL[key] ? DIST_LABEL[key]() : def.label);
      box0.append(h('div', { class: 'dist-item' }, h('div', { class: 'dn' }, label, h('small', {}, def.kind === 'fault' ? t('故障', 'fault') : t('扰动', 'disturbance'))), toggle));
      const pb = paramInputs(key, def, () => { if (toggle.classList.contains('on')) bus.send({ type: 'set_disturbance', dtype: key, params: readParams(key) }); });
      if (pb) box0.append(pb);
    }
    det.append(box0); w.append(det);
    return w;
    function readParams(key) {
      const box = w.querySelector(`[data-pbox="${key}"]`); if (!box) return {};
      const out = {}; box.querySelectorAll('[data-pk]').forEach((e) => { out[e.dataset.pk] = +e.value; }); return out;
    }
  }
  function paramInputs(key, def, onchg) {
    const d = def.default; if (!d || !Object.keys(d).length) return null;
    const box = h('div', { class: 'dist-param', 'data-pbox': key });
    for (const pk in d) {
      if (pk === 'index') {
        const sel = h('select', { onchange: onchg }); sel.dataset.pk = pk;
        for (let i = 0; i < n; i++) sel.append(h('option', { value: i }, meta.tank_labels[i]));
        sel.value = d[pk]; box.append(h('span', {}, t('目标', 'Target')), sel);
      } else {
        const inp = h('input', { type: 'number', step: pk.includes('std') ? 0.01 : (key.includes('demand') ? 0.0001 : 0.5), value: d[pk], onchange: onchg });
        inp.dataset.pk = pk; box.append(h('span', {}, labelFor(pk)), inp);
      }
    }
    return box;
  }
  const labelFor = (pk) => ({ value: t('幅度', 'Amplitude'), level_std: t('液位σ', 'Level σ'), temp_std: t('温度σ', 'Temp σ') }[pk] || pk);

  // RL: load a trained ONNX policy (trained offline) and run it in-browser.
  function rlPanel(frame) {
    const rl = frame?.rl || {};
    const w = h('div');
    w.append(h('div', { class: 'group-title' }, t('RL 策略 (ONNX)', 'RL policy (ONNX)')));
    w.append(h('div', { class: 'rl-status', id: 'rl-status' }, rl.status || t('未加载策略', 'No policy loaded')));
    const file = h('input', { type: 'file', accept: '.onnx',
      onchange: (e) => { const f = e.target.files[0]; if (f) f.arrayBuffer().then((b) => bus.send({ type: 'set_rl_policy', src: new Uint8Array(b) })); } });
    w.append(h('label', { class: 'rl-load' }, h('span', {}, t('选择 .onnx 策略文件', 'Choose an .onnx policy file')), file));
    const url = h('input', { type: 'text', placeholder: t('models/policy.onnx 或 URL', 'models/policy.onnx or URL') });
    w.append(h('div', { class: 'dist-param' }, url, h('button', { class: 'mini', onclick: () => { if (url.value) bus.send({ type: 'set_rl_policy', src: url.value }); } }, t('加载', 'Load'))));
    w.append(h('div', { class: 'hint' }, t(`契约 obs=${rl.obsLen ?? '?'} · act=${rl.actLen ?? '?'}，动作 ∈[0,1]`, `Contract obs=${rl.obsLen ?? '?'} · act=${rl.actLen ?? '?'}, action ∈[0,1]`)));
    return w;
  }

  // External (MQTT) control info panel
  function extPanel(frame) {
    const rl = frame?.rl || {};
    const w = h('div');
    w.append(h('div', { class: 'group-title' }, t('外部控制 (MQTT)', 'External control (MQTT)')));
    w.append(h('div', { class: 'hint' }, t(`动作经 MQTT 写入即自动接管。obs=${rl.obsLen ?? '?'} · act=${rl.actLen ?? '?'}`, `Actions written over MQTT take over automatically. obs=${rl.obsLen ?? '?'} · act=${rl.actLen ?? '?'}`)));
    return w;
  }

  return {
    setMode(m) { mode = m; },
    renderControl(host, m, frame, subEl) {
      mode = m; host.innerHTML = '';
      if (m === 'pid') { host.append(pidPanel(frame)); if (subEl) subEl.textContent = t('PID 自动', 'PID auto'); }
      else if (m === 'rl') { host.append(rlPanel(frame)); if (subEl) subEl.textContent = t('RL 策略', 'RL policy'); }
      else if (m === 'ext') { host.append(extPanel(frame)); if (subEl) subEl.textContent = t('外部 MQTT', 'External MQTT'); }
      else { host.append(manualPanel()); if (subEl) subEl.textContent = t('手动', 'Manual'); }
      const cp = configPanel(frame); if (cp) host.append(h('div', { class: 'divider' }), cp);
    },
    syncRL(frame) {
      if (mode !== 'rl') return;
      const el = document.getElementById('rl-status');
      if (el && frame.rl) el.textContent = frame.rl.status;
    },
    renderDisturb(host) { host.innerHTML = ''; host.append(disturbPanel()); },
    syncManual(frame) {
      if (mode !== 'manual') return;
      const c = frame.command;
      const setLab = (sid, v, fmt) => {
        if (dragging.has(sid)) return;
        const el = document.querySelector(`input[data-sid="${sid}"]`);
        if (el && Math.abs(+el.value - v) > 1e-3) { el.value = v; const lab = el.parentElement.querySelector('.val'); if (lab) lab.textContent = fmt(v); }
      };
      c.pumps.forEach((v, i) => setLab(`pump${i}`, v, (x) => `${(x * 100).toFixed(0)}%`));
      c.valves.forEach((v, i) => setLab(`valve${i}`, v, (x) => `${(x * 100).toFixed(0)}%`));
      c.heaters.forEach((v, i) => setLab(`heater${i}`, v, (x) => `${(x * (heaterKW[i] || 90)).toFixed(1)} kW`));
    },
    syncConfig(frame) {
      const cfg = frame?.meta?.config; if (!cfg) return;
      const tag = document.getElementById('phase-tag'); if (tag && cfg.phase) tag.textContent = cfg.phase;
    },
    syncDisturb(host, active) {
      host.querySelectorAll('[data-dist]').forEach((t) => t.classList.toggle('on', !!active[t.getAttribute('data-dist')]));
    },
  };
}
