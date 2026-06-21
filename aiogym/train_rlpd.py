#!/usr/bin/env python3
"""Train RLPD on the native AIO-Gym env and beat PID / MPC.

Pipeline (the offline->online story):
  1. roll out the existing PID controller -> an offline "historian" dataset
  2. offline-pretrain RLPD on it, then keep learning online (symmetric sampling)
  3. evaluate RLPD vs PID vs MPC on the same env + reward
  4. save a checkpoint + export ONNX (drop into the browser AIO-Gym RL mode)

    python aiogym/train_rlpd.py --scenario cascade --online-steps 30000
"""
from __future__ import annotations
import argparse
import json
import os
import time

import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from aiogym.env import AIOGymNativeEnv
from aiogym.baselines import PIDAgent, MPCAgent, evaluate, make_meas
from aiogym.rlpd import RLPD


def collect_offline(env, agent, episodes, seed=1000):
    data = []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        agent.reset()
        sp = {"h_sp": env.h_sp, "t_sp": env.t_sp}
        done = False
        while not done:
            act = agent.compute(make_meas(env), sp, env.control_dt)
            a = np.array(list(act["pumps"]) + list(act["valves"]) + list(act["heaters"]), np.float32)
            o2, r, term, trunc, info = env.step(a)
            data.append((obs, a, r, o2, float(term)))
            obs = o2
            done = term or trunc
    return data


def eval_policy(rlpd, env, episodes=10, seed=5000):
    rets = []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        R, done = 0.0, False
        while not done:
            a = rlpd.act(obs, deterministic=True)
            obs, r, term, trunc, _ = env.step(a)
            R += r
            done = term or trunc
        rets.append(R)
    return float(np.mean(rets)), float(np.std(rets))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="cascade", choices=["cascade", "quadruple", "cstr", "hvac"])
    ap.add_argument("--reward-mode", default="track", choices=["track", "economic"])
    ap.add_argument("--control-dt", type=float, default=0.5)
    ap.add_argument("--episode-steps", type=int, default=400)
    ap.add_argument("--offline-episodes", type=int, default=40)
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
        if args.reward_mode == "economic":
            return AIOGymNativeEnv(args.scenario, reward_mode="economic", control_dt=args.control_dt,
                                   episode_steps=args.episode_steps, w_prod=1000.0, w_energy=2.0,
                                   w_constraint=8.0, terminate_on_runaway=False)
        return AIOGymNativeEnv(args.scenario, reward_mode="track",
                               control_dt=args.control_dt, episode_steps=args.episode_steps)

    env = mkenv()
    obs_dim = env.observation_space.shape[0]
    act_dim = env.action_space.shape[0]

    # baselines (the bar to beat)
    pid = evaluate(PIDAgent(env.model), mkenv(), episodes=12)
    mpc = evaluate(MPCAgent(env.model), mkenv(), episodes=12)
    print(f"[baseline] PID return={pid['return']:.1f}   MPC return={mpc['return']:.1f}")

    # 1) offline historian from PID
    print(f"[offline] collecting {args.offline_episodes} PID episodes...")
    offline = collect_offline(mkenv(), PIDAgent(env.model), args.offline_episodes)
    print(f"[offline] {len(offline)} transitions")

    rlpd = RLPD(obs_dim, act_dim, n_critics=args.n_critics, utd=args.utd, batch=256)
    rlpd.load_offline(offline)

    # 2a) offline pretrain
    print(f"[pretrain] {args.pretrain_updates} offline updates...")
    t0 = time.time()
    for i in range(args.pretrain_updates):
        rlpd.update()
    pre, _ = eval_policy(rlpd, mkenv())
    print(f"[pretrain] done in {time.time()-t0:.0f}s  return={pre:.1f}")

    # 2b) online learning (symmetric offline+online sampling)
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
            hist.append({"step": step, "return": ret})
            sps = step / (time.time() - t0)
            print(f"[online] step {step:6d}  RLPD return={ret:8.1f}±{std:.0f}  "
                  f"(PID {pid['return']:.0f} / MPC {mpc['return']:.0f})  best={best:.0f}  {sps:.0f} steps/s")

    if os.path.exists(best_path):                       # restore the best checkpoint for the final policy
        rlpd.load_state_dict(torch.load(best_path))
    final, final_std = eval_policy(rlpd, mkenv(), episodes=20)
    rl_info = evaluate_rlpd(rlpd, mkenv())
    result = {"scenario": args.scenario, "PID": pid, "MPC": mpc,
              "RLPD": {"return": final, "return_std": final_std, "best": best, **rl_info},
              "history": hist,
              "beats_pid": final > pid["return"], "beats_mpc": final > mpc["return"],
              "margin_vs_mpc_pct": 100 * (final - mpc["return"]) / abs(mpc["return"])}
    print(json.dumps({k: result[k] for k in ("scenario", "beats_pid", "beats_mpc", "margin_vs_mpc_pct")}, indent=2))

    base = args.out or f"aiogym/runs/rlpd_{args.scenario}"
    os.makedirs(os.path.dirname(base), exist_ok=True)
    torch.save(rlpd.state_dict(), base + ".pt")
    rlpd.save_onnx(base + ".onnx")
    with open(base + ".json", "w") as f:
        json.dump(result, f, indent=2)
    print(f"saved {base}.pt / .onnx / .json")


def evaluate_rlpd(rlpd, env, episodes=12, seed=7000):
    """RLPD return + track/constraint via the env info (for an apples-to-apples row)."""
    rets, tr, co = [], [], []
    for ep in range(episodes):
        obs, _ = env.reset(seed=seed + ep)
        R = t = c = 0.0
        done = False
        while not done:
            obs, r, term, trunc, info = env.step(rlpd.act(obs, deterministic=True))
            R += r; t += info["track"]; c += info["constraint"]
            done = term or trunc
        rets.append(R); tr.append(t); co.append(c)
    return {"track": float(np.mean(tr)), "constraint": float(np.mean(co))}


if __name__ == "__main__":
    main()
