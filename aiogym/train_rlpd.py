#!/usr/bin/env python3
"""Train RLPD on the native AIO-Gym env and beat PID / MPC on the gym's own KPI.

Pipeline (the offline->online story):
  1. roll out the existing PID controller -> an offline "historian" dataset
  2. offline-pretrain RLPD, then keep learning online (symmetric sampling)
  3. rank RLPD vs PID vs MPC by KPI score (scoring.py — the SAME composite the
     browser shows: tracking + excess-energy + safety) under dynamic disturbed
     conditions, so "RL beats MPC" is apples-to-apples
  4. save a checkpoint + export ONNX (drop into the browser AIO-Gym RL mode)

    python aiogym/train_rlpd.py --scenario cascade --online-steps 30000
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from aiogym.env import AIOGymNativeEnv
from aiogym.baselines import PIDAgent, MPCAgent, evaluate, make_meas
from aiogym.models import make_model
from aiogym.rlpd import RLPD


def collect_offline(env, agent, episodes, seed=1000):
    data = []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        agent.reset()
        done = False
        while not done:
            sp = {"h_sp": env.h_sp, "t_sp": env.t_sp}     # track current (disturbed) setpoints
            act = agent.compute(make_meas(env), sp, env.control_dt)
            a = np.array(list(act["pumps"]) + list(act["valves"]) + list(act["heaters"]), np.float32)
            o2, r, term, trunc, info = env.step(a)
            data.append((obs, a, r, o2, float(term)))
            obs = o2
            done = term or trunc
    return data


def eval_policy(rlpd, env, episodes=12, seed=5000):
    """Mean score over seeded dynamic episodes (higher = better): economic profit
    when reward_mode='economic', else the composite KPI score."""
    econ = env.reward_mode == "economic"
    scores = []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        s = 0.0
        done = False
        while not done:
            obs, r, term, trunc, info = env.step(rlpd.act(obs, deterministic=True))
            s += info["profit"] if econ else 0.0
            done = term or trunc
        scores.append(s if econ else env.scorer.report()["score"])
    return float(np.mean(scores)), float(np.std(scores))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="cascade", choices=["cascade", "quadruple", "cstr", "hvac"])
    ap.add_argument("--reward-mode", default="kpi", choices=["kpi", "economic", "track"])
    ap.add_argument("--control-dt", type=float, default=0.5)
    ap.add_argument("--episode-steps", type=int, default=400)
    ap.add_argument("--offline-episodes", type=int, default=40)
    ap.add_argument("--randomize-plant", action="store_true", default=True)
    ap.add_argument("--no-randomize-plant", dest="randomize_plant", action="store_false")
    ap.add_argument("--bc-steps", type=int, default=4000)
    ap.add_argument("--pretrain-updates", type=int, default=5000)
    ap.add_argument("--online-steps", type=int, default=30000)
    ap.add_argument("--utd", type=int, default=5)
    ap.add_argument("--n-critics", type=int, default=5)
    ap.add_argument("--eval-every", type=int, default=2500)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    def mkenv():
        # integral_obs OFF keeps obs = base contract (browser-compatible, no obs change).
        # randomize_setpoints OFF for economic: the soft bands (not SPs) define the goal.
        return AIOGymNativeEnv(args.scenario, reward_mode=args.reward_mode, control_dt=args.control_dt,
                               episode_steps=args.episode_steps, dynamic=True, randomize=True,
                               randomize_setpoints=(args.reward_mode != "economic"),
                               randomize_plant=args.randomize_plant, plant_drift=args.randomize_plant,
                               integral_obs=False, terminate_on_runaway=False)

    env = mkenv()
    obs_dim = env.observation_space.shape[0]
    act_dim = env.action_space.shape[0]

    # baselines (the bar to beat) — FIXED nominal tuning/model so they degrade under 工况
    # variation (the gap RL's adaptation must beat). Ranked by KPI score.
    metric = "profit" if args.reward_mode == "economic" else "kpi"
    pid = evaluate(PIDAgent(make_model(args.scenario)), mkenv(), episodes=16)
    mpc = evaluate(MPCAgent(make_model(args.scenario)), mkenv(), episodes=16)
    print(f"[baseline] PID {metric}={pid[metric]:.1f}   MPC {metric}={mpc[metric]:.1f}")

    # 1) offline historian from PID (fixed nominal PID is a fine prior)
    print(f"[offline] collecting {args.offline_episodes} PID episodes...")
    offline = collect_offline(mkenv(), PIDAgent(make_model(args.scenario)), args.offline_episodes)
    print(f"[offline] {len(offline)} transitions")

    rlpd = RLPD(obs_dim, act_dim, n_critics=args.n_critics, utd=args.utd, batch=256)
    rlpd.load_offline(offline)

    # 1b) BC warm-start (tracking only): start near PID. For economic objectives the
    # optimum is FAR from the PID setpoint, so BC-to-PID is a bad init (and imperfect
    # clones run a nonlinear CSTR away → runaway) — skip it with --bc-steps 0 and let
    # pretrain update the actor (original RLPD offline pretrain).
    if args.bc_steps > 0:
        print(f"[bc] warm-starting actor ({args.bc_steps} steps)...")
        rlpd.bc_warmstart(args.bc_steps)
        bc0, _ = eval_policy(rlpd, mkenv())
        print(f"[bc] done  {metric}={bc0:.1f}  (PID {pid[metric]:.1f} / MPC {mpc[metric]:.1f})")

    # 2a) offline pretrain. With BC: critic-only (hold the warm-started actor). Without
    # BC: full actor+critic (learn a policy from the PID prior data).
    pretrain_actor = args.bc_steps == 0
    print(f"[pretrain] {args.pretrain_updates} offline updates (actor={pretrain_actor})...")
    t0 = time.time()
    for i in range(args.pretrain_updates):
        rlpd.update(actor=pretrain_actor)
    pre, _ = eval_policy(rlpd, mkenv())
    print(f"[pretrain] done in {time.time()-t0:.0f}s  {metric}={pre:.1f}")

    # 2b) online learning (symmetric offline+online sampling), best-checkpoint by KPI
    base = args.out or f"aiogym/runs/rlpd_{args.scenario}"
    os.makedirs(os.path.dirname(base), exist_ok=True)
    best, best_path = -1e18, base + "_best.pt"
    obs, _ = env.reset(seed=args.seed)
    hist = []
    t0 = time.time()
    for step in range(1, args.online_steps + 1):
        a = rlpd.act(obs, deterministic=False)
        o2, r, term, trunc, _ = env.step(a)
        rlpd.push(obs, a, r, o2, term)
        obs = o2 if not (term or trunc) else env.reset()[0]
        rlpd.update()
        if step % args.eval_every == 0:
            ret, std = eval_policy(rlpd, mkenv())
            if ret > best:                              # keep the peak — off-policy RL can collapse late
                best = ret
                torch.save(rlpd.state_dict(), best_path)
            hist.append({"step": step, metric: ret})
            sps = step / (time.time() - t0)
            print(f"[online] step {step:6d}  RLPD {metric}={ret:8.1f}±{std:.1f}  "
                  f"(PID {pid[metric]:.1f} / MPC {mpc[metric]:.1f})  best={best:.1f}  {sps:.0f} steps/s")

    if os.path.exists(best_path):                       # restore the best checkpoint for the final policy
        rlpd.load_state_dict(torch.load(best_path))
    final, final_std = eval_policy(rlpd, mkenv(), episodes=24)
    result = {
        "scenario": args.scenario, "reward_mode": args.reward_mode, "metric": metric,
        "PID": {metric: pid[metric]}, "MPC": {metric: mpc[metric]},
        "RLPD": {metric: final, "std": final_std, "best": best},
        "history": hist,
        "beats_pid": final > pid[metric], "beats_mpc": final > mpc[metric],
        "margin_vs_mpc": final - mpc[metric], "margin_vs_pid": final - pid[metric],
    }
    print(json.dumps({k: result[k] for k in ("scenario", "metric", "beats_pid", "beats_mpc",
                                             "margin_vs_mpc", "margin_vs_pid")}, indent=2))

    torch.save(rlpd.state_dict(), base + ".pt")
    rlpd.save_onnx(base + ".onnx")
    with open(base + ".json", "w") as f:
        json.dump(result, f, indent=2)
    print(f"saved {base}.pt / .onnx / .json")


if __name__ == "__main__":
    main()
