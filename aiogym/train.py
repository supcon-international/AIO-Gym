#!/usr/bin/env python3
"""Parallel RL training for AIO-Gym — hardware-maximized.

Rollout is parallelized across CPU cores (SubprocVecEnv, one plant per worker) and
the policy network runs on the GPU (Apple MPS / CUDA) automatically. Defaults to the
*control-informed* setpoint action mode (RL sets targets, an inner PID regulates) —
the architecture from Bloor et al.'s "Control-informed RL for chemical processes",
which is the right one here (the plant is always controlled, RL only optimizes).

    # 14 parallel CSTR plants, SAC on MPS, economic objective, supervisory RL
    python aiogym/train.py --scenario cstr --algo sac --n-envs 14 --steps 300000

Benchmarks the trained policy against PID / APC-MPC / the NMPC oracle on exit.
"""
from __future__ import annotations
import argparse
import os
import sys
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
# spawned workers re-import; make `aiogym` importable in them via PYTHONPATH
os.environ["PYTHONPATH"] = _ROOT + os.pathsep + os.environ.get("PYTHONPATH", "")


def make_env_fn(scenario, seed, **kw):
    def _f():
        from aiogym.env import AIOGymNativeEnv
        env = AIOGymNativeEnv(scenario, **kw)
        env.reset(seed=seed)
        return env
    return _f


def best_device():
    # For the small MLP policies here, CPU beats Apple MPS by ~3-10x (MPS per-op
    # overhead dominates tiny matmuls); the 16+ parallel CPU env workers are the real
    # accelerator. Use CUDA if present (real GPU), else CPU. Override with --device mps.
    import torch
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="cstr", choices=["cascade", "quadruple", "cstr", "hvac"])
    ap.add_argument("--algo", default="sac", choices=["sac", "ppo"])
    ap.add_argument("--action-mode", default="setpoint", choices=["setpoint", "actuator"])
    ap.add_argument("--reward-mode", default="economic", choices=["economic", "kpi", "track"])
    ap.add_argument("--n-envs", type=int, default=min(16, max(1, (os.cpu_count() or 4) - 2)))
    ap.add_argument("--steps", type=int, default=300_000)
    ap.add_argument("--episode-steps", type=int, default=400)
    ap.add_argument("--grad-steps", type=int, default=4, help="SAC gradient steps per iter (UTD vs throughput)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-bench", action="store_true")
    args = ap.parse_args()

    import torch
    from stable_baselines3 import SAC, PPO
    from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

    torch.set_num_threads(2)                       # leave cores for the env workers
    kw = dict(reward_mode=args.reward_mode, action_mode=args.action_mode,
              episode_steps=args.episode_steps, randomize_plant=True, dynamic=True)
    venv = SubprocVecEnv([make_env_fn(args.scenario, 1000 + i, **kw) for i in range(args.n_envs)])
    venv = VecMonitor(venv)
    dev = args.device or best_device()
    print(f"[train] {args.algo.upper()} | {args.n_envs} parallel {args.scenario} plants | "
          f"device={dev} | action={args.action_mode} | reward={args.reward_mode}")

    if args.algo == "sac":
        model = SAC("MlpPolicy", venv, device=dev, verbose=0, learning_starts=2000,
                    train_freq=1, gradient_steps=args.grad_steps, batch_size=512,
                    policy_kwargs=dict(net_arch=[256, 256]))
    else:
        model = PPO("MlpPolicy", venv, device=dev, verbose=0, n_steps=512, batch_size=2048,
                    policy_kwargs=dict(net_arch=[256, 256]))

    t0 = time.time()
    model.learn(total_timesteps=args.steps, progress_bar=False)
    dt = time.time() - t0
    print(f"[train] {args.steps} steps in {dt:.0f}s = {args.steps/dt:.0f} steps/s "
          f"({args.n_envs} envs x {args.steps/dt/args.n_envs:.0f}/env/s)")
    venv.close()

    out = args.out or f"aiogym/runs/{args.algo}_{args.scenario}"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    model.save(out)
    print(f"[train] saved {out}.zip")

    if not args.no_bench:
        benchmark(args.scenario, model, args.reward_mode, args.action_mode, args.episode_steps)


def benchmark(scenario, model, reward_mode, action_mode, episode_steps):
    """Rank the trained policy vs PID / APC-MPC / NMPC oracle on the same env."""
    import numpy as np
    from aiogym.env import AIOGymNativeEnv
    from aiogym.baselines import PIDAgent, MPCAgent, evaluate
    from aiogym.models import make_model
    metric = "profit" if reward_mode == "economic" else "kpi"

    def mkenv():
        return AIOGymNativeEnv(scenario, reward_mode=reward_mode, episode_steps=episode_steps,
                               dynamic=True, randomize_plant=True, action_mode="actuator")

    rows = {"PID": evaluate(PIDAgent(make_model(scenario)), mkenv(), 6)[metric],
            "APC-MPC": evaluate(MPCAgent(make_model(scenario)), mkenv(), 6)[metric]}
    try:
        from aiogym.oracle import OracleAgent
        rows["NMPC-oracle"] = evaluate(OracleAgent(scenario, horizon=12, mode=reward_mode), mkenv(), 3)[metric]
    except Exception as e:
        print("[bench] oracle skipped:", e)
    # the trained SB3 policy on the (supervisory) env it was trained on
    renv = AIOGymNativeEnv(scenario, reward_mode=reward_mode, episode_steps=episode_steps,
                           dynamic=True, randomize_plant=True, action_mode=action_mode)
    rl = []
    for ep in range(6):
        obs, _ = renv.reset(seed=7000 + ep)
        s, done = 0.0, False
        while not done:
            a, _ = model.predict(obs, deterministic=True)
            obs, r, term, trunc, info = renv.step(a)
            s += info.get("profit", 0.0) if metric == "profit" else 0.0
            done = term or trunc
        rl.append(s if metric == "profit" else renv.scorer.report()["score"])
    rows[f"RL({model.__class__.__name__})"] = float(np.mean(rl))
    print(f"[bench] {scenario} {metric}:  " + " | ".join(f"{k} {v:.0f}" for k, v in rows.items()))


if __name__ == "__main__":
    main()
