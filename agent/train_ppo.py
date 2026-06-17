#!/usr/bin/env python3
"""Train a PPO policy on an AIO-Gym scenario and export it to ONNX so it can be
loaded back into the browser (RL mode) or served by mqtt_agent.py.

This is an example/scaffold. It trains against the live (real-time) MQTT env, so
it is slow — fine for a small demo. For serious training, raise the sim speed in
the browser, run several envs, or port the dynamics to a fast local numpy env.

    pip install -r requirements.txt   # + stable-baselines3 torch onnx
    python train_ppo.py --area CSTR --steps 20000
"""
from __future__ import annotations
import argparse

import numpy as np
import torch
from stable_baselines3 import PPO

from gym_env import AIOGymEnv


def export_onnx(model, n_obs, path):
    policy = model.policy
    policy.eval()

    class Wrapper(torch.nn.Module):
        def __init__(self, p): super().__init__(); self.p = p
        def forward(self, obs):
            # deterministic action in [0,1]
            return self.p._predict(obs, deterministic=True)

    dummy = torch.zeros(1, n_obs)
    torch.onnx.export(Wrapper(policy), dummy, path, input_names=["obs"], output_names=["action"],
                      dynamic_axes={"obs": {0: "b"}, "action": {0: "b"}}, opset_version=17)
    print(f"[train] exported {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", default="CSTR")
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--steps", type=int, default=20000)
    ap.add_argument("--out", default="policy.onnx")
    args = ap.parse_args()

    env = AIOGymEnv(broker=args.broker, area=args.area)
    model = PPO("MlpPolicy", env, verbose=1, n_steps=512, batch_size=128)
    model.learn(total_timesteps=args.steps)
    export_onnx(model, env.observation_space.shape[0], args.out)
    env.close()


if __name__ == "__main__":
    main()
