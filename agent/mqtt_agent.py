#!/usr/bin/env python3
"""AIO-Gym external control agent (MQTT).

Connects to the same broker as the browser sim, subscribes to the observation
stream and publishes an action vector — i.e. it *takes over* control of the
running environment from the outside. This is the reference for plugging an
external RL policy (or any controller) into AIO-Gym.

Policies:
  --policy random   random actions (sanity check the loop)
  --policy hold     hold a neutral action
  --policy onnx --model policy.onnx    run a trained policy (obs -> action)

Topic / payload contract: see ../docs/MQTT_UNS.md

    pip install -r requirements.txt
    python mqtt_agent.py --broker localhost --area CSTR --policy random
"""
from __future__ import annotations
import argparse
import json
import time

import numpy as np
import paho.mqtt.client as mqtt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--area", default="HeatedTankCascade")
    ap.add_argument("--line", default="env-1")
    ap.add_argument("--policy", default="random", choices=["random", "hold", "onnx"])
    ap.add_argument("--model", default="policy.onnx")
    ap.add_argument("--rate", type=float, default=10.0, help="actions per second")
    args = ap.parse_args()

    base = f"AIO-Gym/Sim/{args.area}/{args.line}"
    rng = np.random.default_rng(0)
    state = {"obs": None, "dim": None, "t": 0.0, "reward": 0.0}

    onnx_pi = None
    if args.policy == "onnx":
        import onnxruntime as ort
        sess = ort.InferenceSession(args.model)
        iname = sess.get_inputs()[0].name
        def onnx_pi(obs):
            a = sess.run(None, {iname: np.asarray(obs, np.float32)[None, :]})[0][0]
            return np.clip(a, 0.0, 1.0).tolist()

    def policy(obs, dim):
        if args.policy == "onnx":
            return onnx_pi(obs)
        if args.policy == "hold":
            return [0.5] * dim
        return rng.random(dim).tolist()

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="aio-gym-agent")

    def on_connect(cl, u, flags, rc, props=None):
        print(f"[agent] connected to {args.broker}:{args.port}, base={base}")
        cl.subscribe([(f"{base}/obs", 0), (f"{base}/reward", 0)])

    def on_message(cl, u, msg):
        try:
            m = json.loads(msg.payload)
        except Exception:
            return
        if msg.topic.endswith("/obs"):
            state["obs"] = m.get("obs"); state["dim"] = m.get("action_dim"); state["t"] = m.get("t")
        elif msg.topic.endswith("/reward"):
            state["reward"] = m.get("reward", 0.0)

    c.on_connect = on_connect
    c.on_message = on_message
    c.connect(args.broker, args.port, 60)
    c.loop_start()

    print(f"[agent] policy={args.policy}; publishing to {base}/action ...")
    period = 1.0 / args.rate
    try:
        while True:
            if state["obs"] is not None and state["dim"]:
                a = policy(state["obs"], state["dim"])
                c.publish(f"{base}/action", json.dumps({"action": a}), qos=1)
                print(f"\r t={state['t']:.0f}s  reward={state['reward']:+.3f}  a={[round(x,2) for x in a]}   ", end="")
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[agent] stopping")
        c.loop_stop(); c.disconnect()


if __name__ == "__main__":
    main()
