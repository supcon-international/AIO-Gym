// Fixed-step RK4 integrator (browser kernel). Integrates the same `derivatives`
// the Python reference uses; replaces PathSim for the client-side build. The
// system is tiny (6-8 ODEs) so plain JS runs it millions of steps/s — no WASM
// needed. Sub-steps internally for deterministic, stable integration.

export class Integrator {
  // Each model may declare its own micro-step (stiffer scenarios use a finer one)
  // and an optional state clamp (e.g. concentration >= 0). Defaults keep the
  // tank scenarios exactly as before.
  constructor(model) { this.model = model; this.dtMicro = model.dtMicro || 0.02; this.reset(); }

  reset(state) {
    this.x = (state || this.model.initialState()).slice();
    this.t = 0;
  }

  step(dt, act, env) {
    const m = this.model, f = (x) => m.derivatives(x, act, env);
    const nsub = Math.max(1, Math.ceil(dt / this.dtMicro - 1e-9)), h = dt / nsub;
    for (let s = 0; s < nsub; s++) {
      const x = this.x;
      const k1 = f(x);
      const k2 = f(x.map((v, i) => v + 0.5 * h * k1[i]));
      const k3 = f(x.map((v, i) => v + 0.5 * h * k2[i]));
      const k4 = f(x.map((v, i) => v + h * k3[i]));
      this.x = x.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
      if (m.clampState) this.x = m.clampState(this.x);
      this.t += h;
    }
    return m.buildState(this.x, act, env, this.t);
  }

  getState(act, env, t) { return this.model.buildState(this.x, act, env, t); }
}
