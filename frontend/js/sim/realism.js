// Instrumentation & actuation realism layer — turns the ideal plant I/O into a
// real one. What a CONTROLLER sees is a MEASUREMENT (transport delay/deadtime,
// sensor lag, noise, bias + slow drift, quantization); what it COMMANDS is
// delivered IMPERFECTLY (slew-rate limit, valve stiction/deadband, resolution,
// saturation). The UI keeps showing the true state — the gap between what the
// instrument reads and what is real is exactly what makes control hard on a
// real plant. `level` scales every imperfection: 0 = ideal passthrough, 1 =
// realistic, >1 = harsher (for stress tests).

const gauss = (s) => { if (s <= 0) return 0; const u = 1 - Math.random(), v = Math.random(); return s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const quantize = (v, q) => (q > 0 ? Math.round(v / q) * q : v);

// Base (level=1) profiles per signal type. Chosen moderate: clearly real, still
// controllable by the stock PID. delay/tau in seconds; noise/drift/quant in the
// signal's own units.
const SENSOR = {
  lev: { delay: 0.4, tau: 0.8, noise: 0.0015, drift: 0.00004, quant: 0.001 },   // level (m)
  tmp: { delay: 0.8, tau: 1.5, noise: 0.08, drift: 0.0015, quant: 0.05 },        // temperature (°C)
  cnc: { delay: 2.5, tau: 3.0, noise: 0.004, drift: 0.0, quant: 0.001 },         // analyzer (mol/L) — slow
};
const ACT = { slew: 1.5, stiction: 0.008, quant: 0.004 };                         // valve/pump/heater command [0,1]

// One sensor channel: delay buffer -> first-order lag -> bias/drift -> noise -> quantize.
class Sensor {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.buf = []; this.y = null; this.bias = 0; }
  update(x, t, dt, lvl) {
    const c = this.cfg, delay = c.delay * lvl, tau = c.tau * lvl;
    this.buf.push([t, x]);
    while (this.buf.length > 1 && this.buf[1][0] <= t - delay) this.buf.shift();
    const delayed = this.buf[0][1];
    if (this.y == null) this.y = delayed;
    const a = tau > 1e-6 ? 1 - Math.exp(-dt / tau) : 1;
    this.y += (delayed - this.y) * a;
    this.bias += gauss(c.drift * lvl) * Math.sqrt(Math.max(dt, 1e-6));
    return quantize(this.y + this.bias + gauss(c.noise * lvl), c.quant);
  }
}

// One actuator channel: stiction deadband -> slew-rate limit -> quantize -> saturate.
class Actuator {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.pos = null; }
  update(cmd, dt, lvl) {
    const c = this.cfg, stiction = c.stiction * lvl, slew = c.slew * lvl;
    if (this.pos == null) this.pos = cmd;
    let target = cmd;
    if (Math.abs(cmd - this.pos) < stiction) target = this.pos;     // stuck until command moves past the deadband
    if (slew > 1e-6) { const dmax = dt / slew, d = target - this.pos; this.pos += Math.max(-dmax, Math.min(dmax, d)); }
    else this.pos = target;
    return quantize(clamp01(this.pos), c.quant);
  }
}

export class Realism {
  constructor(model, level = 1) { this.level = level; this.bind(model); }
  bind() { this.s = { lev: [], tmp: [], cnc: [] }; this.a = { pumps: [], valves: [], heaters: [] }; }
  reset() { this.bind(); }
  setLevel(l) { this.level = Math.max(0, +l || 0); }

  _sense(arr, store, cfg, t, dt) {
    while (store.length < arr.length) store.push(new Sensor(cfg));
    return arr.map((x, i) => store[i].update(x, t, dt, this.level));
  }
  _act(arr, store, dt) {
    while (store.length < arr.length) store.push(new Actuator(ACT));
    return arr.map((x, i) => store[i].update(x, dt, this.level));
  }

  // True state -> what the controller measures.
  measure(state, dt) {
    if (this.level <= 1e-3) return state;
    const t = state.t, m = { ...state };
    m.levels = this._sense(state.levels, this.s.lev, SENSOR.lev, t, dt);
    m.temps = this._sense(state.temps, this.s.tmp, SENSOR.tmp, t, dt);
    if (state.conc) m.conc = this._sense(state.conc, this.s.cnc, SENSOR.cnc, t, dt);
    return m;
  }
  // Commanded action -> what the actuator actually delivers.
  actuate(act, dt) {
    if (this.level <= 1e-3) return act;
    return {
      pumps: this._act(act.pumps, this.a.pumps, dt),
      valves: this._act(act.valves, this.a.valves, dt),
      heaters: this._act(act.heaters, this.a.heaters, dt),
    };
  }
}
