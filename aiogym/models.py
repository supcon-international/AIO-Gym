"""Native (numpy/pure-python) port of the AIO-Gym plant models.

A faithful re-implementation of frontend/js/sim/models.js — same ODE right-hand
sides, same constants, same state layout — so a policy trained here transfers to
the browser sim and vice-versa. Parity against the JS source of truth is checked
by tests/test_parity.py (golden trajectories generated from the browser engine).

State layout (matches the JS):
  cascade / quadruple : x = [h0, T0, h1, T1, ...]   (level, temp interleaved)
  cstr                : x = [Ca, T]
  hvac                : x = [T0, T1]
Actions are the actuator vector in [0, 1]: [pumps..., valves..., heaters...].
"""
from __future__ import annotations
import math

RHO = 1000.0
CP = 4186.0
G = 9.81
RHO_CP = RHO * CP


def _maxv(a, b):
    return a if a > b else b


class CascadeModel:
    scenario = "cascade"
    n = 3
    dt_micro = 0.02

    def __init__(self):
        self.p = dict(area=0.15, height_max=0.80, cv_out=0.0026, ua_loss=40.0,
                      heater_max=90000.0, pump_flow_max=0.0016, pump_power_max=1500.0,
                      t_cold=15.0, t_amb=20.0, h_floor=1e-3)

    def actuator_counts(self):
        return (1, 3, 3)

    @property
    def height_max(self):
        return [0.8, 0.8, 0.8]

    def _flows(self, h, act, env):
        p = self.p
        qp = act["pumps"][0] * p["pump_flow_max"]
        qo = []
        for i in range(3):
            f = p["cv_out"] * act["valves"][i] * math.sqrt(_maxv(h[i], 0.0))
            if i == 2:
                f += env.get("extra_outflow", 0.0) or 0.0
            qo.append(f)
        return qp, qo

    def derivatives(self, x, act, env):
        p = self.p
        h = [x[0], x[2], x[4]]
        T = [x[1], x[3], x[5]]
        qp, qo = self._flows(h, act, env)
        dx = [0.0] * 6
        for i in range(3):
            qin = qp if i == 0 else qo[i - 1]
            tin = env["t_cold"] if i == 0 else T[i - 1]
            dx[2 * i] = (qin - qo[i]) / p["area"]
            vol = p["area"] * _maxv(h[i], p["h_floor"])
            pheat = act["heaters"][i] * p["heater_max"]
            qloss = p["ua_loss"] * (T[i] - env["t_amb"])
            dx[2 * i + 1] = (qin * (tin - T[i])) / vol + (pheat - qloss) / (RHO_CP * vol)
        return dx

    def levels_temps(self, x):
        return [_maxv(x[0], 0.0), _maxv(x[2], 0.0), _maxv(x[4], 0.0)], [x[1], x[3], x[5]]

    def initial_state(self):
        return [0.30, 20.0, 0.30, 20.0, 0.30, 20.0]

    def clamp_state(self, x):
        return x

    def controlled_levels(self):
        return [0, 1, 2]

    def default_setpoints(self):
        return {0: 0.45, 1: 0.45, 2: 0.45}, [35.0, 50.0, 65.0]


class QuadrupleModel:
    scenario = "quadruple"
    n = 4
    dt_micro = 0.02

    def __init__(self, gamma1=0.70, gamma2=0.70):
        self.p = dict(area=0.06, height_max=0.80, a_out=[2.2e-4, 2.2e-4, 1.0e-4, 1.0e-4],
                      ua_loss=40.0, heater_max=[90000.0, 90000.0, 30000.0, 30000.0],
                      pump_flow_max=1.3e-3, pump_power_max=1200.0, t_cold=15.0, t_amb=20.0, h_floor=1e-3)
        self.gamma1 = gamma1
        self.gamma2 = gamma2

    def actuator_counts(self):
        return (2, 0, 4)

    @property
    def height_max(self):
        return [0.8, 0.8, 0.8, 0.8]

    def _out(self, h):
        return [a * math.sqrt(2 * G * _maxv(h[i], 0.0)) for i, a in enumerate(self.p["a_out"])]

    def _inflow(self, act, env, T, out):
        p = self.p
        Q1 = act["pumps"][0] * p["pump_flow_max"]
        Q2 = act["pumps"][1] * p["pump_flow_max"]
        g1, g2, tc = self.gamma1, self.gamma2, env["t_cold"]
        return [
            [(g1 * Q1, tc), (out[2], T[2])],          # tank 1 <- pump1 + tank3
            [(g2 * Q2, tc), (out[3], T[3])],          # tank 2 <- pump2 + tank4
            [((1 - g2) * Q2, tc)],                     # tank 3 <- pump2
            [((1 - g1) * Q1, tc)],                     # tank 4 <- pump1
        ]

    def derivatives(self, x, act, env):
        p = self.p
        h = [x[0], x[2], x[4], x[6]]
        T = [x[1], x[3], x[5], x[7]]
        out = self._out(h)
        out[0] += env.get("extra_outflow", 0.0) or 0.0
        inflow = self._inflow(act, env, T, out)
        dx = [0.0] * 8
        for i in range(4):
            qin = sum(q for q, _ in inflow[i])
            dx[2 * i] = (qin - out[i]) / p["area"]
            vol = p["area"] * _maxv(h[i], p["h_floor"])
            mix = sum(q * (tin - T[i]) for q, tin in inflow[i])
            pheat = act["heaters"][i] * p["heater_max"][i]
            qloss = p["ua_loss"] * (T[i] - env["t_amb"])
            dx[2 * i + 1] = mix / vol + (pheat - qloss) / (RHO_CP * vol)
        return dx

    def levels_temps(self, x):
        return [_maxv(x[2 * i], 0.0) for i in range(4)], [x[2 * i + 1] for i in range(4)]

    def initial_state(self):
        return [0.25, 20.0, 0.25, 20.0, 0.12, 20.0, 0.12, 20.0]

    def clamp_state(self, x):
        return x

    def controlled_levels(self):
        return [0, 1]

    def default_setpoints(self):
        return {0: 0.40, 1: 0.40}, [50.0, 50.0, 35.0, 35.0]


class CSTRModel:
    scenario = "cstr"
    n = 1
    dt_micro = 0.01

    def __init__(self):
        self.p = dict(Dmax=0.02, Caf=1.0, k0=1e8, EaR=7000.0, Hr=120.0, Uc=0.05, Tcool=10.0,
                      cool_max=80000.0, feed_power_max=1200.0, t_cold=20.0, t_amb=20.0, h_floor=1e-3)

    def actuator_counts(self):
        return (1, 0, 1)

    @property
    def height_max(self):
        return [1.0]

    def _rate(self, Ca, T):
        p = self.p
        return p["k0"] * math.exp(-p["EaR"] / (T + 273.15)) * _maxv(Ca, 0.0)

    def derivatives(self, x, act, env):
        p = self.p
        Ca, T = x[0], x[1]
        D = act["pumps"][0] * p["Dmax"]
        uc = act["heaters"][0]
        r = self._rate(Ca, T)
        return [
            D * (p["Caf"] - Ca) - r,
            D * (env["t_cold"] - T) + p["Hr"] * r - p["Uc"] * uc * (T - p["Tcool"]),
        ]

    def levels_temps(self, x):
        return [], [x[1]]

    def conc(self, x):
        return [_maxv(x[0], 0.0)]

    def initial_state(self):
        return [0.5, 50.0]

    def clamp_state(self, x):
        if x[0] < 0:
            x[0] = 0.0
        if x[1] > 200:
            x[1] = 200.0
        return x

    def controlled_levels(self):
        return []

    def default_setpoints(self):
        return {}, [60.0]


class HVACModel:
    scenario = "hvac"
    n = 2
    dt_micro = 0.02

    def __init__(self):
        self.p = dict(C=6000.0, Pmax=1800.0, Kc=35.0, Ko=45.0, t_cold=5.0, t_amb=5.0, h_floor=1e-3)

    def actuator_counts(self):
        return (0, 0, 2)

    @property
    def height_max(self):
        return [1.0, 1.0]

    def _power(self, u):
        return (u - 0.5) * 2 * self.p["Pmax"]

    def derivatives(self, x, act, env):
        p = self.p
        T1, T2, Tout = x[0], x[1], env["t_amb"]
        P1 = self._power(act["heaters"][0])
        P2 = self._power(act["heaters"][1])
        return [
            (P1 + p["Kc"] * (T2 - T1) + p["Ko"] * (Tout - T1)) / p["C"],
            (P2 + p["Kc"] * (T1 - T2) + p["Ko"] * (Tout - T2)) / p["C"],
        ]

    def levels_temps(self, x):
        return [], [x[0], x[1]]

    def initial_state(self):
        return [10.0, 10.0]

    def clamp_state(self, x):
        return x

    def controlled_levels(self):
        return []

    def default_setpoints(self):
        return {}, [22.0, 22.0]


MODELS = {"cascade": CascadeModel, "quadruple": QuadrupleModel, "cstr": CSTRModel, "hvac": HVACModel}
SCENARIOS = list(MODELS.keys())


def make_model(scenario="cascade"):
    return MODELS.get(scenario, CascadeModel)()


def obs_vector(model, levels, temps, t_cold, t_amb, h_sp, t_sp):
    """Matches obsVector() in controllers.js:
    obs = [levels(n), temps(n), t_sp(n), h_sp(controlled k), t_cold, t_amb]."""
    n = model.n
    o = []
    for i in range(n):
        o.append(levels[i] if i < len(levels) else 0.0)
    for i in range(n):
        o.append(temps[i])
    for i in range(n):
        o.append(t_sp[i])
    for i in model.controlled_levels():
        o.append(h_sp[i])
    o.append(t_cold)
    o.append(t_amb)
    return o
