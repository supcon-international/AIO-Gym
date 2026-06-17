// KPIs + composite 0-100 score — JS port. Tracking (temp/level), wasted energy
// (excess over the model's ideal steady-state power, so the necessary baseline
// is free), and time spent interlocked. Level error counts only controlled
// levels; temp error counts every heated tank.

const W_TEMP = 2.0, W_LEVEL = 80, W_ENERGY = 0.5, W_SAFETY = 60;
const r = (v, d = 2) => +v.toFixed(d);

export class ScoreKeeper {
  constructor(model) { this.bind(model); }
  bind(model) {
    this.model = model; this.n = model.n; this.ctrl = model.controlledLevels();
    this.scoreEnergy = model.energyScored ? model.energyScored() : true;
    this.reset();
  }
  reset() {
    this.elapsed = 0; this.iaeT = 0; this.iaeL = 0; this.energy = 0; this.excess = 0;
    this.alarmSec = 0; this.interlockSec = 0; this.trips = 0; this.prevIl = false;
    this.instT = new Array(this.n).fill(0); this.instL = new Array(this.ctrl.length).fill(0);
  }

  update(s, sp, mask, nAlarms, dt) {
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
  }

  report() {
    const e = Math.max(this.elapsed, 1e-6), hours = e / 3600, nL = Math.max(1, this.ctrl.length);
    const avgT = this.iaeT / (e * this.n), avgL = this.iaeL / (e * nL);
    const avgP = hours > 0 ? this.energy / hours : 0, avgX = hours > 0 ? this.excess / hours : 0;
    const sFrac = this.interlockSec / e;
    const pT = W_TEMP * avgT, pL = W_LEVEL * avgL, pE = this.scoreEnergy ? W_ENERGY * avgX : 0, pS = W_SAFETY * sFrac;
    const score = Math.max(0, Math.min(100, 100 - pT - pL - pE - pS));
    return {
      elapsed: r(this.elapsed, 1), score: r(score, 1),
      components: { tracking_temp: r(pT, 1), tracking_level: r(pL, 1), energy: r(pE, 1), safety: r(pS, 1) },
      kpis: {
        avg_temp_err: r(avgT), avg_level_err_cm: r(avgL * 100), energy_kwh: r(this.energy, 3),
        avg_power_kw: r(avgP), excess_kwh: r(this.excess, 3), interlock_seconds: r(this.interlockSec, 1), trip_events: this.trips,
      },
      inst_temp_err: this.instT.map((x) => r(x)), inst_level_err: this.instL.map((x) => r(x, 3)),
    };
  }
}
