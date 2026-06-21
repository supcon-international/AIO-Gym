"""PID and APC-style MPC baselines for the native env — ports of
frontend/js/sim/{controllers.js (PIDController), mpc.js}. Same control law, so a
fair head-to-head against the RL policy on the same dynamics + reward.

Agents share the JS controller interface:  compute(meas, sp, dt) -> action dict
  meas = {levels, temps, conc?, t_cold, t_amb}     (a measured buildState)
  sp   = {h_sp: [...n], t_sp: [...n]}
  action = {pumps, valves, heaters}
`evaluate()` runs an agent on an AIOGymNativeEnv and returns the mean return.
"""
from __future__ import annotations
import numpy as np


def _clip01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


# ---- per-scenario control pairing + default PID gains (mirror models.js) ----
GAINS = {
    "cascade": {"level_pump": (8.0, 0.4, 0.0), "level_valve": (6.0, 0.3, 0.0), "temp": (0.06, 0.01, 0.0)},
    "quadruple": {"level_pump": (6.0, 0.25, 0.0), "level_valve": (0.0, 0.0, 0.0), "temp": (0.05, 0.012, 0.0)},
    "cstr": {"level_pump": (0.0, 0.0, 0.0), "level_valve": (0.0, 0.0, 0.0), "temp": (0.08, 0.02, 0.0)},
    "hvac": {"temp": (0.18, 0.03, 0.0)},
}
PAIRING = {
    "cascade": {"level": [("pump", 0, 0), ("valve", 0, 1), ("valve", 1, 2)],
                "temp": [(0, 0, False), (1, 1, False), (2, 2, False)], "demand_valve_index": 2, "holds": []},
    "quadruple": {"level": [("pump", 0, 0), ("pump", 1, 1)],
                  "temp": [(0, 0, False), (1, 1, False), (2, 2, False), (3, 3, False)], "demand_valve_index": None, "holds": []},
    "cstr": {"level": [], "temp": [(0, 0, True)], "demand_valve_index": None, "holds": [("pump", 0, 0.5)]},
    "hvac": {"level": [], "temp": [(0, 0, False), (1, 1, False)], "demand_valve_index": None, "holds": []},
}


class PIDLoop:
    def __init__(self, g, reverse=False):
        self.kp, self.ki, self.kd = g
        self.reverse = reverse
        self.reset()

    def reset(self):
        self.i = 0.0
        self.prev = None

    def update(self, sp, meas, dt):
        e = (meas - sp) if self.reverse else (sp - meas)
        dmeas = 0.0 if (self.prev is None or dt <= 0) else (meas - self.prev) / dt
        self.prev = meas
        p = self.kp * e
        d = (1.0 if self.reverse else -1.0) * self.kd * dmeas
        i_cand = self.i + self.ki * e * dt
        raw = p + i_cand + d
        out = _clip01(raw)
        if not ((raw > 1 and e > 0) or (raw < 0 and e < 0)):
            self.i = i_cand
        return out


class PIDAgent:
    name = "PID"

    def __init__(self, model):
        self.model = model
        self.nP, self.nV, self.nH = model.actuator_counts()
        g = GAINS[model.scenario]
        pr = PAIRING[model.scenario]
        self.demand_idx = pr["demand_valve_index"]
        self.demand_valve = 0.5
        self.holds = pr["holds"]
        self.level_loops = [(kind, ai, li, PIDLoop(g["level_pump" if kind == "pump" else "level_valve"], False))
                            for (kind, ai, li) in pr["level"]]
        self.temp_loops = [(hi, ti, PIDLoop(g["temp"], rev)) for (hi, ti, rev) in pr["temp"]]

    def reset(self):
        for *_, loop in self.level_loops:
            loop.reset()
        for *_, loop in self.temp_loops:
            loop.reset()

    def compute(self, meas, sp, dt):
        act = {"pumps": [0.0] * self.nP, "valves": [0.0] * self.nV, "heaters": [0.0] * self.nH}
        for kind, idx, value in self.holds:
            arr = {"pump": act["pumps"], "valve": act["valves"], "heater": act["heaters"]}[kind]
            if idx < len(arr):
                arr[idx] = value
        for kind, ai, li, loop in self.level_loops:
            out = loop.update(sp["h_sp"][li], meas["levels"][li], dt)
            (act["pumps"] if kind == "pump" else act["valves"])[ai] = out
        if self.demand_idx is not None and self.nV:
            act["valves"][self.demand_idx] = self.demand_valve
        for hi, ti, loop in self.temp_loops:
            act["heaters"][hi] = loop.update(sp["t_sp"][ti], meas["temps"][ti], dt)
        return act


class MPCAgent:
    """Successive-linearization, velocity-form (M=1) constrained MPC — port of mpc.js."""
    name = "MPC"

    def __init__(self, model, Ts=0.5, P=40, move_supp=0.8, du_max=0.15,
                 cv_scale_level=0.1, cv_scale_temp=12.0):
        self.m = model
        self.nP, self.nV, self.nH = model.actuator_counts()
        self.nu = self.nP + self.nV + self.nH
        self.nx = len(model.initial_state())
        self.ctrl = model.controlled_levels()
        self.Ts, self.P, self.move_supp, self.du_max = Ts, P, move_supp, du_max
        self.csl, self.cst = cv_scale_level, cv_scale_temp
        self.reset()

    def reset(self):
        self.u = np.array([0.35] * self.nP + [0.5] * self.nV + [0.0] * self.nH, dtype=np.float64)
        self._clock = 1e9

    def _unpack(self, u):
        return {"pumps": list(u[:self.nP]), "valves": list(u[self.nP:self.nP + self.nV]), "heaters": list(u[self.nP + self.nV:])}

    def _toX(self, meas):
        s = self.m.scenario
        if s == "cstr":
            return np.array([meas["conc"][0], meas["temps"][0]], dtype=np.float64)
        if s == "hvac":
            return np.array([meas["temps"][0], meas["temps"][1]], dtype=np.float64)
        x = np.zeros(self.nx)
        for i in range(self.m.n):
            x[2 * i] = meas["levels"][i]
            x[2 * i + 1] = meas["temps"][i]
        return x

    def _cv(self, x):
        lv, tp = self.m.levels_temps(list(x))
        return np.array([lv[i] for i in self.ctrl] + list(tp), dtype=np.float64)

    def _wcv(self):
        return np.array([1 / self.csl ** 2] * len(self.ctrl) + [1 / self.cst ** 2] * self.m.n)

    def compute(self, meas, sp, dt):
        self._clock += dt
        if self._clock >= self.Ts:
            self._clock = 0.0
            self._solve(meas, sp)
        return self._unpack(self.u)

    def _solve(self, meas, sp):
        m, nx, nu, P, Ts = self.m, self.nx, self.nu, self.P, self.Ts
        env = {"t_cold": meas["t_cold"], "t_amb": meas["t_amb"], "extra_outflow": 0.0}
        x0 = self._toX(meas)
        u0 = self.u.copy()
        f = lambda x: np.asarray(m.derivatives(list(x), self._unpack(u0), env), dtype=np.float64)
        f0 = f(x0)
        eps = 1e-5
        Ad = np.eye(nx)
        Bd = np.zeros((nx, nu))
        for j in range(nx):
            xp = x0.copy(); xp[j] += eps
            xm = x0.copy(); xm[j] -= eps
            Ad[:, j] += (f(xp) - f(xm)) / (2 * eps) * Ts
        for j in range(nu):
            up = u0.copy(); up[j] += eps
            um = u0.copy(); um[j] -= eps
            fp = np.asarray(m.derivatives(list(x0), self._unpack(up), env), dtype=np.float64)
            fm = np.asarray(m.derivatives(list(x0), self._unpack(um), env), dtype=np.float64)
            Bd[:, j] = (fp - fm) / (2 * eps) * Ts
        cv0 = self._cv(x0)
        nCV = len(cv0)
        C = np.zeros((nCV, nx))
        for j in range(nx):
            xp = x0.copy(); xp[j] += eps
            C[:, j] = (self._cv(xp) - cv0) / eps
        target = np.array([sp["h_sp"][i] for i in self.ctrl] + list(sp["t_sp"][:m.n]), dtype=np.float64)
        Wcv = self._wcv()
        c0 = (x0 + f0 * Ts) - Ad @ x0 - Bd @ u0
        xf = x0.copy()
        S = np.zeros((nx, nu))
        H = np.zeros((nu, nu))
        g = np.zeros(nu)
        for _ in range(P):
            xf = Ad @ xf + Bd @ u0 + c0
            S = Ad @ S + Bd
            G = C @ S                      # nCV x nu
            e = C @ xf - target           # nCV
            WG = Wcv[:, None] * G
            H += G.T @ WG
            g += G.T @ (Wcv * e)
        H += self.move_supp * np.eye(nu)
        du = np.linalg.solve(H, -g)
        du = np.clip(du, -self.du_max, self.du_max)
        self.u = np.clip(u0 + du, 0.0, 1.0)


def make_meas(env):
    """Build a measured buildState-like dict from the native env's true state."""
    lv, tp = env.model.levels_temps(env.integ.x)
    e = env._env()
    meas = {"levels": lv, "temps": tp, "t_cold": e["t_cold"], "t_amb": e["t_amb"]}
    if hasattr(env.model, "conc"):
        meas["conc"] = env.model.conc(env.integ.x)
    return meas


def evaluate(agent, env, episodes=20, seed=0):
    """Run a controller (PID/MPC) on the native env; return mean episode return + info."""
    returns, tracks, cons = [], [], []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        agent.reset()
        sp = {"h_sp": env.h_sp, "t_sp": env.t_sp}
        R = tr = co = 0.0
        done = False
        while not done:
            act = agent.compute(make_meas(env), sp, env.control_dt)
            a = np.array(list(act["pumps"]) + list(act["valves"]) + list(act["heaters"]), dtype=np.float32)
            obs, r, term, trunc, info = env.step(a)
            R += r; tr += info["track"]; co += info["constraint"]
            done = term or trunc
        returns.append(R); tracks.append(tr); cons.append(co)
    return {"name": agent.name, "return": float(np.mean(returns)), "return_std": float(np.std(returns)),
            "track": float(np.mean(tracks)), "constraint": float(np.mean(cons))}
