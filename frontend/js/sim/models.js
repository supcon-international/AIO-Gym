// Plant models — pure-JS port of the Python `PlantModel`s. The model defines
// the ODE right-hand side, topology metadata, default control pairing and the
// ideal-power reference for scoring. Same equations and numbers as the Python
// reference, so behaviour matches. A model is integrated by ../sim/kernel.js.
import { t } from '../i18n.js?v=14';

const RHO = 1000, CP = 4186, G = 9.81, RHO_CP = RHO * CP;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const maxv = (a, b) => (a > b ? a : b);

// ---------------- Scenario 1: heated-tank cascade (6 states) ----------------
class CascadeModel {
  constructor() {
    this.scenario = 'cascade';
    this.n = 3;
    this.p = {
      area: 0.15, height_max: 0.80, cv_out: 0.0026, ua_loss: 40, heater_max: 90000,
      pump_flow_max: 0.0016, pump_power_max: 1500, t_cold: 15, t_amb: 20, h_floor: 1e-3,
    };
  }
  actuatorCounts() { return [1, 3, 3]; }
  get heightMax() { return [0.8, 0.8, 0.8]; }

  _flows(h, act, env) {
    const p = this.p, qp = act.pumps[0] * p.pump_flow_max, qo = [];
    for (let i = 0; i < 3; i++) {
      let f = p.cv_out * act.valves[i] * Math.sqrt(maxv(h[i], 0));
      if (i === 2) f += env.extra_outflow || 0;
      qo.push(f);
    }
    return [qp, qo];
  }
  derivatives(x, act, env) {
    const p = this.p, h = [x[0], x[2], x[4]], T = [x[1], x[3], x[5]];
    const [qp, qo] = this._flows(h, act, env), dx = new Array(6).fill(0);
    for (let i = 0; i < 3; i++) {
      const qin = i === 0 ? qp : qo[i - 1], tin = i === 0 ? env.t_cold : T[i - 1];
      dx[2 * i] = (qin - qo[i]) / p.area;
      const vol = p.area * maxv(h[i], p.h_floor);
      const pheat = act.heaters[i] * p.heater_max, qloss = p.ua_loss * (T[i] - env.t_amb);
      dx[2 * i + 1] = (qin * (tin - T[i])) / vol + (pheat - qloss) / (RHO_CP * vol);
    }
    return dx;
  }
  buildState(x, act, env, t) {
    const p = this.p, h = [maxv(x[0], 0), maxv(x[2], 0), maxv(x[4], 0)], T = [x[1], x[3], x[5]];
    const [qp, qo] = this._flows(h, act, env);
    return {
      t, levels: h, temps: T, volumes: h.map((v) => p.area * v),
      heater_power: act.heaters.map((u) => u * p.heater_max),
      pump_flow: [qp], pump_power: [act.pumps[0] * p.pump_power_max],
      tank_outflow: qo, t_cold: env.t_cold, t_amb: env.t_amb,
    };
  }
  initialState() { return [0.30, 20, 0.30, 20, 0.30, 20]; }
  controlledLevels() { return [0, 1, 2]; }
  defaultSetpoints() { return [{ 0: 0.45, 1: 0.45, 2: 0.45 }, [35, 50, 65]]; }
  defaultGains() {
    return { level_pump: { kp: 8, ki: 0.4, kd: 0 }, level_valve: { kp: 6, ki: 0.3, kd: 0 }, temp: { kp: 0.06, ki: 0.01, kd: 0 } };
  }
  controlPairing() {
    return { level: [['pump', 0, 0], ['valve', 0, 1], ['valve', 1, 2]], temp: [[0, 0], [1, 1], [2, 2]], demand_valve_index: 2 };
  }
  idealPower(s, tsp) {
    const p = this.p, q = s.pump_flow[0]; let tot = 0;
    for (let i = 0; i < 3; i++) {
      const tin = i === 0 ? s.t_cold : tsp[i - 1];
      tot += maxv(0, RHO_CP * q * (tsp[i] - tin) + p.ua_loss * (tsp[i] - s.t_amb));
    }
    return tot;
  }
  setConfig() {}
  metadata() {
    return {
      scenario: 'cascade', topology: 'cascade', name: t('多级加热水箱链', 'Heated-Tank Cascade'), n_tanks: 3,
      tank_labels: ['T-1', 'T-2', 'T-3'],
      actuators: { pumps: [t('进料泵 P-01', 'Feed Pump P-01')], valves: [t('出料阀 V-1', 'Outlet V-1'), t('出料阀 V-2', 'Outlet V-2'), t('出料阀 V-3', 'Outlet V-3')], heaters: [t('加热器 E-1', 'Heater E-1'), t('加热器 E-2', 'Heater E-2'), t('加热器 E-3', 'Heater E-3')] },
      demand_valve_index: 2, controlled_levels: [0, 1, 2], height_max: this.heightMax,
      pump_flow_max: [0.0016], heater_max: [90000, 90000, 90000], config: {},
      trends: [
        { label: t('液位 (m)', 'Level (m)'), field: 'levels', sp: 'h_sp', spIdx: [0, 1, 2], fmt: 2 },
        { label: t('温度 (°C)', 'Temperature (°C)'), field: 'temps', sp: 't_sp', spIdx: [0, 1, 2], fmt: 0 },
        { label: t('加热功率 (kW)', 'Heater Power (kW)'), field: 'heater_power', scale: 0.001, fmt: 0 },
      ],
    };
  }
}

// ---------------- Scenario 2: Johansson quadruple tank (8 states) ----------------
// Canonical equations: K.H. Johansson, "The Quadruple-Tank Process", IEEE TCST
// 2000. h_out = a√(2g·h); pump1→γ1·tank1 + (1−γ1)·tank4, pump2→γ2·tank2 +
// (1−γ2)·tank3; upper tanks drain into the diagonal lower tank. Transmission
// zero is in the RHP (non-minimum-phase) when 0 < γ1+γ2 < 1, in the LHP when
// 1 < γ1+γ2 < 2 — set via the γ sliders. (+ a heated-tank thermal extension.)
class QuadrupleModel {
  constructor() {
    this.scenario = 'quadruple';
    this.n = 4;
    this.p = {
      area: 0.06, height_max: 0.80, a_out: [2.2e-4, 2.2e-4, 1.0e-4, 1.0e-4],
      ua_loss: 40, heater_max: [90000, 90000, 30000, 30000],
      pump_flow_max: 1.3e-3, pump_power_max: 1200, t_cold: 15, t_amb: 20, h_floor: 1e-3,
    };
    this.gamma1 = 0.70; this.gamma2 = 0.70;
  }
  actuatorCounts() { return [2, 0, 4]; }
  get heightMax() { return [0.8, 0.8, 0.8, 0.8]; }

  _out(h) { return this.p.a_out.map((a, i) => a * Math.sqrt(2 * G * maxv(h[i], 0))); }
  _inflow(act, env, T, out) {
    const p = this.p, Q1 = act.pumps[0] * p.pump_flow_max, Q2 = act.pumps[1] * p.pump_flow_max;
    const g1 = this.gamma1, g2 = this.gamma2;
    return [
      [[g1 * Q1, env.t_cold], [out[2], T[2]]],          // tank 1 <- pump1 + tank3
      [[g2 * Q2, env.t_cold], [out[3], T[3]]],          // tank 2 <- pump2 + tank4
      [[(1 - g2) * Q2, env.t_cold]],                    // tank 3 <- pump2
      [[(1 - g1) * Q1, env.t_cold]],                    // tank 4 <- pump1
    ];
  }
  derivatives(x, act, env) {
    const p = this.p, h = [x[0], x[2], x[4], x[6]], T = [x[1], x[3], x[5], x[7]];
    const out = this._out(h); out[0] += env.extra_outflow || 0;
    const inflow = this._inflow(act, env, T, out), dx = new Array(8).fill(0);
    for (let i = 0; i < 4; i++) {
      const qin = inflow[i].reduce((s, [q]) => s + q, 0);
      dx[2 * i] = (qin - out[i]) / p.area;
      const vol = p.area * maxv(h[i], p.h_floor);
      const mix = inflow[i].reduce((s, [q, tin]) => s + q * (tin - T[i]), 0);
      const pheat = act.heaters[i] * p.heater_max[i], qloss = p.ua_loss * (T[i] - env.t_amb);
      dx[2 * i + 1] = mix / vol + (pheat - qloss) / (RHO_CP * vol);
    }
    return dx;
  }
  buildState(x, act, env, t) {
    const p = this.p, h = [maxv(x[0], 0), maxv(x[2], 0), maxv(x[4], 0), maxv(x[6], 0)], T = [x[1], x[3], x[5], x[7]];
    const out = this._out(h); out[0] += env.extra_outflow || 0;
    return {
      t, levels: h, temps: T, volumes: h.map((v) => p.area * v),
      heater_power: act.heaters.map((u, i) => u * p.heater_max[i]),
      pump_flow: [act.pumps[0] * p.pump_flow_max, act.pumps[1] * p.pump_flow_max],
      pump_power: [act.pumps[0] * p.pump_power_max, act.pumps[1] * p.pump_power_max],
      tank_outflow: out, t_cold: env.t_cold, t_amb: env.t_amb,
    };
  }
  initialState() { return [0.25, 20, 0.25, 20, 0.12, 20, 0.12, 20]; }
  controlledLevels() { return [0, 1]; }
  defaultSetpoints() { return [{ 0: 0.40, 1: 0.40 }, [50, 50, 35, 35]]; }
  defaultGains() {
    return { level_pump: { kp: 6, ki: 0.25, kd: 0 }, level_valve: { kp: 0, ki: 0, kd: 0 }, temp: { kp: 0.05, ki: 0.012, kd: 0 } };
  }
  controlPairing() {
    return { level: [['pump', 0, 0], ['pump', 1, 1]], temp: [[0, 0], [1, 1], [2, 2], [3, 3]], demand_valve_index: null };
  }
  idealPower(s, tsp) {
    const p = this.p, g1 = this.gamma1, g2 = this.gamma2, Q1 = s.pump_flow[0], Q2 = s.pump_flow[1], out = s.tank_outflow;
    const inflow = [
      [[g1 * Q1, s.t_cold], [out[2], tsp[2]]], [[g2 * Q2, s.t_cold], [out[3], tsp[3]]],
      [[(1 - g2) * Q2, s.t_cold]], [[(1 - g1) * Q1, s.t_cold]],
    ];
    let tot = 0;
    for (let i = 0; i < 4; i++) {
      const mix = inflow[i].reduce((acc, [q, tin]) => acc + q * (tsp[i] - tin), 0);
      tot += maxv(0, RHO_CP * mix + p.ua_loss * (tsp[i] - s.t_amb));
    }
    return tot;
  }
  setConfig(cfg) {
    if (cfg.gamma1 != null) this.gamma1 = Math.min(0.95, Math.max(0.05, +cfg.gamma1));
    if (cfg.gamma2 != null) this.gamma2 = Math.min(0.95, Math.max(0.05, +cfg.gamma2));
  }
  metadata() {
    const phase = this.gamma1 + this.gamma2 > 1 ? t('最小相位', 'Minimum-phase') : t('非最小相位 (RHP 零点)', 'Non-minimum-phase (RHP zero)');
    return {
      scenario: 'quadruple', topology: 'quadruple', name: t('四水箱过程 (Johansson 基准)', 'Quadruple-Tank (Johansson)'), n_tanks: 4,
      tank_labels: [t('T-1 下', 'T-1 low'), t('T-2 下', 'T-2 low'), t('T-3 上', 'T-3 up'), t('T-4 上', 'T-4 up')],
      actuators: { pumps: [t('泵 P-1', 'Pump P-1'), t('泵 P-2', 'Pump P-2')], valves: [], heaters: [t('加热器 E-1', 'Heater E-1'), t('加热器 E-2', 'Heater E-2'), t('加热器 E-3', 'Heater E-3'), t('加热器 E-4', 'Heater E-4')] },
      controlled_levels: [0, 1], height_max: this.heightMax,
      pump_flow_max: [1.3e-3, 1.3e-3], heater_max: this.p.heater_max,
      config: { gamma1: +this.gamma1.toFixed(3), gamma2: +this.gamma2.toFixed(3), gamma_sum: +(this.gamma1 + this.gamma2).toFixed(3), phase },
      trends: [
        { label: t('液位 (m)', 'Level (m)'), field: 'levels', sp: 'h_sp', spIdx: [0, 1], fmt: 2 },
        { label: t('温度 (°C)', 'Temperature (°C)'), field: 'temps', sp: 't_sp', spIdx: [0, 1, 2, 3], fmt: 0 },
        { label: t('加热功率 (kW)', 'Heater Power (kW)'), field: 'heater_power', scale: 0.001, fmt: 0 },
      ],
    };
  }
}

// ---------------- Scenario 3: exothermic CSTR (2 states: Ca, T) ----------------
// Continuous stirred-tank reactor with an exothermic reaction and a cooling
// jacket. The control job: hold reactor temperature by adjusting cooling; too
// little cooling -> the Arrhenius feedback runs the temperature away (classic
// thermal runaway). MVs: cooling duty (reverse-acting on T) + feed flow.
class CSTRModel {
  constructor() {
    this.scenario = 'cstr'; this.n = 1; this.dtMicro = 0.01;
    this.p = {
      Dmax: 0.02, Caf: 1.0, k0: 1e8, EaR: 7000, Hr: 120, Uc: 0.05, Tcool: 10,
      cool_max: 80000, feed_power_max: 1200, t_cold: 20, t_amb: 20, h_floor: 1e-3,
    };
  }
  actuatorCounts() { return [1, 0, 1]; }        // [feed pump] [-] [cooling]
  get heightMax() { return [1]; }
  _rate(Ca, T) { return this.p.k0 * Math.exp(-this.p.EaR / (T + 273.15)) * maxv(Ca, 0); }
  derivatives(x, act, env) {
    const p = this.p, Ca = x[0], T = x[1];
    const D = act.pumps[0] * p.Dmax, uc = act.heaters[0], r = this._rate(Ca, T);
    return [
      D * (p.Caf - Ca) - r,
      D * (env.t_cold - T) + p.Hr * r - p.Uc * uc * (T - p.Tcool),
    ];
  }
  buildState(x, act, env, t) {
    const p = this.p, Ca = maxv(x[0], 0), T = x[1], D = act.pumps[0] * p.Dmax;
    return {
      t, levels: [], temps: [T], volumes: [], conc: [Ca],
      heater_power: [act.heaters[0] * p.cool_max],
      pump_flow: [D], pump_power: [act.pumps[0] * p.feed_power_max],
      tank_outflow: [D], t_cold: env.t_cold, t_amb: env.t_amb,
    };
  }
  initialState() { return [0.5, 50]; }   // warm start near the operating point
  clampState(x) { if (x[0] < 0) x[0] = 0; if (x[1] > 200) x[1] = 200; return x; }
  controlledLevels() { return []; }
  defaultSetpoints() { return [{}, [60]]; }
  defaultGains() { return { level_pump: { kp: 0, ki: 0, kd: 0 }, level_valve: { kp: 0, ki: 0, kd: 0 }, temp: { kp: 0.08, ki: 0.02, kd: 0 } }; }
  controlPairing() {
    // cooling controls reactor temperature (reverse-acting: hotter -> cool more);
    // feed is held at a nominal rate by the auto-controller.
    return { level: [], temp: [[0, 0, true]], demand_valve_index: null, holds: [['pump', 0, 0.5]] };
  }
  idealPower() { return 0; }
  energyScored() { return false; }
  safety() { return { dryFire: false, overflow: false, overTempAction: 'pump' }; }
  setConfig() {}
  metadata() {
    return {
      scenario: 'cstr', topology: 'cstr', name: t('放热反应器 CSTR', 'Exothermic CSTR'), n_tanks: 1,
      tank_labels: [t('R-1 反应器', 'R-1 reactor')],
      actuators: { pumps: [t('进料', 'Feed')], valves: [], heaters: [t('冷却', 'Cooling')] },
      controlled_levels: [], height_max: [1],
      pump_flow_max: [this.p.Dmax], heater_max: [this.p.cool_max], config: {},
      trends: [
        { label: t('反应器温度 (°C)', 'Reactor Temp (°C)'), field: 'temps', sp: 't_sp', spIdx: [0], fmt: 1 },
        { label: t('反应物浓度 Cₐ (mol/L)', 'Concentration Cₐ (mol/L)'), field: 'conc', fmt: 3 },
        { label: t('冷却功率 (kW)', 'Cooling Power (kW)'), field: 'heater_power', scale: 0.001, fmt: 1 },
      ],
    };
  }
}

// ---------------- Scenario 4: two-zone HVAC (2 states: T1, T2) ----------------
// Two coupled rooms, each with an HVAC unit that can heat or cool (command 0.5
// = off). Hold both room temperatures against a cold/hot outdoor disturbance and
// the heat leaking between zones. Linear, easy, relatable — a good entry env.
class HVACModel {
  constructor() {
    this.scenario = 'hvac'; this.n = 2; this.dtMicro = 0.02;
    this.p = { C: 6000, Pmax: 1800, Kc: 35, Ko: 45, t_cold: 5, t_amb: 5, h_floor: 1e-3 };
  }
  actuatorCounts() { return [0, 0, 2]; }
  get heightMax() { return [1, 1]; }
  _power(u) { return (u - 0.5) * 2 * this.p.Pmax; }          // 0.5 = off, <0.5 cool, >0.5 heat
  derivatives(x, act, env) {
    const p = this.p, T1 = x[0], T2 = x[1], Tout = env.t_amb;
    const P1 = this._power(act.heaters[0]), P2 = this._power(act.heaters[1]);
    return [
      (P1 + p.Kc * (T2 - T1) + p.Ko * (Tout - T1)) / p.C,
      (P2 + p.Kc * (T1 - T2) + p.Ko * (Tout - T2)) / p.C,
    ];
  }
  buildState(x, act, env, t) {
    return {
      t, levels: [], temps: [x[0], x[1]], volumes: [],
      heater_power: [Math.abs(this._power(act.heaters[0])), Math.abs(this._power(act.heaters[1]))],
      pump_flow: [], pump_power: [], tank_outflow: [], t_cold: env.t_cold, t_amb: env.t_amb,
    };
  }
  initialState() { return [10, 10]; }
  clampState(x) { return x; }
  controlledLevels() { return []; }
  defaultSetpoints() { return [{}, [22, 22]]; }
  defaultGains() { return { level_pump: { kp: 0, ki: 0, kd: 0 }, level_valve: { kp: 0, ki: 0, kd: 0 }, temp: { kp: 0.18, ki: 0.03, kd: 0 } }; }
  controlPairing() { return { level: [], temp: [[0, 0], [1, 1]], demand_valve_index: null }; }
  idealPower() { return 0; }
  energyScored() { return false; }
  safety() { return { dryFire: false, overflow: false, overTempAction: 'heater' }; }
  setConfig() {}
  metadata() {
    return {
      scenario: 'hvac', topology: 'hvac', name: t('双区 HVAC 温控', 'Two-Zone HVAC'), n_tanks: 2,
      tank_labels: [t('Z-1 房间', 'Z-1 room'), t('Z-2 房间', 'Z-2 room')],
      actuators: { pumps: [], valves: [], heaters: ['HVAC Z-1', 'HVAC Z-2'] },
      controlled_levels: [], height_max: [1, 1],
      pump_flow_max: [], heater_max: [this.p.Pmax * 2, this.p.Pmax * 2], config: {},
      trends: [
        { label: t('室温 (°C)', 'Room Temp (°C)'), field: 'temps', sp: 't_sp', spIdx: [0, 1], fmt: 1 },
        { label: t('HVAC 功率 (kW)', 'HVAC Power (kW)'), field: 'heater_power', scale: 0.001, fmt: 2 },
      ],
    };
  }
}

const MODELS = { cascade: CascadeModel, quadruple: QuadrupleModel, cstr: CSTRModel, hvac: HVACModel };
export function makeModel(scenario) {
  const M = MODELS[scenario] || CascadeModel;
  return new M();
}
export const SCENARIOS = Object.keys(MODELS);
export const RHOCP = RHO_CP;
export { clamp01 };
