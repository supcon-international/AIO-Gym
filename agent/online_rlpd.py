#!/usr/bin/env python3
"""Continue RLPD online learning against the live browser AIO-Gym (web env / MQTT).

The offline(native)->online(web) loop: pretrain fast in the native env
(aiogym/train_rlpd.py), then point the same RLPD agent at the running browser
sim and keep exploring + learning online. The browser visualizes the policy
controlling while it adapts; the adapted policy is exported back to ONNX.

    # 1) start a broker (deploy/), open the app, connect it via the MQTT panel
    # 2) match the control interval to training (--step-dt 0.5)
    python agent/online_rlpd.py --ckpt aiogym/runs/rlpd_cascade.pt \
        --area HeatedTankCascade --step-dt 0.5 --steps 2000
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root (aiogym package)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))                    # agent/ (gym_env)

import torch
from gym_env import AIOGymEnv
from aiogym.rlpd import RLPD

AREAS = {"cascade": "HeatedTankCascade", "quadruple": "QuadrupleTank", "cstr": "CSTR", "hvac": "HVAC"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, help="RLPD checkpoint from train_rlpd.py (.pt)")
    ap.add_argument("--broker", default="broker.emqx.io")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--area", default="HeatedTankCascade")
    ap.add_argument("--line", default="env-1")
    ap.add_argument("--step-dt", type=float, default=0.5, help="match the native training control_dt")
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--warmup", type=int, default=256, help="min online samples before updating")
    args = ap.parse_args()

    env = AIOGymEnv(broker=args.broker, port=args.port, area=args.area, line=args.line, step_dt=args.step_dt)
    obs_dim = env.observation_space.shape[0]
    act_dim = env.action_space.shape[0]
    rlpd = RLPD(obs_dim, act_dim, batch=args.batch)
    rlpd.load_state_dict(torch.load(args.ckpt, map_location="cpu"))
    print(f"loaded {args.ckpt}; online learning on web env {env.base} (obs{obs_dim}/act{act_dim}) ...")

    obs, _ = env.reset()
    ema = None
    for step in range(1, args.steps + 1):
        a = rlpd.act(obs, deterministic=False)          # explore online
        o2, r, term, trunc, info = env.step(a)
        rlpd.push(obs, a, r, o2, term)
        obs = o2 if not (term or trunc) else env.reset()[0]
        if rlpd.online.size > args.warmup:
            rlpd.update()
        ema = r if ema is None else 0.99 * ema + 0.01 * r
        if step % 50 == 0:
            print(f"  step {step:5d}  reward_ema={ema:.3f}  buffer={rlpd.online.size}")

    base = os.path.splitext(args.ckpt)[0] + "_online"
    rlpd.save_onnx(base + ".onnx")
    torch.save(rlpd.state_dict(), base + ".pt")
    print(f"saved adapted policy -> {base}.onnx (load it in the browser RL mode)")
    env.close()


if __name__ == "__main__":
    main()
