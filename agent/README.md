# AIO-Gym · external agent (Python, over MQTT)

Drive any AIO-Gym scenario from outside the browser over MQTT — read the state,
write the actions. This is how an external RL policy (or any controller) plugs
in. Topic/payload contract: [`../docs/MQTT_UNS.md`](../docs/MQTT_UNS.md).

## Quick start

```bash
# 1. broker (TCP for Python, WS for the browser)
docker compose -f ../deploy/docker-compose.yml up -d

# 2. open the app (../run.sh), in 「外部接口」 connect to  ws://localhost:8083/mqtt

# 3. take control from Python
pip install -r requirements.txt
python mqtt_agent.py --broker localhost --area HeatedTankCascade --policy random
```
The moment the agent publishes an action, the sim switches to **「外部」** mode and
follows it. Watch the schematic/score react live in the browser.

## Files

| File | What |
|------|------|
| `mqtt_agent.py` | Reference external controller. `--policy random\|hold\|onnx`. With `--policy onnx --model policy.onnx` it runs a trained policy. |
| `gym_env.py` | `AIOGymEnv` — a Gymnasium env backed by the browser sim over MQTT (no physics re-implemented). |
| `train_ppo.py` | Example: PPO on `AIOGymEnv` → export `policy.onnx` (load it back in the browser's RL mode, or serve via `mqtt_agent.py`). |

`--area` ∈ `HeatedTankCascade` · `QuadrupleTank` · `CSTR` · `HVAC`.

## Note on training speed

`gym_env.py` steps the **real-time** sim over MQTT, so PPO training is slow — fine
for demos. For serious training: raise the sim **倍速** in the browser, run several
envs, or port the dynamics in [`../frontend/js/sim/models.js`](../frontend/js/sim/models.js)
to a fast local numpy env (same equations, same obs/action contract).
