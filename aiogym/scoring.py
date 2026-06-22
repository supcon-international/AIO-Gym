"""KPI scorer — numpy/python port of frontend/js/sim/scoring.js.

Composite 0-100 score = 100 - tracking(temp/level) - excess-energy - safety.
Used two ways so the RL optimises *exactly* what the gym (and browser) score:
  - reward:  reward = -step_penalty(...)  (negative instantaneous KPI penalty)
  - compare: report()["score"] ranks PID / MPC / RL on the SAME yardstick the
             browser shows, so "RL beats MPC on KPI" is an apples-to-apples claim.

Weights mirror scoring.js exactly.
"""
from __future__ import annotations

W_TEMP, W_LEVEL, W_ENERGY, W_SAFETY = 2.0, 80.0, 0.5, 60.0


class KPIScorer:
    def __init__(self, model):
        self.model = model
        self.ctrl = model.controlled_levels()
        self.energy_scored = bool(getattr(model, "energy_scored", True))
        self.reset()

    def reset(self):
        self.elapsed = 0.0
        self.iaeT = 0.0
        self.iaeL = 0.0
        self.excess = 0.0          # kWh of power over the ideal steady-state baseline
        self.interlock_sec = 0.0

    def step_penalty(self, levels, temps, h_sp, t_sp, heat_w, ideal_w, interlock, dt):
        """Accumulate one control step; return the instantaneous KPI penalty rate
        (the reward magnitude). reward = -step_penalty(...)."""
        n = self.model.n
        te_sum = sum(abs(temps[i] - t_sp[i]) for i in range(n))
        le_sum = sum(abs(levels[i] - h_sp[i]) for i in self.ctrl) if self.ctrl else 0.0
        excess_w = max(0.0, heat_w - ideal_w) if self.energy_scored else 0.0

        # instantaneous penalty (matches the time-averaged report() in expectation)
        pT = W_TEMP * te_sum / max(1, n)
        pL = W_LEVEL * (le_sum / len(self.ctrl) if self.ctrl else 0.0)
        pE = W_ENERGY * excess_w / 1000.0          # kW over ideal
        pS = W_SAFETY * (1.0 if interlock else 0.0)

        # accumulate for the final time-averaged report (bit-aligned with scoring.js)
        self.elapsed += dt
        self.iaeT += te_sum * dt
        self.iaeL += le_sum * dt
        self.excess += excess_w * dt / 3.6e6
        if interlock:
            self.interlock_sec += dt
        return pT + pL + pE + pS

    def report(self):
        e = max(self.elapsed, 1e-6)
        n = self.model.n
        nL = max(1, len(self.ctrl))
        avgT = self.iaeT / (e * n)
        avgL = self.iaeL / (e * nL)
        hours = e / 3600.0
        avgX = self.excess / hours if hours > 0 else 0.0
        sFrac = self.interlock_sec / e
        pT, pL = W_TEMP * avgT, W_LEVEL * avgL
        pE = W_ENERGY * avgX if self.energy_scored else 0.0
        pS = W_SAFETY * sFrac
        score = max(0.0, min(100.0, 100.0 - pT - pL - pE - pS))
        return {
            "score": score, "avg_temp_err": avgT, "avg_level_err_cm": avgL * 100.0,
            "excess_kwh": self.excess, "interlock_frac": sFrac,
            "comp_temp": pT, "comp_level": pL, "comp_energy": pE, "comp_safety": pS,
        }
