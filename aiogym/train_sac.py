#!/usr/bin/env python3
"""Minimal SAC baseline on the native AIO-Gym env (Stable-Baselines3).

This is the "get RL running in the gym" workhorse. For the offline→online story
(RLPD / Cal-QL), reuse the same env: generate a historian dataset from a behavior
policy, pretrain/seed the replay buffer, then keep exploring online.

    pip install stable-baselines3 torch onnx onnxruntime
    python aiogym/train_sac.py --scenario cstr --steps 200000

Export to ONNX (--onnx) to drop the policy into the browser AIO-Gym (RL mode) and
run it head-to-head with PID / MPC.
"""
from __future__ import annotations
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="cstr", choices=["cascade", "quadruple", "cstr", "hvac"])
    ap.add_argument("--steps", type=int, default=200_000)
    ap.add_argument("--n-envs", type=int, default=8)
    ap.add_argument("--randomize", action="store_true", help="domain-randomize init + setpoints (sim-to-real)")
    ap.add_argument("--onnx", action="store_true", help="export policy to ONNX after training")
    args = ap.parse_args()

    import gymnasium as gym
    import aiogym  # noqa: F401  (registers the ids)
    from stable_baselines3 import SAC
    from stable_baselines3.common.env_util import make_vec_env

    name = {"cascade": "Cascade", "quadruple": "Quadruple", "cstr": "CSTR", "hvac": "HVAC"}[args.scenario]
    env = make_vec_env(lambda: gym.make(f"AIOGym/{name}-v0", randomize=args.randomize,
                                        randomize_setpoints=args.randomize), n_envs=args.n_envs)

    model = SAC("MlpPolicy", env, verbose=1, batch_size=256, learning_rate=3e-4,
                train_freq=1, gradient_steps=1, buffer_size=300_000)
    model.learn(total_timesteps=args.steps, progress_bar=True)
    model.save(f"sac_{args.scenario}")
    print(f"saved sac_{args.scenario}.zip")

    if args.onnx:
        import torch
        policy = model.policy
        obs_dim = env.observation_space.shape[0]

        class Det(torch.nn.Module):
            def __init__(self, p):
                super().__init__()
                self.p = p

            def forward(self, x):
                return self.p.actor(x, deterministic=True)

        dummy = torch.zeros(1, obs_dim)
        torch.onnx.export(Det(policy), dummy, f"sac_{args.scenario}.onnx",
                          input_names=["obs"], output_names=["action"], opset_version=17)
        print(f"exported sac_{args.scenario}.onnx — load it in the browser AIO-Gym (RL mode)")


if __name__ == "__main__":
    main()
