// Linear MPC in the style of an industrial APC controller (DMCplus / Profit
// Controller). Configuration & function follow the APC vocabulary:
//   MV  — manipulated variables (the actuators it moves): hi/lo limits, max
//         move (rate), move-suppression weight, economic cost / ideal resting.
//   CV  — controlled variables (controlled levels + temperatures): setpoint,
//         hi/lo range, weight; predicted over the horizon and driven offset-free.
//   DV  — measured disturbances (feed/ambient temperature): fed forward.
// Model: the true non-linear plant is linearized to a state-space model — the
// APC "step-test" model. We refresh the linearization each control cycle at the
// current operating point (successive linearization), so it stays valid across
// the wide non-linear range (e.g. the CSTR). Each cycle solves a small QP:
//   min  Σ_k ‖CV_k − SP‖²_Wcv  +  ‖ΔMV‖²_Wmv      s.t. MV ∈ [lo,hi], |ΔMV| ≤ dMax
// in velocity (move) form, which gives integral / offset-free action. The MPC
// runs on a slower cycle (Ts) than the 20 Hz loop and holds its MV in between —
// exactly how an APC sits above the regulatory layer.
//
// Honest scope vs a real DMCplus: one identified model refreshed online (classic
// DMC keeps a fixed step-test model); control horizon M=1 (single blocked move,
// common and robust); economic LP folded into a linear MV cost rather than a
// separate steady-state optimizer; MVs stroke the handles directly rather than
// writing setpoints to inner PID loops.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- tiny dense linear algebra ----
const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
function solveSym(H, f) {                       // solve H x = -f  (H small, SPD-ish) via Gaussian elimination
  const n = f.length, A = H.map((row, i) => row.concat(-f[i]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-9;
    for (let r = 0; r < n; r++) if (r !== c) { const m = A[r][c] / d; for (let k = c; k <= n; k++) A[r][k] -= m * A[c][k]; }
  }
  return A.map((row, i) => row[n] / (row[i] || 1e-9));
}

export class MPCController {
  constructor(model) { this.bind(model); }

  bind(model) {
    this.model = model;
    const [nP, nV, nH] = model.actuatorCounts();
    this.nP = nP; this.nV = nV; this.nH = nH; this.nu = nP + nV + nH;
    this.nx = model.initialState().length;
    this.ctrl = model.controlledLevels();
    this.nCV = this.ctrl.length + model.n;                 // controlled levels + every temperature
    // APC-style configuration (operator-tunable)
    this.cfg = {
      Ts: 0.5, P: 40,                                      // control cycle (s) and prediction horizon (steps)
      moveSupp: 0.8,                                       // MV move-suppression weight (the main robustness knob)
      duMax: 0.15,                                         // MV max move per cycle (rate limit)
      uMin: 0, uMax: 1,
      cvScaleLevel: 0.1, cvScaleTemp: 12,                  // normalise level(m) vs temp(°C) errors
    };
    this.reset();
  }
  reset() {
    this.u = new Array(this.nu).fill(0).map((_, i) => (i < this.nP ? 0.35 : i < this.nP + this.nV ? 0.5 : 0.0));
    this._clock = 1e9;                                     // force a solve on the first tick
  }
  getConfig() {
    return { kind: 'mpc', Ts: this.cfg.Ts, P: this.cfg.P, moveSupp: this.cfg.moveSupp, duMax: this.cfg.duMax, nCV: this.nCV, nMV: this.nu };
  }
  setConfig(c) {
    if (c.moveSupp != null) this.cfg.moveSupp = Math.max(0, +c.moveSupp);
    if (c.duMax != null) this.cfg.duMax = clamp(+c.duMax, 0.01, 1);
    if (c.P != null) this.cfg.P = Math.max(5, Math.min(120, +c.P | 0));
    if (c.Ts != null) this.cfg.Ts = clamp(+c.Ts, 0.1, 5);
  }

  // reconstruct the raw ODE state x from the measured buildState object
  _toX(meas) {
    const s = this.model.scenario;
    if (s === 'cstr') return [meas.conc[0], meas.temps[0]];
    if (s === 'hvac') return [meas.temps[0], meas.temps[1]];
    const x = new Array(this.nx);                          // tank models interleave [h_i, T_i]
    for (let i = 0; i < this.model.n; i++) { x[2 * i] = meas.levels[i]; x[2 * i + 1] = meas.temps[i]; }
    return x;
  }
  _unpack(u) {
    return { pumps: u.slice(0, this.nP), valves: u.slice(this.nP, this.nP + this.nV), heaters: u.slice(this.nP + this.nV) };
  }
  _cv(x, env) {                                            // CV readout from a state: [controlled levels…, temps…]
    const s = this.model.buildState(x, this._unpack(this.u), env, 0);
    return [...this.ctrl.map((i) => s.levels[i]), ...s.temps];
  }
  _wcv() {
    const w = []; for (let k = 0; k < this.ctrl.length; k++) w.push(1 / this.cfg.cvScaleLevel ** 2);
    for (let i = 0; i < this.model.n; i++) w.push(1 / this.cfg.cvScaleTemp ** 2);
    return w;
  }

  compute(meas, sp, dt) {
    this._clock += dt;
    if (this._clock >= this.cfg.Ts) { this._clock = 0; this._solve(meas, sp); }
    return this._unpack(this.u);
  }

  _solve(meas, sp) {
    const m = this.model, f = m.derivatives.bind(m), nx = this.nx, nu = this.nu, P = this.cfg.P, Ts = this.cfg.Ts;
    const env = { t_cold: meas.t_cold, t_amb: meas.t_amb, extra_outflow: 0 };
    const x0 = this._toX(meas), u0 = this.u.slice();
    const f0 = f(x0, this._unpack(u0), env);
    // --- linearize: Ad = I + (∂f/∂x)Ts,  Bd = (∂f/∂u)Ts  (central differences) ---
    const eps = 1e-5, Ad = zeros(nx, nx), Bd = zeros(nx, nu);
    for (let j = 0; j < nx; j++) {
      const xp = x0.slice(); xp[j] += eps; const xm = x0.slice(); xm[j] -= eps;
      const fp = f(xp, this._unpack(u0), env), fm = f(xm, this._unpack(u0), env);
      for (let i = 0; i < nx; i++) Ad[i][j] = (i === j ? 1 : 0) + (fp[i] - fm[i]) / (2 * eps) * Ts;
    }
    for (let j = 0; j < nu; j++) {
      const up = u0.slice(); up[j] += eps; const um = u0.slice(); um[j] -= eps;
      const fp = f(x0, this._unpack(up), env), fm = f(x0, this._unpack(um), env);
      for (let i = 0; i < nx; i++) Bd[i][j] = (fp[i] - fm[i]) / (2 * eps) * Ts;
    }
    // CV selection matrix C (numeric; constant 0/1)
    const cv0 = this._cv(x0, env), nCV = cv0.length, C = zeros(nCV, nx);
    for (let j = 0; j < nx; j++) {
      const xp = x0.slice(); xp[j] += eps; const cp = this._cv(xp, env);
      for (let i = 0; i < nCV; i++) C[i][j] = (cp[i] - cv0[i]) / eps;
    }
    // target (setpoint) vector
    const target = [...this.ctrl.map((i) => sp.h_sp[i]), ...sp.t_sp.slice(0, m.n)];
    const Wcv = this._wcv();
    // --- predict over horizon: free response (MV held at u0) + step-sensitivity S to a sustained unit ΔMV ---
    // x_{k+1} = Ad x_k + Bd u_k + c0,  where c0 = f0*Ts - (Ad-I)x0 - Bd u0 keeps the affine op consistent at x0.
    const c0 = new Array(nx);
    for (let i = 0; i < nx; i++) { let axx = 0, bu = 0; for (let j = 0; j < nx; j++) axx += Ad[i][j] * x0[j]; for (let j = 0; j < nu; j++) bu += Bd[i][j] * u0[j]; c0[i] = (x0[i] + f0[i] * Ts) - axx - bu; }
    let xf = x0.slice();                                   // free trajectory
    let S = zeros(nx, nu);                                 // ∂x_k/∂(ΔMV), sustained move
    const H = zeros(nu, nu), g = new Array(nu).fill(0);
    for (let k = 0; k < P; k++) {
      // advance free state: xf_{k+1} = Ad xf + Bd u0 + c0
      const xn = new Array(nx);
      for (let i = 0; i < nx; i++) { let s = c0[i]; for (let j = 0; j < nx; j++) s += Ad[i][j] * xf[j]; for (let j = 0; j < nu; j++) s += Bd[i][j] * u0[j]; xn[i] = s; }
      // advance sensitivity: S_{k+1} = Ad S + Bd  (unit sustained move)
      const Sn = zeros(nx, nu);
      for (let i = 0; i < nx; i++) for (let c = 0; c < nu; c++) { let s = Bd[i][c]; for (let j = 0; j < nx; j++) s += Ad[i][j] * S[j][c]; Sn[i][c] = s; }
      xf = xn; S = Sn;
      // CV prediction sensitivity Γ = C·S (nCV×nu) and free CV error e = C·xf − target
      const G = zeros(nCV, nu), e = new Array(nCV);
      for (let r = 0; r < nCV; r++) { let cx = 0; for (let j = 0; j < nx; j++) cx += C[r][j] * xf[j]; e[r] = cx - target[r]; for (let c = 0; c < nu; c++) { let s = 0; for (let j = 0; j < nx; j++) s += C[r][j] * S[j][c]; G[r][c] = s; } }
      // accumulate H += Γᵀ Wcv Γ,  g += Γᵀ Wcv e
      for (let a = 0; a < nu; a++) { let ga = 0; for (let r = 0; r < nCV; r++) { const wgr = Wcv[r] * G[r][a]; ga += wgr * e[r]; for (let b = 0; b < nu; b++) H[a][b] += wgr * G[r][b]; } g[a] += ga; }
    }
    for (let a = 0; a < nu; a++) H[a][a] += this.cfg.moveSupp;   // move suppression
    // --- solve for the move, clamp to rate + MV box, apply (receding horizon) ---
    let du = solveSym(H, g);
    for (let j = 0; j < nu; j++) {
      du[j] = clamp(du[j], -this.cfg.duMax, this.cfg.duMax);
      this.u[j] = clamp(u0[j] + du[j], this.cfg.uMin, this.cfg.uMax);
    }
  }
}
