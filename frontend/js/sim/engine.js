// Client-side simulation engine. Same role as the old Python SimulationEngine:
// drives the soft-real-time loop, applies disturbances/interlocks, scores, and
// emits a telemetry frame identical in shape to the old WebSocket frame — so
// the schematic/charts/controls UI is reused unchanged. Runs fully in-browser.
import { makeModel } from './models.js?v=14';
import { Integrator } from './kernel.js?v=14';
import { ManualController, PIDController, RLController, ExternalController, obsVector, BUILTIN_POLICIES } from './controllers.js?v=14';
import { DisturbanceManager, CATALOG } from './disturbances.js?v=14';
import { AlarmMonitor, LIMITS } from './alarms.js?v=14';
import { ScoreKeeper } from './scoring.js?v=14';
import { Realism } from './realism.js?v=14';
import { MPCController } from './mpc.js?v=14';

const TICK = 0.05;
const EPISODE_SIM_S = 600;   // one episode = 600 s sim time (= 1 min at 10x speed)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampAct = (a) => ({ pumps: a.pumps.map(clamp01), valves: a.valves.map(clamp01), heaters: a.heaters.map(clamp01) });
const r = (v, d) => +v.toFixed(d);

export class Engine {
  constructor(scenario = 'cascade') {
    this.scenario = scenario;
    this.model = makeModel(scenario);
    this.n = this.model.n;
    this.integ = new Integrator(this.model);
    this.manual = new ManualController(this.model);
    this.pid = new PIDController(this.model);
    this.rl = new RLController(this.model);
    this.ext = new ExternalController(this.model);
    this.mpc = new MPCController(this.model);
    this.controllers = { manual: this.manual, pid: this.pid, mpc: this.mpc, rl: this.rl, ext: this.ext };
    this.mode = 'manual';
    this.disturb = new DisturbanceManager(this.model);
    this.alarmsMon = new AlarmMonitor(this.model);
    this.score = new ScoreKeeper(this.model);
    this.realism = new Realism(this.model);   // instrument + actuator imperfections
    this.meas = null;                          // latest measured state (what controllers/RL see)
    this._initSetpoints();
    this.running = true; this.speed = 1; this.simT = 0;
    this.autoEvents = true; this._evClock = 0; this._evNext = 12;   // realistic by default: ongoing disturbances
    this._epStart = 0; this._epScores = []; this._epCount = 1;      // episodic KPI (per-episode average)
    const [nP, nV, nH] = this.model.actuatorCounts();
    this.lastAct = { pumps: new Array(nP).fill(0), valves: new Array(nV).fill(0), heaters: new Array(nH).fill(0) };
    this.state = this.integ.getState(this.lastAct, this.disturb.environment(), 0);
    this.alarms = []; this.mask = { heater_trip: new Array(this.n).fill(false), pump_trip: false };
    this.onFrame = () => {};
  }

  _initSetpoints() {
    const [hsp, tsp] = this.model.defaultSetpoints();
    this.setpoints = { h_sp: Array.from({ length: this.n }, (_, i) => hsp[i] ?? 0), t_sp: tsp.slice() };
  }

  start(onFrame) {
    this.onFrame = onFrame || this.onFrame;
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this.running) this._tick(TICK * this.speed);
      this.onFrame(this.telemetry());
    }, TICK * 1000);
  }
  stop() { clearInterval(this._timer); this._timer = null; }

  reset() {
    this.integ.reset(this.model.initialState());
    this.alarmsMon.reset(); this.score.reset(); this.pid.reset(); this.realism.reset(); this.meas = null; this.simT = 0;
    this._epStart = 0; this._epScores = []; this._epCount = 1;
    const [nP, nV, nH] = this.model.actuatorCounts();
    this.lastAct = { pumps: new Array(nP).fill(0), valves: new Array(nV).fill(0), heaters: new Array(nH).fill(0) };
    this.state = this.integ.getState(this.lastAct, this.disturb.environment(), 0);
    this.alarms = [];
  }

  setScenario(scenario) {
    if (scenario === this.scenario) return this.reset();
    this.scenario = scenario; this.model = makeModel(scenario); this.n = this.model.n;
    this.integ = new Integrator(this.model);
    this.manual.bind(this.model); this.pid.bind(this.model); this.mpc.bind(this.model); this.rl.bind(this.model); this.ext.bind(this.model);
    this.alarmsMon.bind(this.model); this.score.bind(this.model); this.disturb.bind(this.model); this.realism.bind(this.model);
    this.disturb.clearAll(); this._initSetpoints(); this.reset();
    if (this.mode === 'rl') this._autoloadRL();          // load the new scenario's policy
  }

  setMode(mode) {
    if (!this.controllers[mode] || mode === this.mode) return;
    if (mode === 'manual') this.manual.setCommand(this.lastAct.pumps, this.lastAct.valves, this.lastAct.heaters);
    else this.controllers[mode].reset();
    this.mode = mode;
    if (mode === 'rl') this._autoloadRL();
  }

  // Auto-load the current scenario's built-in RL policy so RL mode "just works"
  // like PID/MPC — no dropdown step. rl.bind() drops the old policy on a scenario
  // switch, so this reloads the matching one. User file/URL/dropdown still override.
  _autoloadRL() {
    const def = BUILTIN_POLICIES.find((p) => p.scenario === this.scenario);
    if (def && !this.rl.session && this.rl._st.k !== 'loading') this.rl.loadPolicy(def.url, def.mode);
  }

  _autoTick(dt) {
    if (!this.autoEvents) return;
    this._evClock += dt;
    if (this._evClock < this._evNext) return;
    this._evClock = 0; this._evNext = 10 + Math.random() * 22;   // next random event in 10–32 s
    this.disturb.clearAll();
    if (Math.random() < 0.3) return;                             // sometimes a quiet period
    const hasValves = this.model.actuatorCounts()[1] > 0;
    const keys = Object.keys(CATALOG).filter((k) => !(CATALOG[k].needs === 'valves' && !hasValves));
    // default-on auto-events lean toward process disturbances; hard equipment faults
    // (pump trip / heater dead / valve stuck) are rarer so the plant isn't constantly broken.
    const faults = keys.filter((kk) => CATALOG[kk].kind === 'fault');
    const proc = keys.filter((kk) => CATALOG[kk].kind !== 'fault');
    const pool = (Math.random() < 0.78 || !faults.length) ? (proc.length ? proc : keys) : faults;
    const k = pool[Math.floor(Math.random() * pool.length)];
    const params = { ...CATALOG[k].default };
    if ('value' in params) params.value = +(params.value * (0.6 + Math.random() * 0.9)).toFixed(4);
    if ('index' in params) params.index = Math.floor(Math.random() * this.n);
    this.disturb.set(k, params);
  }

  _tick(dt) {
    this._autoTick(dt);
    const sp = this.setpoints, ctrl = this.controllers[this.mode];
    // measurement chain: true state -> injected sensor faults -> instrument realism (deadtime/lag/noise/bias)
    const meas = this.realism.measure(this.disturb.applySensorFaults(this.state), dt);
    this.meas = meas;
    const raw = ctrl.compute(meas, sp, dt);
    // supervisory RL owns the setpoints — reflect its chosen targets in the UI/charts
    if (this.mode === 'rl' && this.rl.mode === 'setpoint' && this.rl.session) this.setpoints = this.rl.getSetpoints();
    [this.alarms, this.mask] = this.alarmsMon.evaluate(this.state);   // interlocks act on the true state
    // actuation chain: command -> injected actuator faults -> actuator realism (stiction/slew) -> protective trips
    let eff = this.realism.actuate(this.disturb.applyActuatorFaults(raw), dt);
    for (let i = 0; i < eff.heaters.length; i++) if (this.mask.heater_trip[i]) eff.heaters[i] = 0;
    if (this.mask.pump_trip) eff.pumps = eff.pumps.map(() => 0);
    eff = clampAct(eff);
    const env = this.disturb.environment();
    this.state = this.integ.step(dt, eff, env);
    this.simT = this.state.t; this.lastAct = eff;
    this.score.update(this.state, sp, this.mask, this.alarms.length, dt, eff);
    if (this.simT - this._epStart >= EPISODE_SIM_S) {          // close the episode, record its average score
      const rep = this.score.report();
      this._epScores.push({ econ: rep.econ_score, ctrl: rep.score, profit: rep.econ.profit_rate });
      if (this._epScores.length > 30) this._epScores.shift();
      this.score.reset(); this._epStart = this.simT; this._epCount++;
    }
  }

  telemetry() {
    const s = this.state;
    const state = {
      levels: s.levels.map((x) => r(x, 4)), temps: s.temps.map((x) => r(x, 3)), volumes: s.volumes.map((x) => r(x, 4)),
      pump_flow: s.pump_flow.map((x) => r(x, 6)), pump_power: s.pump_power.map((x) => r(x, 1)),
      tank_outflow: s.tank_outflow.map((x) => r(x, 6)), heater_power: s.heater_power.map((x) => r(x, 1)),
      t_cold: r(s.t_cold, 2), t_amb: r(s.t_amb, 2),
    };
    // Pass through any extra model-specific array fields (e.g. CSTR `conc`) so a
    // scenario's custom trend charts get their data without touching this list.
    for (const k in s) { if (!(k in state) && k !== 't' && Array.isArray(s[k])) state[k] = s[k].map((x) => r(x, 4)); }
    return {
      type: 'telemetry', t: r(s.t, 2), running: this.running, speed: this.speed, fidelity: this.realism.level,
      scenario: this.scenario, mode: this.mode, n_tanks: this.n, meta: this.model.metadata(),
      setpoints: { h_sp: this.setpoints.h_sp.map((x) => r(x, 4)), t_sp: this.setpoints.t_sp.map((x) => r(x, 2)) },
      state,
      actuators: { pumps: this.lastAct.pumps.map((x) => r(x, 4)), valves: this.lastAct.valves.map((x) => r(x, 4)), heaters: this.lastAct.heaters.map((x) => r(x, 4)) },
      command: this.manual.snapshot(),
      alarms: this.alarms, interlocks: { heater_trip: this.mask.heater_trip.slice(), pump_trip: this.mask.pump_trip },
      score: this.score.report(), disturbances: this.disturb.status(),
      episode: { n: this._epCount, elapsed: r(this.simT - this._epStart, 0), length: EPISODE_SIM_S, history: this._epScores.slice(-12) },
      pid: this.pid.getConfig(), mpc: this.mpc.getConfig(), rl: this.rl.getStatus(), limits: this._limits(),
    };
  }

  _limits() {
    const L = LIMITS, hmax = this.model.heightMax;
    return { height_max: hmax, h_high: hmax.map((h) => L.h_high_frac * h), h_low: hmax.map((h) => L.h_low_frac * h), t_high: L.t_high, t_trip: L.t_trip };
  }

  // RL/MQTT helpers: flat observation vector and a per-step reward.
  obs() { return obsVector(this.model, this.meas || this.state, this.setpoints); }
  actionDim() { const [p, v, h] = this.model.actuatorCounts(); return p + v + h; }
  reward() {
    const r = this.score.report();
    const te = r.inst_temp_err.reduce((a, b) => a + b, 0) / Math.max(1, r.inst_temp_err.length);
    const le = r.inst_level_err.reduce((a, b) => a + b, 0) / Math.max(1, r.inst_level_err.length);
    const interlocked = this.mask.pump_trip || this.mask.heater_trip.some(Boolean);
    const comp = { tracking_temp: -(te / 20), tracking_level: -(le * 5), safety: interlocked ? -1 : 0 };
    return { reward: +(comp.tracking_temp + comp.tracking_level + comp.safety).toFixed(4), components: comp };
  }

  handleCommand(msg) {
    switch (msg.type) {
      case 'set_running': this.running = !!msg.running; break;
      case 'reset': this.reset(); break;
      case 'set_speed': this.speed = Math.max(0.1, Math.min(20, +msg.speed)); break;
      case 'set_scenario': this.setScenario(msg.scenario || 'cascade'); break;
      case 'set_mode': this.setMode(msg.mode || 'manual'); break;
      case 'manual_cmd':
        if ('kind' in msg) this.manual.setSingle(msg.kind, msg.index | 0, +msg.value);
        else this.manual.setCommand(msg.pumps, msg.valves, msg.heaters);
        break;
      case 'set_setpoints':
        if (msg.h_sp) this.setpoints.h_sp = msg.h_sp.map(Number);
        if (msg.t_sp) this.setpoints.t_sp = msg.t_sp.map(Number);
        break;
      case 'set_pid': this.pid.setConfig(msg); break;
      case 'set_model_config': this.model.setConfig(msg.config || {}); break;
      case 'set_rl_policy': this.rl.loadPolicy(msg.src, msg.mode); break;
      case 'set_action': this.ext.setAction(msg.action); if (this.mode !== 'ext') this.setMode('ext'); break;
      case 'set_disturbance': this.disturb.set(msg.dtype, msg.params); break;
      case 'clear_disturbance': this.disturb.clear(msg.dtype); break;
      case 'clear_disturbances': this.disturb.clearAll(); break;
      case 'set_auto_events': this.autoEvents = !!msg.on; this._evClock = 0; this._evNext = 4; if (!msg.on) this.disturb.clearAll(); break;
      case 'set_fidelity': this.realism.setLevel(msg.level); break;
      case 'set_mpc': this.mpc.setConfig(msg); break;
    }
  }
}

export { CATALOG };
