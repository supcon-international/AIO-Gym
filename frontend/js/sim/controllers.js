// Controllers: manual (passthrough), PID (pairing-driven, ports the Python
// multi-loop PID), and RL (loads an ONNX policy and runs it in-browser via
// onnxruntime-web). All share one interface: compute(state, setpoints, dt) ->
// {pumps, valves, heaters} in [0,1]. The mode buttons swap between them.
import { t } from '../i18n.js?v=14';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const zeros = (n) => new Array(n).fill(0);
const fill = (n, v) => new Array(n).fill(v);
const copyAct = (a) => ({ pumps: a.pumps.slice(), valves: a.valves.slice(), heaters: a.heaters.slice() });

// Shared observation vector (RL ONNX + MQTT use the same contract):
//   obs = [ levels(n), temps(n), t_sp(n), h_sp(controlled k), t_cold, t_amb ]   length 3n+k+2
// (level slots are 0 for scenarios without levels, e.g. CSTR/HVAC).
export function obsVector(model, state, sp) {
  const n = model.n, o = [];
  for (let i = 0; i < n; i++) o.push(state.levels[i] ?? 0);
  for (let i = 0; i < n; i++) o.push(state.temps[i]);
  for (let i = 0; i < n; i++) o.push(sp.t_sp[i]);
  for (const i of model.controlledLevels()) o.push(sp.h_sp[i]);
  o.push(state.t_cold, state.t_amb);
  return o;
}

// ---------------- Manual ----------------
export class ManualController {
  constructor(model) { this.bind(model); }
  bind(model) {
    const [nP, nV, nH] = model.actuatorCounts();
    this.cmd = { pumps: fill(nP, 0.3), valves: fill(nV, 0.5), heaters: zeros(nH) };
  }
  reset() {}
  setCommand(pumps, valves, heaters) {
    if (pumps) this.cmd.pumps = pumps.map(Number);
    if (valves) this.cmd.valves = valves.map(Number);
    if (heaters) this.cmd.heaters = heaters.map(Number);
  }
  setSingle(kind, i, v) {
    const arr = { pump: this.cmd.pumps, valve: this.cmd.valves, heater: this.cmd.heaters }[kind];
    if (arr && i >= 0 && i < arr.length) arr[i] = +v;
  }
  compute() { return copyAct(this.cmd); }
  snapshot() { return copyAct(this.cmd); }
}

// ---------------- PID ----------------
class PIDLoop {
  constructor(g, reverse = false) { this.g = g; this.reverse = reverse; this.reset(); }
  reset() { this.i = 0; this.prev = null; }
  update(sp, meas, dt) {
    // reverse-acting (e.g. cooling): output rises when measurement is ABOVE setpoint.
    const e = this.reverse ? meas - sp : sp - meas;
    const dmeas = this.prev == null || dt <= 0 ? 0 : (meas - this.prev) / dt;
    this.prev = meas;
    const p = this.g.kp * e, d = (this.reverse ? 1 : -1) * this.g.kd * dmeas;
    const iCand = this.i + this.g.ki * e * dt;
    const raw = p + iCand + d, out = clamp01(raw);
    if (!((raw > 1 && e > 0) || (raw < 0 && e < 0))) this.i = iCand;
    return out;
  }
}

export class PIDController {
  constructor(model) { this.bind(model); }
  bind(model) {
    this.model = model;
    [this.nP, this.nV, this.nH] = model.actuatorCounts();
    this.gains = JSON.parse(JSON.stringify(model.defaultGains()));
    const pr = model.controlPairing();
    this.demandIdx = pr.demand_valve_index; this.demandValve = 0.5;
    this.holds = pr.holds || [];   // [[kind, idx, value], ...] actuators held at a fixed value
    this.levelLoops = pr.level.map(([kind, ai, li, rev]) => ({ kind, ai, li, loop: new PIDLoop(this.gains[kind === 'pump' ? 'level_pump' : 'level_valve'], !!rev) }));
    this.tempLoops = pr.temp.map(([hi, ti, rev]) => ({ hi, ti, loop: new PIDLoop(this.gains.temp, !!rev) }));
  }
  reset() { this.levelLoops.forEach((l) => l.loop.reset()); this.tempLoops.forEach((l) => l.loop.reset()); }
  compute(state, sp, dt) {
    const act = { pumps: zeros(this.nP), valves: zeros(this.nV), heaters: zeros(this.nH) };
    for (const [kind, idx, value] of this.holds) {
      const arr = { pump: act.pumps, valve: act.valves, heater: act.heaters }[kind];
      if (arr && idx < arr.length) arr[idx] = value;
    }
    for (const { kind, ai, li, loop } of this.levelLoops) {
      const out = loop.update(sp.h_sp[li], state.levels[li], dt);
      if (kind === 'pump') act.pumps[ai] = out; else act.valves[ai] = out;
    }
    if (this.demandIdx != null && this.nV) act.valves[this.demandIdx] = this.demandValve;
    for (const { hi, ti, loop } of this.tempLoops) act.heaters[hi] = loop.update(sp.t_sp[ti], state.temps[ti], dt);
    return act;
  }
  getConfig() { return { gains: this.gains, demand_valve: this.demandValve }; }
  setConfig(cfg) {
    if (cfg.gains) for (const k in cfg.gains) if (this.gains[k]) for (const p of ['kp', 'ki', 'kd']) if (cfg.gains[k][p] != null) this.gains[k][p] = +cfg.gains[k][p];
    if (cfg.demand_valve != null) this.demandValve = +cfg.demand_valve;
  }
}

// ---------------- RL (ONNX policy, in-browser) ----------------
// Observation / action contract (the offline Gym env must match this):
//   obs    = [ ...levels(n), ...temps(n), ...t_sp(n), ...h_sp(controlled k), t_cold, t_amb ]   (Float32, length 3n+k+2)
//   action = [ ...pumps(nP), ...valves(nV), ...heaters(nH) ]  in [0,1] (clamped)               (Float32, length nP+nV+nH)
// onnxruntime-web is loaded on demand (only when RL mode is used).
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';

// Policies bundled under frontend/models/. Each is scenario-specific (the obs/act
// contract differs per plant), so selecting one switches the sim to its scenario
// before loading. Drop a new .onnx in frontend/models/ and add a row here.
// One economic-objective RLPD policy per scenario. Each was trained on the economic
// KPI (value − energy-cost in soft bands) under 工况 (operating-regime) variation, and
// beats both fixed-SP PID and fixed-model MPC on economic performance (aiogym/runs).
// Supervisory (RL-on-PID / RTO) action layout — MUST mirror aiogym/env.py SUPERVISORY.
// The policy outputs SETPOINTS (normalized 0-1 -> [lo,hi]); an inner PID regulates the
// plant to them, so the plant is always controlled and RL only picks the economic
// optimum. ['t_sp',tank,lo,hi] | ['h_sp',level,lo,hi] | ['mv',kind,idx,lo,hi] (direct MV).
export const SUPERVISORY = {
  cascade:   [['t_sp', 0, 25, 80], ['t_sp', 1, 30, 82], ['t_sp', 2, 35, 85]],
  quadruple: [['t_sp', 0, 25, 72], ['t_sp', 1, 25, 72], ['t_sp', 2, 20, 58], ['t_sp', 3, 20, 58]],
  cstr:      [['t_sp', 0, 45, 90], ['mv', 'pumps', 0, 0.3, 1.0]],
  hvac:      [['t_sp', 0, 18, 26], ['t_sp', 1, 18, 26]],
};

// One supervisory RLPD policy per scenario: RL sets the setpoints, the inner PID
// regulates to them, and RL beats the fixed-SP PID / fixed-model MPC on economics by
// adapting its targets to 工况 (operating regime). All trained in aiogym/runs.
export const BUILTIN_POLICIES = [
  { id: 'rlpd_cstr', scenario: 'cstr', url: './models/rlpd_cstr.onnx', mode: 'setpoint',
    zh: 'RLPD · CSTR 经济', en: 'RLPD · CSTR economic',
    noteZh: 'RL 设温度/进料目标、PID 控住：贴安全边界最大化产量，唯一盈利、超 PID/MPC',
    noteEn: 'RL sets temp/feed targets, PID holds them — production-max on the safe edge, the only profitable one' },
  { id: 'rlpd_cascade', scenario: 'cascade', url: './models/rlpd_cascade.onnx', mode: 'setpoint',
    zh: 'RLPD · 多级水箱 节能', en: 'RLPD · Cascade economic',
    noteZh: 'RL 设各罐温度目标、PID 控住：达标前提下最省能，运行成本低于 PID/MPC',
    noteEn: 'RL sets tank temp targets, PID holds them — min-energy on-spec, lower cost than PID/MPC' },
  { id: 'rlpd_quadruple', scenario: 'quadruple', url: './models/rlpd_quadruple.onnx', mode: 'setpoint',
    zh: 'RLPD · 四水箱 节能', en: 'RLPD · Quadruple economic',
    noteZh: 'RL 设温度目标、PID 控住：达标前提下最省能，成本低于 PID/MPC',
    noteEn: 'RL sets temp targets, PID holds them — min-energy on-spec, lower cost than PID/MPC' },
  { id: 'rlpd_hvac', scenario: 'hvac', url: './models/rlpd_hvac.onnx', mode: 'setpoint',
    zh: 'RLPD · HVAC 节能', en: 'RLPD · HVAC economic',
    noteZh: 'RL 设室温目标、PID 控住：舒适区内贴外温侧最省能，成本低于 PID/MPC',
    noteEn: 'RL sets zone-temp targets, PID holds them — min-energy in comfort band, lower cost' },
];

export class RLController {
  constructor(model) { this.session = null; this.ready = false; this._st = { k: 'idle' }; this.bind(model); }
  bind(model) {
    this.model = model;
    // a policy is scenario-specific (obs/act dims differ) — drop any loaded one on (re)bind
    this.session = null; this.ready = false; this._st = { k: 'idle' };
    const [nP, nV, nH] = model.actuatorCounts();
    this.nP = nP; this.nV = nV; this.nH = nH;
    this.ctrl = model.controlledLevels();
    this.obsLen = 3 * model.n + this.ctrl.length + 2;
    this.actLen = nP + nV + nH;
    // supervisory (RL-on-PID): policy outputs setpoints, an inner PID regulates to them
    this.scenario = model.metadata ? model.metadata().scenario : 'cascade';
    this.layout = SUPERVISORY[this.scenario] || null;
    this.pid = new PIDController(model);
    this.mode = 'actuator';
    this.lastAction = { pumps: fill(nP, 0.3), valves: fill(nV, 0.5), heaters: zeros(nH) };
    this._resetSp();
    this._busy = false;
  }
  _resetSp() {
    const [hsp, tsp] = this.model.defaultSetpoints();
    this.tsp = tsp.slice();
    this.hsp = Array.from({ length: this.model.n }, (_, i) => hsp[i] ?? 0);
    this.mv = {};
  }
  reset() { if (this.pid) this.pid.reset(); this._resetSp(); }
  getSetpoints() { return { t_sp: this.tsp.slice(), h_sp: this.hsp.slice() }; }

  obs(state, sp) { return Float32Array.from(obsVector(this.model, state, sp)); }

  // Non-blocking: kick async inference, return an actuator command. Supervisory mode
  // runs the inner PID to RL's (async-updated) setpoints every tick; actuator mode
  // returns the last cached raw action.
  compute(state, sp, dt) {
    const setpoint = this.mode === 'setpoint' && this.layout;
    if (this.session && !this._busy) {
      this._busy = true;
      const x = setpoint ? Float32Array.from(obsVector(this.model, state, { t_sp: this.tsp, h_sp: this.hsp }))
                         : this.obs(state, sp);
      (setpoint ? this._inferSp(x) : this._infer(x)).finally(() => { this._busy = false; });
    }
    if (!setpoint) return copyAct(this.lastAction);
    const act = this.pid.compute(state, { t_sp: this.tsp, h_sp: this.hsp }, dt);   // PID holds RL's targets
    for (const key in this.mv) { const [kind, idx] = key.split(':'); act[kind][+idx] = this.mv[key]; }
    return act;
  }

  async _infer(x) {
    try {
      const ort = window.ort;
      const input = new ort.Tensor('float32', x, [1, x.length]);
      const feeds = {}; feeds[this.session.inputNames[0]] = input;
      const out = await this.session.run(feeds);
      const a = out[this.session.outputNames[0]].data;
      const act = { pumps: [], valves: [], heaters: [] };
      let k = 0;
      for (let i = 0; i < this.nP; i++) act.pumps.push(clamp01(a[k++]));
      for (let i = 0; i < this.nV; i++) act.valves.push(clamp01(a[k++]));
      for (let i = 0; i < this.nH; i++) act.heaters.push(clamp01(a[k++]));
      this.lastAction = act;
    } catch (e) { this._st = { k: 'err', msg: e.message }; this.ready = false; }
  }

  // Supervisory inference: ONNX outputs normalized setpoints -> denormalize -> the SPs
  // the inner PID tracks (+ any direct economic MVs).
  async _inferSp(x) {
    try {
      const ort = window.ort;
      const input = new ort.Tensor('float32', x, [1, x.length]);
      const feeds = {}; feeds[this.session.inputNames[0]] = input;
      const out = await this.session.run(feeds);
      const a = out[this.session.outputNames[0]].data;
      const mv = {};
      this.layout.forEach((spec, i) => {
        const lo = spec[spec.length - 2], hi = spec[spec.length - 1];
        const val = lo + clamp01(a[i]) * (hi - lo);
        if (spec[0] === 't_sp') this.tsp[spec[1]] = val;
        else if (spec[0] === 'h_sp') this.hsp[spec[1]] = val;
        else mv[spec[1] + ':' + spec[2]] = val;            // ['mv', kind, idx, lo, hi]
      });
      this.mv = mv;
    } catch (e) { this._st = { k: 'err', msg: e.message }; this.ready = false; }
  }

  async loadPolicy(src, mode) {
    this._st = { k: 'loading' };
    this.mode = mode || 'actuator';
    const expectOut = (this.mode === 'setpoint' && this.layout) ? this.layout.length : this.actLen;
    try {
      if (!window.ort) await loadScript(ORT_CDN);
      const ort = window.ort;
      const session = await ort.InferenceSession.create(src);
      // Validate obs/output dims against the scenario up front, so a mismatched policy
      // fails loudly once at load — not silently every tick.
      const probe = new ort.Tensor('float32', new Float32Array(this.obsLen), [1, this.obsLen]);
      const feeds = {}; feeds[session.inputNames[0]] = probe;
      const out = await session.run(feeds);
      const aLen = out[session.outputNames[0]].data.length;
      if (aLen !== expectOut) throw new Error(`__DIM__act ${aLen} ${expectOut}`);
      this.session = session; this.ready = true;
      this._st = { k: 'loaded' };
      return true;
    } catch (e) { this.session = null; this.ready = false; this._st = { k: 'fail', msg: this._hint(e.message) }; return false; }
  }
  // Turn an onnxruntime dimension error into actionable guidance (which scenario the policy fits).
  _hint(msg) {
    const dim = /Got:\s*(\d+)\s*Expected:\s*(\d+)/.exec(msg);       // obs mismatch: Got=scenario, Expected=policy
    if (dim) return t(`策略输入维度=${dim[2]}，与当前场景 obs=${dim[1]} 不匹配——请切到匹配场景或选用对应策略`,
                      `policy expects obs=${dim[2]} but this scenario is obs=${dim[1]} — switch scenario or pick a matching policy`);
    const am = /^__DIM__act (\d+) (\d+)/.exec(msg);                  // act mismatch
    if (am) return t(`策略输出维度=${am[1]}，与当前场景 act=${am[2]} 不匹配`,
                     `policy outputs act=${am[1]} but this scenario needs act=${am[2]}`);
    return msg;
  }
  // Localize the status at read-time so a language toggle updates it immediately.
  getStatus() {
    const sup = this.mode === 'setpoint' && this.layout;
    const outN = sup ? this.layout.length : this.actLen;
    const loaded = sup ? t(`策略已加载 · RL→设定点(${outN})→PID`, `Loaded · RL→setpoints(${outN})→PID`)
                       : t(`策略已加载 (obs=${this.obsLen}, act=${this.actLen})`, `Policy loaded (obs=${this.obsLen}, act=${this.actLen})`);
    const s = this._st, st =
      s.k === 'loading' ? t('加载中…', 'Loading…')
      : s.k === 'loaded' ? loaded
      : s.k === 'err' ? t('ONNX 推理出错', 'ONNX inference error') + ': ' + s.msg
      : s.k === 'fail' ? t('加载失败', 'Load failed') + ': ' + s.msg
      : t('未加载策略', 'No policy loaded');
    return { ready: this.ready, status: st, obsLen: this.obsLen, actLen: this.actLen };
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('无法加载 onnxruntime-web (离线? 可改为本地 vendored)'));
    document.head.appendChild(s);
  });
}

// ---------------- External controller (actions arrive over MQTT) ----------------
// Holds the latest action vector written by an outside agent (e.g. an RL policy
// running in Python, talking over MQTT). The flat vector order is
// [pumps..., valves..., heaters...], matching the RL/obs contract.
export class ExternalController {
  constructor(model) { this.bind(model); }
  bind(model) {
    const [nP, nV, nH] = model.actuatorCounts();
    this.nP = nP; this.nV = nV; this.nH = nH;
    this.last = { pumps: fill(nP, 0.3), valves: fill(nV, 0.5), heaters: zeros(nH) };
  }
  reset() {}
  setAction(vec) {
    if (!Array.isArray(vec)) return;
    let k = 0; const a = { pumps: [], valves: [], heaters: [] };
    for (let i = 0; i < this.nP; i++) a.pumps.push(clamp01(vec[k++] ?? this.last.pumps[i]));
    for (let i = 0; i < this.nV; i++) a.valves.push(clamp01(vec[k++] ?? this.last.valves[i]));
    for (let i = 0; i < this.nH; i++) a.heaters.push(clamp01(vec[k++] ?? this.last.heaters[i]));
    this.last = a;
  }
  compute() { return copyAct(this.last); }
}
