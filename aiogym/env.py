"""AIOGymNativeEnv — a Gymnasium-first, native (numpy) env over the same plant
dynamics as the browser AIO-Gym. Fast, synchronous, seedable and vectorizable —
built for offline-data generation and online RL training (SAC / RLPD / Cal-QL),
where the browser-over-MQTT env is too slow and too loosely-coupled.

Physics parity with the browser JS is enforced by tests/test_parity.py.

Contract (matches the browser RL contract so ONNX policies are interchangeable):
  obs    = [levels(n), temps(n), t_sp(n), h_sp(controlled k), t_cold, t_amb]
  action = [pumps..., valves..., heaters...] in [0, 1]   (direct-actuator mode)
The supervisory "action = setpoints, inner PID regulates" mode is a thin wrapper
on top of this (see SetpointWrapper, TODO) — the dynamics layer is unchanged.
"""
from __future__ import annotations
import numpy as np
import gymnasium as gym
from gymnasium import spaces

from .models import make_model, obs_vector
from .kernel import Integrator

# advisory/interlock limits — mirror frontend/js/sim/alarms.js (LIMITS)
T_HIGH, T_TRIP = 80.0, 92.0
H_HIGH_FRAC, H_LOW_FRAC, H_OVERFLOW_FRAC = 0.90, 0.15, 0.97


class AIOGymNativeEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, scenario="cascade", control_dt=0.5, episode_steps=600,
                 reward_mode="track", w_track=1.0, w_energy=0.03, w_constraint=5.0,
                 w_prod=1000.0, randomize=False, randomize_setpoints=False, terminate_on_runaway=True):
        super().__init__()
        self.scenario = scenario
        self.control_dt = float(control_dt)
        self.episode_steps = int(episode_steps)
        # reward_mode: "track" = hold the setpoints (what PID/MPC do); "economic" =
        # maximize production while staying safe — a constrained nonlinear economic
        # objective a fixed-setpoint controller cannot optimize (CSTR only for now).
        self.reward_mode = reward_mode
        self.w_track, self.w_energy, self.w_constraint, self.w_prod = w_track, w_energy, w_constraint, w_prod
        self.randomize = randomize
        self.randomize_setpoints = randomize_setpoints
        self.terminate_on_runaway = terminate_on_runaway

        self.model = make_model(scenario)
        self.integ = Integrator(self.model)
        nP, nV, nH = self.model.actuator_counts()
        self.nP, self.nV, self.nH = nP, nV, nH
        self.nu = nP + nV + nH
        hsp, tsp = self.model.default_setpoints()
        self._hsp0 = [hsp.get(i, 0.0) for i in range(self.model.n)]
        self._tsp0 = list(tsp)

        obs_dim = 3 * self.model.n + len(self.model.controlled_levels()) + 2
        self.action_space = spaces.Box(0.0, 1.0, (self.nu,), dtype=np.float32)
        self.observation_space = spaces.Box(-np.inf, np.inf, (obs_dim,), dtype=np.float32)
        self._k = 0

    # ---- helpers ----
    def _env(self):
        p = self.model.p
        return {"t_cold": p["t_cold"], "t_amb": p["t_amb"], "extra_outflow": 0.0}

    def _split(self, action):
        a = np.clip(np.asarray(action, np.float64), 0.0, 1.0)
        return {"pumps": list(a[:self.nP]),
                "valves": list(a[self.nP:self.nP + self.nV]),
                "heaters": list(a[self.nP + self.nV:])}

    def _obs(self):
        levels, temps = self.model.levels_temps(self.integ.x)
        e = self._env()
        return np.asarray(obs_vector(self.model, levels, temps, e["t_cold"], e["t_amb"],
                                     self.h_sp, self.t_sp), dtype=np.float32)

    def _reward_done(self, act):
        levels, temps = self.model.levels_temps(self.integ.x)
        hmax = self.model.height_max
        ctrl = self.model.controlled_levels()
        # tracking error, normalised (level scale 0.1 m, temp scale 10 °C)
        track = sum(abs(levels[i] - self.h_sp[i]) / 0.1 for i in ctrl)
        track += sum(abs(temps[i] - self.t_sp[i]) / 10.0 for i in range(self.model.n))
        # economic: actuator effort (heaters dominate; pumps small)
        energy = sum(act["heaters"]) + 0.3 * sum(act["pumps"])
        # constraint violations (soft penalty)
        con = 0.0
        for i, h in enumerate(levels):
            if h > H_HIGH_FRAC * hmax[i]:
                con += (h - H_HIGH_FRAC * hmax[i]) / (0.1 * hmax[i])
            elif h < H_LOW_FRAC * hmax[i]:
                con += (H_LOW_FRAC * hmax[i] - h) / (0.1 * hmax[i])
        for T in temps:
            if T > T_HIGH:
                con += (T - T_HIGH) / 10.0
        if self.reward_mode == "economic" and self.scenario == "cstr":
            # maximize product rate (reactant consumed) — runs the reactor as hot as
            # safe, which a fixed-setpoint PID/MPC will not do.
            Ca = self.model.conc(self.integ.x)[0]
            D = act["pumps"][0] * self.model.p["Dmax"]
            prod = D * (self.model.p["Caf"] - Ca)
            reward = self.w_prod * prod - self.w_energy * act["heaters"][0] - self.w_constraint * con
        else:
            prod = 0.0
            reward = -(self.w_track * track + self.w_energy * energy + self.w_constraint * con)
        # hard terminal: overflow or thermal runaway
        runaway = any(T > T_TRIP for T in temps) or any(levels[i] > H_OVERFLOW_FRAC * hmax[i] for i in range(len(levels)))
        terminated = bool(self.terminate_on_runaway and runaway)
        if terminated:
            reward -= 50.0
        info = {"track": track, "energy": energy, "constraint": con, "prod": prod, "runaway": runaway,
                "levels": levels, "temps": temps}
        return float(reward), terminated, info

    # ---- gym API ----
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        x0 = list(self.model.initial_state())
        self.h_sp = list(self._hsp0)
        self.t_sp = list(self._tsp0)
        if self.randomize:
            # mild domain randomization of the initial operating point
            for j in range(len(x0)):
                x0[j] *= 1.0 + 0.08 * float(self.np_random.uniform(-1, 1))
        if self.randomize_setpoints:
            for i in self.model.controlled_levels():
                self.h_sp[i] = float(np.clip(self.h_sp[i] * (1 + 0.15 * self.np_random.uniform(-1, 1)), 0.1, 0.75))
            self.t_sp = [float(np.clip(t * (1 + 0.12 * self.np_random.uniform(-1, 1)), 25, 85)) for t in self.t_sp]
        self.integ.reset(x0)
        self._k = 0
        return self._obs(), {}

    def step(self, action):
        act = self._split(action)
        self.integ.step(self.control_dt, act, self._env())
        self._k += 1
        reward, terminated, info = self._reward_done(act)
        truncated = self._k >= self.episode_steps
        return self._obs(), reward, terminated, truncated, info

    def render(self):
        pass
