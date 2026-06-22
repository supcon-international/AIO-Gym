"""NMPC oracle — a true nonlinear MPC baseline (CasADi + IPOPT), in the spirit of
PC-Gym's do-mpc oracle (Bloor et al., arXiv:2410.22093). It's the "upper-bound"
controller RL/PID/APC-MPC are measured against.

Direct multiple-shooting transcription: RK4 over each control interval, IPOPT NLP.
Symbolic plant dynamics mirror aiogym/models.py exactly (a fair perfect-model
oracle). Two objectives:
  - "track":    Σ (x-x_sp)ᵀQ(x-x_sp) + ΔuᵀRΔu      (PC-Gym-style setpoint tracking)
  - "economic": maximize the economic stage profit (value − energy − violation),
                the right oracle for the economic scenarios (hugs the safe edge).

Usage:
    orc = NMPCOracle("cstr", horizon=20, mode="economic")
    act = orc.solve(x, env)        # -> {"pumps":[...],"valves":[...],"heaters":[...]}
"""
from __future__ import annotations
import numpy as np

try:
    import casadi as ca
    _HAVE_CASADI = True
except Exception:                       # pragma: no cover
    _HAVE_CASADI = False

from .models import make_model
from .env import ECON

RHO_CP = 1000.0 * 4186.0
G = 9.81


# ----------------------------------------------------------------------------
# Symbolic continuous dynamics dx/dt = f(x, u, d) — mirror models.py derivatives.
# x is the interleaved state; u is the [pumps, valves, heaters] actuator vector in
# [0,1]; d = [t_cold, t_amb] are the (measured) disturbance inputs.
# ----------------------------------------------------------------------------
def _f_cascade(x, u, d, p):
    t_cold, t_amb = d[0], d[1]
    qp = u[0] * p["pump_flow_max"]
    h = [x[0], x[2], x[4]]
    T = [x[1], x[3], x[5]]
    qo = [p["cv_out"] * u[1 + i] * ca.sqrt(ca.fmax(h[i], 1e-9)) for i in range(3)]
    dx = []
    for i in range(3):
        qin = qp if i == 0 else qo[i - 1]
        tin = t_cold if i == 0 else T[i - 1]
        vol = p["area"] * ca.fmax(h[i], p["h_floor"])
        pheat = u[4 + i] * p["heater_max"]
        qloss = p["ua_loss"] * (T[i] - t_amb)
        dx += [(qin - qo[i]) / p["area"], qin * (tin - T[i]) / vol + (pheat - qloss) / (RHO_CP * vol)]
    return ca.vertcat(*dx)


def _f_quadruple(x, u, d, p, g1=0.70, g2=0.70):
    t_cold, t_amb = d[0], d[1]
    h = [x[0], x[2], x[4], x[6]]
    T = [x[1], x[3], x[5], x[7]]
    out = [p["a_out"][i] * ca.sqrt(2 * G * ca.fmax(h[i], 1e-9)) for i in range(4)]
    Q1, Q2 = u[0] * p["pump_flow_max"], u[1] * p["pump_flow_max"]
    inflow = [[(g1 * Q1, t_cold), (out[2], T[2])], [(g2 * Q2, t_cold), (out[3], T[3])],
              [((1 - g2) * Q2, t_cold)], [((1 - g1) * Q1, t_cold)]]
    dx = []
    for i in range(4):
        qin = sum(q for q, _ in inflow[i])
        vol = p["area"] * ca.fmax(h[i], p["h_floor"])
        mix = sum(q * (tin - T[i]) for q, tin in inflow[i])
        pheat = u[2 + i] * p["heater_max"][i]
        qloss = p["ua_loss"] * (T[i] - t_amb)
        dx += [(qin - out[i]) / p["area"], mix / vol + (pheat - qloss) / (RHO_CP * vol)]
    return ca.vertcat(*dx)


def _f_cstr(x, u, d, p):
    t_cold = d[0]
    Ca, T = x[0], x[1]
    D = u[0] * p["Dmax"]
    uc = u[1]
    r = p["k0"] * ca.exp(-p["EaR"] / (T + 273.15)) * ca.fmax(Ca, 0.0)
    return ca.vertcat(D * (p["Caf"] - Ca) - r,
                      D * (t_cold - T) + p["Hr"] * r - p["Uc"] * uc * (T - p["Tcool"]))


def _f_hvac(x, u, d, p):
    Tout = d[1]
    P1 = (u[0] - 0.5) * 2 * p["Pmax"]
    P2 = (u[1] - 0.5) * 2 * p["Pmax"]
    return ca.vertcat((P1 + p["Kc"] * (x[1] - x[0]) + p["Ko"] * (Tout - x[0])) / p["C"],
                      (P2 + p["Kc"] * (x[0] - x[1]) + p["Ko"] * (Tout - x[1])) / p["C"])


_DYN = {"cascade": _f_cascade, "quadruple": _f_quadruple, "cstr": _f_cstr, "hvac": _f_hvac}


class NMPCOracle:
    def __init__(self, scenario="cstr", horizon=20, control_dt=0.5, mode="economic",
                 du_max=0.4, q_temp=1.0, q_level=50.0, r_move=0.05):
        if not _HAVE_CASADI:
            raise RuntimeError("casadi not installed — pip install casadi")
        self.scenario = scenario
        self.model = make_model(scenario)
        self.p = self.model.p
        self.N = int(horizon)
        self.dt = float(control_dt)
        self.mode = mode
        self.du_max = du_max
        nP, nV, nH = self.model.actuator_counts()
        self.nP, self.nV, self.nH = nP, nV, nH
        self.nu = nP + nV + nH
        self.nx = len(self.model.initial_state())
        self.q_temp, self.q_level, self.r_move = q_temp, q_level, r_move
        self.econ = ECON.get(scenario, ECON["cascade"])
        # hard safety cap (below the 92°C runaway trip) so economic NMPC hugs the edge
        # without driving the plant unstable; HVAC has no runaway so cap loosely.
        self.t_safe = 40.0 if scenario == "hvac" else 90.0
        self.u_prev = np.full(self.nu, 0.5)
        self._build()

    # one RK4 step of the symbolic dynamics over the control interval. Substeps capped
    # for solve speed (a slightly coarse internal model is standard MPC practice).
    def _rk4(self, x, u, d):
        f = lambda xx: _DYN[self.scenario](xx, u, d, self.p)
        nsub = max(1, min(6, int(round(self.dt / self.model.dt_micro))))
        h = self.dt / nsub
        for _ in range(nsub):
            k1 = f(x); k2 = f(x + 0.5 * h * k1); k3 = f(x + 0.5 * h * k2); k4 = f(x + h * k3)
            x = x + (h / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4)
        return x

    def _stage_cost(self, x, u, sp, d):
        if self.mode == "economic":
            return -self._econ_profit(x, u, d)            # minimize -profit
        # tracking: temps to t_sp, controlled levels to h_sp
        n = self.model.n
        c = 0
        for i in range(n):
            ti = self._temp_idx(i)
            c += self.q_temp * (x[ti] - sp["t_sp"][i]) ** 2
        for j, i in enumerate(self.model.controlled_levels()):
            c += self.q_level * (x[2 * i] - sp["h_sp"][i]) ** 2
        return c

    def _econ_profit(self, x, u, d):
        cfg = self.econ
        temps = [x[self._temp_idx(i)] for i in range(self.model.n)]
        levels = [x[2 * i] for i in range(self.model.n)] if self.scenario in ("cascade", "quadruple") else []
        value = 0
        if cfg["value"] == "production":                  # CSTR
            D = u[0] * self.p["Dmax"]
            value = D * (self.p["Caf"] - x[0])
        # energy (kW) — heater power per model
        if self.scenario == "cascade":
            energy = sum(u[4 + i] * self.p["heater_max"] for i in range(3)) / 1000.0
        elif self.scenario == "quadruple":
            energy = sum(u[2 + i] * self.p["heater_max"][i] for i in range(4)) / 1000.0
        elif self.scenario == "cstr":
            energy = u[1] * self.p["cool_max"] / 1000.0
        else:
            energy = sum(ca.fabs((u[i] - 0.5) * 2 * self.p["Pmax"]) for i in range(2)) / 1000.0
        viol = 0
        for i, (lo, hi) in enumerate(cfg["temp_band"]):
            if lo is not None:
                viol += ca.fmax(0, lo - temps[i]) / 10.0
            if hi is not None:
                viol += ca.fmax(0, temps[i] - hi) / 10.0
        for j, i in enumerate(self.model.controlled_levels()):
            lo, hi = cfg["level_band"][j]
            if lo is not None:
                viol += ca.fmax(0, lo - levels[i]) / 0.1
            if hi is not None:
                viol += ca.fmax(0, levels[i] - hi) / 0.1
        return cfg["w_value"] * value - cfg["w_energy"] * energy - cfg["w_viol"] * viol

    def _temp_idx(self, i):
        return 2 * i + 1 if self.scenario in ("cascade", "quadruple") else (1 if self.scenario == "cstr" else i)

    def _build(self):
        N, nx, nu = self.N, self.nx, self.nu
        opti = ca.Opti()
        X = opti.variable(nx, N + 1)
        U = opti.variable(nu, N)
        x0 = opti.parameter(nx)
        d = opti.parameter(2)
        u_prev = opti.parameter(nu)
        # setpoint params (tracking mode)
        tsp = opti.parameter(self.model.n)
        hsp = opti.parameter(self.model.n)
        sp = {"t_sp": [tsp[i] for i in range(self.model.n)], "h_sp": [hsp[i] for i in range(self.model.n)]}
        J = 0
        opti.subject_to(X[:, 0] == x0)
        slack = opti.variable(1, N)                                    # soft cap slack (feasibility)
        opti.subject_to(slack >= 0)
        for k in range(N):
            opti.subject_to(X[:, k + 1] == self._rk4(X[:, k], U[:, k], d))
            opti.subject_to(opti.bounded(0.0, U[:, k], 1.0))            # actuators in [0,1]
            up = u_prev if k == 0 else U[:, k - 1]
            opti.subject_to(opti.bounded(-self.du_max, U[:, k] - up, self.du_max))  # move limit
            for i in range(self.model.n):                              # HARD safety cap on temps
                opti.subject_to(X[self._temp_idx(i), k + 1] <= self.t_safe + slack[0, k])
            J += self._stage_cost(X[:, k], U[:, k], sp, d) + self.r_move * ca.sumsqr(U[:, k] - up)
        J += 1e4 * ca.sumsqr(slack)                                    # heavily discourage cap violation
        opti.minimize(J)
        opti.solver("ipopt", {"ipopt.print_level": 0, "print_time": 0, "ipopt.max_iter": 80,
                              "ipopt.acceptable_tol": 1e-4})
        self.opti, self.X, self.U = opti, X, U
        self.par = {"x0": x0, "d": d, "u_prev": u_prev, "tsp": tsp, "hsp": hsp}

    def reset(self):
        self.u_prev = np.full(self.nu, 0.5)

    def solve(self, x, t_cold, t_amb, t_sp, h_sp):
        o = self.opti
        o.set_value(self.par["x0"], np.asarray(x, float))
        o.set_value(self.par["d"], [t_cold, t_amb])
        o.set_value(self.par["u_prev"], self.u_prev)
        o.set_value(self.par["tsp"], np.asarray(t_sp, float))
        o.set_value(self.par["hsp"], np.asarray([h_sp[i] if i < len(h_sp) else 0.0
                                                 for i in range(self.model.n)], float))
        try:
            o.set_initial(self.U, np.tile(self.u_prev.reshape(-1, 1), (1, self.N)))
            sol = o.solve()
            u = np.clip(sol.value(self.U)[:, 0], 0.0, 1.0)
        except Exception:
            u = self.u_prev                                # keep last on solver failure
        self.u_prev = np.asarray(u, float).reshape(-1)
        return {"pumps": list(self.u_prev[:self.nP]),
                "valves": list(self.u_prev[self.nP:self.nP + self.nV]),
                "heaters": list(self.u_prev[self.nP + self.nV:])}


class OracleAgent:
    """Adapts NMPCOracle to the baselines agent interface compute(meas, sp, dt)."""
    name = "NMPC-oracle"

    def __init__(self, scenario, **kw):
        self.orc = NMPCOracle(scenario, **kw)
        self.scenario = scenario
        self.model = self.orc.model

    def reset(self):
        self.orc.reset()

    def _x_from_meas(self, meas):
        if self.scenario == "cstr":
            return [meas["conc"][0], meas["temps"][0]]
        if self.scenario == "hvac":
            return list(meas["temps"])
        x = []                                             # cascade/quadruple: interleave h,T
        for i in range(self.model.n):
            x += [meas["levels"][i], meas["temps"][i]]
        return x

    def compute(self, meas, sp, dt):
        return self.orc.solve(self._x_from_meas(meas), meas["t_cold"], meas["t_amb"],
                              sp["t_sp"], sp["h_sp"])
