"""AIOGymNativeEnv — a Gymnasium-first, native (numpy) env over the same plant
dynamics as the browser AIO-Gym. Fast, synchronous, seedable and vectorizable —
built for offline-data generation and online RL training (SAC / RLPD), where the
browser-over-MQTT env is too slow and too loosely-coupled.

Physics parity with the browser JS is enforced by tests/test_parity.py.

Contract (matches the browser RL contract so ONNX policies are interchangeable):
  obs    = [levels(n), temps(n), t_sp(n), h_sp(controlled k), t_cold, t_amb]
  action = [pumps..., valves..., heaters...] in [0, 1]   (direct-actuator mode)

reward_mode:
  "kpi"      (default) reward = -(instantaneous KPI penalty) using the same
             tracking + excess-energy + safety scoring the gym/browser display
             (scoring.py) — so the RL optimises EXACTLY what it's judged on.
  "economic" CSTR production-maximisation (legacy economic demo).
  "track"    plain setpoint tracking (legacy).

dynamic=True injects within-episode disturbances (setpoint steps, cold-inlet
steps, ambient drift, demand surges) on top of domain-randomised start points.
The policy OBSERVES the changed conditions (t_cold / t_amb / setpoints are all in
obs), so this trains the online adaptation a fixed-tuning MPC can't match.
"""
from __future__ import annotations
import numpy as np
import gymnasium as gym
from gymnasium import spaces

from .models import make_model, obs_vector
from .kernel import Integrator
from .scoring import KPIScorer

# advisory/interlock limits — mirror frontend/js/sim/alarms.js (LIMITS)
T_HIGH, T_TRIP = 80.0, 92.0
H_HIGH_FRAC, H_LOW_FRAC, H_OVERFLOW_FRAC = 0.90, 0.15, 0.97
I_TEMP_MAX, I_LEVEL_MAX = 300.0, 8.0          # anti-windup clamp + obs-normaliser for ∫error

# Operating-regime (工况) variation: per-episode multipliers on plant parameters
# that SHIFT the dynamics (fouling, actuator ageing, gain drift). A fixed-tuned
# PID / fixed-model MPC degrades off-nominal; an RL policy trained across the
# distribution (or learning online) stays robust — that's the adaptation edge.
PLANT_REGIME = {
    "cascade":   {"ua_loss": (0.4, 2.6), "heater_max": (0.6, 1.15), "pump_flow_max": (0.7, 1.3), "cv_out": (0.7, 1.4)},
    "quadruple": {"ua_loss": (0.4, 2.6), "heater_max": (0.6, 1.15), "pump_flow_max": (0.7, 1.3), "a_out": (0.8, 1.25)},
    "cstr":      {"Uc": (0.5, 1.6), "k0": (0.55, 1.7), "Hr": (0.85, 1.2)},
    "hvac":      {"Kc": (0.5, 1.7), "Ko": (0.5, 1.9), "C": (0.7, 1.4), "Pmax": (0.7, 1.2)},
}

# Economic objective per scenario: maximize value − energy-cost while keeping
# controlled vars inside SOFT acceptance bands (not on a fixed setpoint). Within
# the band the economics are optimised; the optimum hugs a band/constraint edge
# that DRIFTS with 工况 (feed/outdoor temp, plant efficiency), so a fixed-SP PID /
# fixed-model MPC is structurally suboptimal and an adaptive RL wins.
#   temp_band : per-tank (lo, hi) acceptance window  (None = unconstrained side)
#   value     : "production" (CSTR: hug the drifting safe-temp edge) | "none" (min-energy)
#   w_*       : reward weights (value reward, energy cost /kW, band violation, runaway)
ECON = {
    # Heating scenarios: temps MUST stay in an on-spec window (strong w_viol so the
    # plant is actually controlled — not left cold); within the window minimise energy
    # -> RL hugs the efficient lower edge while PID holds the higher SP. 工况 (feed-temp
    # / efficiency drift) moves the energy-optimal action so fixed tuning is suboptimal.
    "cascade":   {"temp_band": [(34, 44), (48, 58), (60, 72)], "level_band": [(0.32, 0.58)] * 3,
                  "value": "none", "w_value": 0.0, "w_energy": 0.6, "w_viol": 25.0},
    "quadruple": {"temp_band": [(46, 58), (46, 58), (32, 46), (32, 46)], "level_band": [(0.32, 0.56)] * 2,
                  "value": "none", "w_value": 0.0, "w_energy": 0.6, "w_viol": 25.0},
    # CSTR: maximise production hugging the drifting safe-temp edge (value-driven).
    "cstr":      {"temp_band": [(None, 88.0)], "level_band": [],
                  "value": "production", "w_value": 900.0, "w_energy": 0.4, "w_viol": 8.0},
    # HVAC: hold the comfort band, ride the outdoor-favorable edge to save energy.
    "hvac":      {"temp_band": [(20.0, 24.0), (20.0, 24.0)], "level_band": [],
                  "value": "none", "w_value": 0.0, "w_energy": 1.2, "w_viol": 14.0},
}

# Supervisory (RL-on-PID / RTO) action layout: RL outputs SETPOINTS that the inner
# PID tracks (the plant is always regulated -> always controlled, RL >= PID by
# construction; RL only picks the economically-best targets, adapting to 工况). Each
# entry: ("t_sp", tank, lo, hi) | ("h_sp", level, lo, hi) | ("mv", kind, idx, lo, hi)
# ("mv" = an unregulated economic MV set directly, e.g. CSTR feed rate). Levels not
# listed stay at the default SP (PID holds them).
SUPERVISORY = {
    "cascade":   [("t_sp", 0, 25, 80), ("t_sp", 1, 30, 82), ("t_sp", 2, 35, 85)],
    "quadruple": [("t_sp", 0, 25, 72), ("t_sp", 1, 25, 72), ("t_sp", 2, 20, 58), ("t_sp", 3, 20, 58)],
    "cstr":      [("t_sp", 0, 45, 90), ("mv", "pumps", 0, 0.3, 1.0)],
    "hvac":      [("t_sp", 0, 18, 26), ("t_sp", 1, 18, 26)],
}


class AIOGymNativeEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, scenario="cascade", control_dt=0.5, episode_steps=600,
                 reward_mode="kpi", dynamic=True, randomize=True, randomize_setpoints=True,
                 randomize_plant=False, plant_drift=False, integral_obs=False, action_mode="actuator",
                 noise=False, noise_pct=0.01, custom_reward=None,
                 terminate_on_runaway=False, reward_scale=0.03, w_prod=1000.0, w_energy=2.0, w_constraint=8.0):
        super().__init__()
        self.scenario = scenario
        self.control_dt = float(control_dt)
        self.episode_steps = int(episode_steps)
        self.reward_mode = reward_mode
        self.reward_scale = reward_scale          # keep Q-magnitudes sane -> stable critic
        self.dynamic = dynamic
        self.randomize_plant = randomize_plant    # per-episode 工况 (operating-regime) variation
        self.plant_drift = plant_drift            # slow within-episode parameter drift
        self.randomize = randomize
        self.randomize_setpoints = randomize_setpoints
        self.noise = noise                        # measurement noise on observed levels/temps
        self.noise_pct = noise_pct                # std as a fraction of the per-quantity scale
        self.custom_reward = custom_reward         # optional callable(env, levels, temps, act) -> float
        self.terminate_on_runaway = terminate_on_runaway
        # legacy economic-mode weights (CSTR)
        self.w_prod, self.w_energy, self.w_constraint = w_prod, w_energy, w_constraint

        self.model = make_model(scenario)
        self._p_nominal = {k: (list(v) if isinstance(v, list) else v) for k, v in self.model.p.items()}
        self._regime = PLANT_REGIME.get(scenario, {})
        self._econ = ECON.get(scenario, ECON["cascade"])
        self.integ = Integrator(self.model)
        self.scorer = KPIScorer(self.model)
        nP, nV, nH = self.model.actuator_counts()
        self.nP, self.nV, self.nH = nP, nV, nH
        self.nu = nP + nV + nH
        hsp, tsp = self.model.default_setpoints()
        self._hsp0 = [hsp.get(i, 0.0) for i in range(self.model.n)]
        self._tsp0 = list(tsp)
        self._tcold0 = float(self.model.p.get("t_cold", 15.0))
        self._tamb0 = float(self.model.p.get("t_amb", 20.0))

        # integral-of-error obs (the I-term a memoryless policy otherwise lacks): lets
        # the RL policy do offset-free tracking like PID + adapt under 工况 drift.
        self.integral_obs = integral_obs
        self.nctrl = len(self.model.controlled_levels())
        obs_dim = 3 * self.model.n + self.nctrl + 2
        if integral_obs:
            obs_dim += self.model.n + self.nctrl       # ∫temp-err (all) + ∫level-err (controlled)
        # supervisory (RL-on-PID): action = setpoints, an inner PID does the regulation.
        self.action_mode = action_mode
        self.layout = SUPERVISORY.get(scenario, []) if action_mode == "setpoint" else None
        if self.layout is not None:
            from .baselines import PIDAgent
            self.pid = PIDAgent(self.model)
            act_dim = len(self.layout)
        else:
            self.pid = None
            act_dim = self.nu
        self.action_space = spaces.Box(0.0, 1.0, (act_dim,), dtype=np.float32)
        self.observation_space = spaces.Box(-np.inf, np.inf, (obs_dim,), dtype=np.float32)
        self._k = 0

    # ---- helpers ----
    def _env(self):
        return {"t_cold": self.t_cold, "t_amb": self.t_amb, "extra_outflow": self.extra_outflow}

    def _split(self, action):
        a = np.clip(np.asarray(action, np.float64), 0.0, 1.0)
        return {"pumps": list(a[:self.nP]),
                "valves": list(a[self.nP:self.nP + self.nV]),
                "heaters": list(a[self.nP + self.nV:])}

    def _obs(self):
        levels, temps = self.model.levels_temps(self.integ.x)
        if self.noise:                            # measurement noise on observed state (reward uses true state)
            rng = self.np_random
            levels = [l + float(rng.normal(0, self.noise_pct * 0.5)) for l in levels]
            temps = [t + float(rng.normal(0, self.noise_pct * 10.0)) for t in temps]
        o = obs_vector(self.model, levels, temps, self.t_cold, self.t_amb, self.h_sp, self.t_sp)
        if self.integral_obs:
            o = o + [it / I_TEMP_MAX for it in self._itemp] + [il / I_LEVEL_MAX for il in self._ilevel]
        return np.asarray(o, dtype=np.float32)

    def _accumulate_integral(self):
        levels, temps = self.model.levels_temps(self.integ.x)
        ctrl = self.model.controlled_levels()
        dt = self.control_dt
        self._itemp = [float(np.clip(self._itemp[i] + (self.t_sp[i] - temps[i]) * dt, -I_TEMP_MAX, I_TEMP_MAX))
                       for i in range(self.model.n)]
        self._ilevel = [float(np.clip(self._ilevel[j] + (self.h_sp[i] - levels[i]) * dt, -I_LEVEL_MAX, I_LEVEL_MAX))
                        for j, i in enumerate(ctrl)]

    # ---- operating-regime (工况) variation ----
    def _restore_nominal(self):
        for k, v in self._p_nominal.items():
            self.model.p[k] = (list(v) if isinstance(v, list) else v)

    def _apply_regime(self):
        """Scale plant params by per-episode multipliers (fouling / ageing / gain
        drift). Stored separately so the regime targets can be re-sampled for drift."""
        rng = self.np_random
        self._regime_mult = {}
        for k, (lo, hi) in self._regime.items():
            if k in self._p_nominal:
                self._regime_mult[k] = float(rng.uniform(lo, hi))
        self._apply_mult(self._regime_mult)

    def _apply_mult(self, mult):
        for k, m in mult.items():
            nom = self._p_nominal[k]
            self.model.p[k] = [x * m for x in nom] if isinstance(nom, list) else nom * m

    # ---- disturbance scheduler (the "adaptation" dimension) ----
    def _schedule_disturbances(self):
        self._dist_events = []
        if not self.dynamic:
            return
        rng = self.np_random
        for _ in range(int(rng.integers(1, 4))):
            t = int(rng.integers(int(0.15 * self.episode_steps), max(2, self.episode_steps)))
            self._dist_events.append((t, int(rng.integers(0, 4))))

    def _apply_disturbance(self, kind):
        rng = self.np_random
        if kind == 0:                                                  # cold-inlet step
            self.t_cold = float(np.clip(self._tcold0 + rng.uniform(-8, 8), 2, 35))
        elif kind == 1:                                                # ambient drift
            self.t_amb = float(np.clip(self._tamb0 + rng.uniform(-8, 12), 0, 40))
        elif kind == 2:                                                # demand surge
            self.extra_outflow = float(abs(rng.uniform(0, 8e-4)))
        else:                                                          # setpoint move
            for i in self.model.controlled_levels():
                self.h_sp[i] = float(np.clip(self.h_sp[i] * (1 + 0.15 * rng.uniform(-1, 1)), 0.15, 0.70))
            self.t_sp = [float(np.clip(t * (1 + 0.10 * rng.uniform(-1, 1)), 15.0, 85.0)) for t in self.t_sp]

    def _reward_done(self, act):
        levels, temps = self.model.levels_temps(self.integ.x)
        hmax = self.model.height_max
        ctrl = self.model.controlled_levels()
        # tracking error, normalised (level scale 0.1 m, temp scale 10 °C) — for info/legacy
        track = sum(abs(levels[i] - self.h_sp[i]) / 0.1 for i in ctrl)
        track += sum(abs(temps[i] - self.t_sp[i]) / 10.0 for i in range(self.model.n))
        con = 0.0
        for i, h in enumerate(levels):
            if h > H_HIGH_FRAC * hmax[i]:
                con += (h - H_HIGH_FRAC * hmax[i]) / (0.1 * hmax[i])
            elif h < H_LOW_FRAC * hmax[i]:
                con += (H_LOW_FRAC * hmax[i] - h) / (0.1 * hmax[i])
        for T in temps:
            if T > T_HIGH:
                con += (T - T_HIGH) / 10.0
        runaway = any(T > T_TRIP for T in temps) or any(levels[i] > H_OVERFLOW_FRAC * hmax[i] for i in range(len(levels)))

        # Always accumulate the KPI scorer (independent of reward_mode) so any agent
        # — PID / MPC / RL — can be ranked by env.scorer.report()["score"].
        heat_w = self.model.heater_power(act)
        ideal_w = self.model.ideal_power(levels, temps, self.t_sp, self._env(), act)
        pen = self.scorer.step_penalty(levels, temps, self.h_sp, self.t_sp,
                                       heat_w, ideal_w, runaway, self.control_dt)

        prod = 0.0
        if self.reward_mode == "economic":
            profit, prod = self._economic_profit(act, levels, temps, runaway)
            reward = profit * self.reward_scale          # scaled for stable critic; profit reported raw
        elif self.reward_mode == "kpi":
            reward = -pen * self.reward_scale            # -(instantaneous KPI penalty)
            profit = 0.0
        else:
            energy = sum(act["heaters"]) + 0.3 * sum(act["pumps"])
            reward = -(track + 0.03 * energy + 5.0 * con)
            profit = 0.0

        if self.custom_reward is not None:               # user-supplied reward overrides
            reward = float(self.custom_reward(self, levels, temps, act))

        terminated = bool(self.terminate_on_runaway and runaway)
        if terminated:
            reward -= 50.0
        # per-constraint violation amounts (PC-Gym-style tracking for safe-RL benchmarking)
        cons_info = {"temp_high": max((T - T_HIGH for T in temps), default=0.0),
                     "temp_trip": max((T - T_TRIP for T in temps), default=0.0),
                     "level_high": max((levels[i] - H_HIGH_FRAC * hmax[i] for i in range(len(levels))), default=0.0),
                     "level_low": max((H_LOW_FRAC * hmax[i] - levels[i] for i in range(len(levels))), default=0.0)}
        info = {"track": track, "constraint": con, "prod": prod, "profit": profit,
                "runaway": runaway, "cons_info": cons_info, "cons_violated": any(v > 0 for v in cons_info.values()),
                "levels": levels, "temps": temps}
        return float(reward), terminated, info

    def _economic_profit(self, act, levels, temps, runaway):
        """Economic objective: value − energy-cost − soft-band-violation. The optimum
        hugs a band/constraint edge that drifts with 工况, so fixed-SP control is
        suboptimal. Returns (profit, production)."""
        cfg = self._econ
        ctrl = self.model.controlled_levels()
        value = prod = 0.0
        if cfg["value"] == "production" and hasattr(self.model, "production"):
            prod = self.model.production(self.integ.x, act)
            value = prod
        energy_kw = self.model.heater_power(act) / 1000.0
        viol = 0.0
        for i, (lo, hi) in enumerate(cfg["temp_band"]):
            if lo is not None and temps[i] < lo:
                viol += (lo - temps[i]) / 10.0
            if hi is not None and temps[i] > hi:
                viol += (temps[i] - hi) / 10.0
        for j, i in enumerate(ctrl):
            lo, hi = cfg["level_band"][j]
            if lo is not None and levels[i] < lo:
                viol += (lo - levels[i]) / 0.1
            if hi is not None and levels[i] > hi:
                viol += (levels[i] - hi) / 0.1
        profit = cfg["w_value"] * value - cfg["w_energy"] * energy_kw - cfg["w_viol"] * viol
        if runaway:
            profit -= 50.0
        return profit, prod

    # ---- gym API ----
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        rng = self.np_random
        self._restore_nominal()
        if self.randomize_plant:
            self._apply_regime()        # this episode's 工况 (operating regime)
        x0 = list(self.model.initial_state())
        self.h_sp = list(self._hsp0)
        self.t_sp = list(self._tsp0)
        self.t_cold = float(self._tcold0)
        self.t_amb = float(self._tamb0)
        self.extra_outflow = 0.0
        if self.randomize:
            for j in range(len(x0)):
                x0[j] *= 1.0 + 0.08 * float(rng.uniform(-1, 1))
            self.t_cold = float(np.clip(self._tcold0 + rng.uniform(-5, 5), 2, 35))
            self.t_amb = float(np.clip(self._tamb0 + rng.uniform(-5, 8), 0, 40))
        if self.randomize_setpoints:
            for i in self.model.controlled_levels():
                self.h_sp[i] = float(np.clip(self.h_sp[i] * (1 + 0.15 * rng.uniform(-1, 1)), 0.15, 0.70))
            self.t_sp = [float(np.clip(t * (1 + 0.10 * rng.uniform(-1, 1)), 15.0, 85.0)) for t in self.t_sp]
        self.integ.reset(x0)
        self.scorer.reset()
        if self.pid is not None:
            self.pid.reset()
        self._itemp = [0.0] * self.model.n
        self._ilevel = [0.0] * self.nctrl
        self._k = 0
        self._schedule_disturbances()
        return self._obs(), {}

    def default_sp_action(self):
        """Normalized supervisory action that reproduces the default setpoints (= the
        fixed-SP PID baseline) — the offline prior to learn from."""
        if self.layout is None:
            return None
        a = []
        for spec in self.layout:
            lo, hi = spec[-2], spec[-1]
            if spec[0] == "t_sp":
                v = self._tsp0[spec[1]]
            elif spec[0] == "h_sp":
                v = self._hsp0[spec[1]] or 0.45
            else:
                v = lo + 0.7 * (hi - lo)
            a.append(float(np.clip((v - lo) / (hi - lo), 0.0, 1.0)))
        return np.array(a, np.float32)

    def _meas(self):
        """buildState-like dict the inner PID reads (true state)."""
        lv, tp = self.model.levels_temps(self.integ.x)
        m = {"levels": lv, "temps": tp, "t_cold": self.t_cold, "t_amb": self.t_amb}
        if hasattr(self.model, "conc"):
            m["conc"] = self.model.conc(self.integ.x)
        return m

    def _supervise(self, action):
        """Supervisory action = normalized setpoints -> set SPs, inner PID regulates
        to them; unregulated economic MVs ('mv') are applied directly."""
        a = np.clip(np.asarray(action, np.float64), 0.0, 1.0)
        mv = {}
        for i, spec in enumerate(self.layout):
            lo, hi = spec[-2], spec[-1]
            val = lo + float(a[i]) * (hi - lo)
            if spec[0] == "t_sp":
                self.t_sp[spec[1]] = val
            elif spec[0] == "h_sp":
                self.h_sp[spec[1]] = val
            else:                                   # ("mv", kind, idx, lo, hi)
                mv[(spec[1], spec[2])] = val
        act = self.pid.compute(self._meas(), {"h_sp": self.h_sp, "t_sp": self.t_sp}, self.control_dt)
        for (kind, idx), v in mv.items():
            act[kind][idx] = v
        return {"pumps": list(act["pumps"]), "valves": list(act["valves"]), "heaters": list(act["heaters"])}

    def step(self, action):
        act = self._supervise(action) if self.pid is not None else self._split(action)
        for (t, kind) in self._dist_events:
            if t == self._k:
                self._apply_disturbance(kind)
        self.integ.step(self.control_dt, act, self._env())
        self._accumulate_integral()
        self._k += 1
        reward, terminated, info = self._reward_done(act)
        truncated = self._k >= self.episode_steps
        return self._obs(), reward, terminated, truncated, info

    def render(self):
        pass
