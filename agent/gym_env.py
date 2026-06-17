#!/usr/bin/env python3
"""Gymnasium environment backed by a running AIO-Gym browser sim over MQTT.

The browser is the single source of truth for the physics; this env just talks
to it: reset() restarts the episode, step(action) writes the action and reads
back the next observation + reward. No physics is re-implemented in Python.

Because it runs against a real-time sim, stepping is wall-clock paced — fine for
evaluation and quick demos; for fast large-scale training, raise the sim speed
in the browser, or port the dynamics (see frontend/js/sim/models.js) to a local
numpy env. Obs/action contract: ../docs/MQTT_UNS.md

    pip install -r requirements.txt
    # 1) start a broker (deploy/) and open the app, connect it to that broker
    # 2) use this env from Python
"""
from __future__ import annotations
import json
import time

import numpy as np
import gymnasium as gym
from gymnasium import spaces
import paho.mqtt.client as mqtt


class AIOGymEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, broker="localhost", port=1883, area="CSTR", line="env-1",
                 step_dt=0.2, episode_steps=500):
        super().__init__()
        self.base = f"AIO-Gym/Sim/{area}/{line}"
        self.step_dt = step_dt
        self.episode_steps = episode_steps
        self._obs = None
        self._reward = 0.0

        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"aio-gym-env-{area}")
        self.c.on_connect = lambda cl, u, f, rc, p=None: cl.subscribe(
            [(f"{self.base}/obs", 0), (f"{self.base}/reward", 0)])
        self.c.on_message = self._on_message
        self.c.connect(broker, port, 60)
        self.c.loop_start()

        obs = self._wait_obs(timeout=10)
        if obs is None:
            raise RuntimeError(f"no obs on {self.base}/obs — is the browser sim connected to this broker?")
        self._dim = obs["action_dim"]
        n = len(obs["obs"])
        self.action_space = spaces.Box(0.0, 1.0, (self._dim,), dtype=np.float32)
        self.observation_space = spaces.Box(-np.inf, np.inf, (n,), dtype=np.float32)
        self._k = 0

    def _on_message(self, cl, u, msg):
        try:
            m = json.loads(msg.payload)
        except Exception:
            return
        if msg.topic.endswith("/obs"):
            self._obs = m
        elif msg.topic.endswith("/reward"):
            self._reward = m.get("reward", 0.0)

    def _wait_obs(self, timeout=5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self._obs is not None:
                return self._obs
            time.sleep(0.02)
        return None

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.c.publish(f"{self.base}/episode/cmd", json.dumps({"cmd": "reset"}), qos=1)
        time.sleep(0.3)
        obs = self._wait_obs()
        self._k = 0
        return np.asarray(obs["obs"], np.float32), {}

    def step(self, action):
        a = np.clip(np.asarray(action, np.float32), 0.0, 1.0).tolist()
        self.c.publish(f"{self.base}/action", json.dumps({"action": a}), qos=1)
        time.sleep(self.step_dt)
        obs = self._obs
        self._k += 1
        truncated = self._k >= self.episode_steps
        return np.asarray(obs["obs"], np.float32), float(self._reward), False, truncated, {}

    def close(self):
        self.c.loop_stop(); self.c.disconnect()
