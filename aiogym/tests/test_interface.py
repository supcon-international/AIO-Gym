#!/usr/bin/env python3
"""Training-interface tests for AIO-Gym — exercises the Gymnasium/RL surface that
PC-Gym-style benchmarking and parallel training depend on. Run: python aiogym/tests/test_interface.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ["PYTHONPATH"] = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import gymnasium as gym
import aiogym  # registers ids
from aiogym.env import AIOGymNativeEnv, SUPERVISORY
from aiogym.models import SCENARIOS

OK = "✓"


def check(name, cond):
    print(f"  {OK if cond else 'FAIL'}  {name}")
    assert cond, name


def test_env_api():
    """Every scenario builds in both action modes with the right spaces + a valid step."""
    for scn in SCENARIOS:
        for mode in ("actuator", "setpoint"):
            e = AIOGymNativeEnv(scn, reward_mode="economic", action_mode=mode, dynamic=True, randomize_plant=True)
            obs, info = e.reset(seed=0)
            assert e.observation_space.contains(obs), f"{scn}/{mode} obs not in space"
            a = e.action_space.sample()
            obs2, r, term, trunc, info = e.step(a)
            exp_act = len(SUPERVISORY[scn]) if mode == "setpoint" else e.nu
            check(f"{scn:10s}/{mode:8s} obs={obs.shape[0]} act={e.action_space.shape[0]}(exp {exp_act}) reward={r:.2f}", e.action_space.shape[0] == exp_act and np.isfinite(r) and "cons_info" in info)


def test_seeding():
    """Same seed -> identical rollout (reproducibility)."""
    def roll(seed):
        e = AIOGymNativeEnv("cstr", reward_mode="economic", dynamic=True, randomize_plant=True)
        o, _ = e.reset(seed=seed); xs = [o]
        for _ in range(30):
            o, *_ = e.step(np.full(e.action_space.shape[0], 0.5, np.float32)); xs.append(o)
        return np.concatenate(xs)
    check("deterministic on fixed seed", np.allclose(roll(42), roll(42)))
    check("different seeds differ", not np.allclose(roll(1), roll(2)))


def test_registered_ids():
    for name in ("Cascade", "Quadruple", "CSTR", "HVAC"):
        e = gym.make(f"AIOGym/{name}-v0", reward_mode="economic", action_mode="setpoint")
        e.reset(seed=0); e.step(e.action_space.sample())
    check("all 4 gym ids make + step", True)


def test_vectorized():
    """Parallel rollout via gymnasium SyncVectorEnv (the SB3 SubprocVecEnv contract)."""
    from gymnasium.vector import SyncVectorEnv
    n = 8
    venv = SyncVectorEnv([lambda: AIOGymNativeEnv("cstr", reward_mode="economic", action_mode="setpoint",
                                                  dynamic=True, randomize_plant=True) for _ in range(n)])
    obs, _ = venv.reset(seed=0)
    for _ in range(20):
        obs, r, term, trunc, info = venv.step(np.stack([venv.single_action_space.sample() for _ in range(n)]))
    check(f"vectorized {n} envs step, obs {obs.shape}", obs.shape[0] == n and np.all(np.isfinite(r)))
    venv.close()


def test_oracle():
    """NMPC oracle solves and beats PID on CSTR economic (it's the upper bound)."""
    try:
        from aiogym.oracle import OracleAgent
    except RuntimeError as ex:
        print(f"  (skip oracle: {ex})"); return
    from aiogym.baselines import PIDAgent, evaluate
    from aiogym.models import make_model
    mk = lambda: AIOGymNativeEnv("cstr", reward_mode="economic", episode_steps=120, dynamic=True, randomize_plant=True)
    orc = evaluate(OracleAgent("cstr", horizon=12, mode="economic"), mk(), episodes=2)["profit"]
    pid = evaluate(PIDAgent(make_model("cstr")), mk(), episodes=2)["profit"]
    check(f"NMPC oracle {orc:.0f} > PID {pid:.0f}", orc > pid)


if __name__ == "__main__":
    print("env API (4 scenarios x 2 action modes):"); test_env_api()
    print("reproducibility:"); test_seeding()
    print("registered gym ids:"); test_registered_ids()
    print("vectorized parallel rollout:"); test_vectorized()
    print("NMPC oracle baseline:"); test_oracle()
    print(f"\nALL INTERFACE TESTS PASS {OK}")
