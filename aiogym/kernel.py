"""Fixed-step RK4 integrator — a line-for-line port of frontend/js/sim/kernel.js.

Each model declares its own micro-step (`dt_micro`); a control step `dt` is
sub-stepped into ceil(dt/dt_micro) RK4 micro-steps, and an optional `clamp_state`
is applied after every micro-step (e.g. concentration >= 0).
"""
from __future__ import annotations
import math


class Integrator:
    def __init__(self, model):
        self.model = model
        self.dt_micro = getattr(model, "dt_micro", 0.02) or 0.02
        self.reset()

    def reset(self, state=None):
        self.x = list(state) if state is not None else list(self.model.initial_state())
        self.t = 0.0

    def step(self, dt, act, env):
        m = self.model
        f = lambda x: m.derivatives(x, act, env)
        nsub = max(1, math.ceil(dt / self.dt_micro - 1e-9))
        h = dt / nsub
        for _ in range(nsub):
            x = self.x
            k1 = f(x)
            k2 = f([v + 0.5 * h * k1[i] for i, v in enumerate(x)])
            k3 = f([v + 0.5 * h * k2[i] for i, v in enumerate(x)])
            k4 = f([v + h * k3[i] for i, v in enumerate(x)])
            self.x = [v + (h / 6.0) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) for i, v in enumerate(x)]
            if hasattr(m, "clamp_state"):
                self.x = m.clamp_state(self.x)
            self.t += h
        return self.x
