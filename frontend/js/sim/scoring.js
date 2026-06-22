// KPIs + composite 0-100 score — JS port. Tracking (temp/level), wasted energy
// (excess over the model's ideal steady-state power, so the necessary baseline
// is free), and time spent interlocked. Level error counts only controlled
// levels; temp error counts every heated tank.

const W_TEMP = 2.0, W_LEVEL = 80, W_ENERGY = 0.5, W_SAFETY = 60;
const r = (v, d = 2) => +v.toFixed(d);

// Economic objective (mirrors aiogym/env.py ECON): value − energy-cost − soft-band
// violation. Controlled vars have soft acceptance bands (not a fixed SP); within the
// band, economics are optimised. This is the metric the RL policies actually optimise
// — so a fixed-SP PID/MPC scores low here while the (工况-adaptive) RL scores high.
const ECON = {
  cascade:   { temp_band: [[33, null], [46, null], [58, null]], level_band: [[0.30, 0.62], [0.30, 0.62], [0.30, 0.62]], value: 'none', w_value: 0.0, w_energy: 0.9, w_viol: 6.0 },
  quadruple: { temp_band: [[46, null], [46, null], [32, null], [32, null]], level_band: [[0.30, 0.60], [0.30, 0.60]], value: 'none', w_value: 0.0, w_energy: 0.9, w_viol: 6.0 },
  cstr:      { temp_band: [[null, 88]], level_band: [], value: 'production', w_value: 900.0, w_energy: 0.4, w_viol: 8.0 },
  hvac:      { temp_band: [[20, 24], [20, 24]], level_band: [], value: 'none', w_value: 0.0, w_energy: 1.2, w_viol: 7.0 },
};
// Per-scenario [worst, best] profit-rate (per control step) for a 0-100 economic score.
// worst ≈ fixed-SP PID, best ≈ the economic optimum the RL targets (from aiogym/runs).
const ECON_REF = { cascade: [-220, -60], quadruple: [-185, -55], cstr: [-3.0, 4.0], hvac: [-5.0, -3.4] };

export class ScoreKeeper {
  constructor(model) { this.bind(model); }
  bind(model) {
    this.model = model; this.n = model.n; this.ctrl = model.controlledLevels();
    this.scoreEnergy = model.energyScored ? model.energyScored() : true;
    this.scenario = model.metadata ? model.metadata().scenario : 'cascade';
    this.econ = ECON[this.scenario] || ECON.cascade;
    this.econRef = ECON_REF[this.scenario] || ECON_REF.cascade;
    this.reset();
  }
  reset() {
    this.elapsed = 0; this.iaeT = 0; this.iaeL = 0; this.energy = 0; this.excess = 0;
    this.alarmSec = 0; this.interlockSec = 0; this.trips = 0; this.prevIl = false;
    this.instT = new Array(this.n).fill(0); this.instL = new Array(this.ctrl.length).fill(0);
    this.econProfit = 0; this.econSteps = 0; this.prod = 0; this.econEMA = null;
  }

  update(s, sp, mask, nAlarms, dt, act) {
    this.elapsed += dt;
    const te = s.temps.map((T, i) => Math.abs(T - sp.t_sp[i]));
    const le = this.ctrl.map((i) => Math.abs(s.levels[i] - sp.h_sp[i]));
    this.instT = te; this.instL = le;
    this.iaeT += te.reduce((a, b) => a + b, 0) * dt;
    this.iaeL += le.reduce((a, b) => a + b, 0) * dt;
    const heat = s.heater_power.reduce((a, b) => a + b, 0);
    this.energy += (heat + s.pump_power.reduce((a, b) => a + b, 0)) * dt / 3.6e6;
    if (this.scoreEnergy) this.excess += Math.max(0, heat - this.model.idealPower(s, sp.t_sp)) * dt / 3.6e6;
    if (nAlarms > 0) this.alarmSec += dt;
    const il = mask.pump_trip || mask.heater_trip.some(Boolean);
    if (il) { this.interlockSec += dt; if (!this.prevIl) this.trips++; }
    this.prevIl = il;
    this._economic(s, heat, act);
  }

  // Per-step economic profit (mirrors aiogym _economic_profit): value − energy − band-violation.
  _economic(s, heat, act) {
    const c = this.econ, p = this.model.p || {};
    let value = 0, prod = 0;
    if (c.value === 'production' && act) {
      const Ca = (s.conc && s.conc[0] != null) ? s.conc[0] : 0;
      const D = (act.pumps[0] || 0) * (p.Dmax || 0);
      prod = D * ((p.Caf || 0) - Ca);
      value = prod;
    }
    this.prod = prod;
    const energyKw = heat / 1000;
    let viol = 0;
    for (let i = 0; i < c.temp_band.length; i++) {
      const [lo, hi] = c.temp_band[i], T = s.temps[i];
      if (lo != null && T < lo) viol += (lo - T) / 10;
      if (hi != null && T > hi) viol += (T - hi) / 10;
    }
    this.ctrl.forEach((idx, j) => {
      const b = c.level_band[j]; if (!b) return;
      const [lo, hi] = b, L = s.levels[idx];
      if (lo != null && L < lo) viol += (lo - L) / 0.1;
      if (hi != null && L > hi) viol += (L - hi) / 0.1;
    });
    const profit = c.w_value * value - c.w_energy * energyKw - c.w_viol * viol;
    this.econProfit += profit; this.econSteps += 1;
    // EMA (~100-step window) for the live score: reflects steady-state, not the
    // start-up transient (e.g. HVAC heating from 10°C into the comfort band).
    this.econEMA = this.econEMA == null ? profit : 0.99 * this.econEMA + 0.01 * profit;
  }

  report() {
    const e = Math.max(this.elapsed, 1e-6), hours = e / 3600, nL = Math.max(1, this.ctrl.length);
    const avgT = this.iaeT / (e * this.n), avgL = this.iaeL / (e * nL);
    const avgP = hours > 0 ? this.energy / hours : 0, avgX = hours > 0 ? this.excess / hours : 0;
    const sFrac = this.interlockSec / e;
    const pT = W_TEMP * avgT, pL = W_LEVEL * avgL, pE = this.scoreEnergy ? W_ENERGY * avgX : 0, pS = W_SAFETY * sFrac;
    const score = Math.max(0, Math.min(100, 100 - pT - pL - pE - pS));
    // economic score: recent (EMA) profit-rate mapped to 0-100 against [worst-PID, best-optimum]
    const rate = this.econEMA != null ? this.econEMA : (this.econSteps > 0 ? this.econProfit / this.econSteps : 0);
    const [lo, hi] = this.econRef;
    const econScore = Math.max(0, Math.min(100, 100 * (rate - lo) / (hi - lo)));
    return {
      elapsed: r(this.elapsed, 1), score: r(score, 1), econ_score: r(econScore, 1),
      components: { tracking_temp: r(pT, 1), tracking_level: r(pL, 1), energy: r(pE, 1), safety: r(pS, 1) },
      kpis: {
        avg_temp_err: r(avgT), avg_level_err_cm: r(avgL * 100), energy_kwh: r(this.energy, 3),
        avg_power_kw: r(avgP), excess_kwh: r(this.excess, 3), interlock_seconds: r(this.interlockSec, 1), trip_events: this.trips,
      },
      econ: { score: r(econScore, 1), profit_rate: r(rate, 2), production: r(this.prod * 1000, 2), value: this.econ.value },
      inst_temp_err: this.instT.map((x) => r(x)), inst_level_err: this.instL.map((x) => r(x, 3)),
    };
  }
}
