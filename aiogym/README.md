# aiogym — native Gymnasium env for AIO-Gym

A fast, synchronous, **Gymnasium-first** re-implementation of the AIO-Gym plant
dynamics in numpy — built for RL **training** (the browser sim is for the
arena/demo and is too slow + too loosely-coupled to train against).

It is **provably consistent** with the browser physics: the ODE right-hand
sides, constants and RK4 integrator are a line-for-line port of
`frontend/js/sim/{models,kernel}.js`, and `tests/test_parity.py` checks the
native trajectories against golden checkpoints generated from the browser engine
(max |Δ| ≈ 1e-15, i.e. bit-for-bit). So a policy trained here drops straight into
the browser AIO-Gym (export to ONNX, load in RL mode) and competes with PID/MPC.

## Install & verify
```bash
pip install -r aiogym/requirements.txt          # numpy + gymnasium
python aiogym/tests/test_parity.py               # prove consistency with the JS sim
```

## Use
```python
import gymnasium as gym, aiogym                   # registers the ids on import
env = gym.make("AIOGym/CSTR-v0")                  # Cascade / Quadruple / CSTR / HVAC
obs, _ = env.reset(seed=0)
obs, r, term, trunc, info = env.step(env.action_space.sample())
```
Single env runs ~2–8k steps/s (pure python); wrap in `gymnasium.vector` for more.

## Contract (matches the browser RL contract → ONNX policies are interchangeable)
- `obs = [levels(n), temps(n), t_sp(n), h_sp(controlled k), t_cold, t_amb]`
- `action = [pumps…, valves…, heaters…] ∈ [0,1]`  (direct-actuator mode)
- `reward = −(w_track·tracking + w_energy·effort + w_constraint·violation)`; hard
  terminal on thermal runaway / overflow. Weights and `control_dt`, `episode_steps`,
  `randomize`, `randomize_setpoints` are constructor args.

## Train
`train_sac.py` is the SAC baseline. For the **offline→online** goal (RLPD /
Cal-QL): generate a historian dataset from this env, seed the replay buffer,
keep exploring online. RLPD = SAC + offline data in buffer + critic LayerNorm +
critic ensemble + symmetric sampling (official JAX impl: ikostrikov/rlpd).

## Roadmap (next, on top of this consistent core)
- **Supervisory setpoint mode** (`action = setpoints`, inner PID regulates) — the
  RL-over-PID architecture; a thin wrapper, dynamics unchanged.
- **Realism layer** port (sensor deadtime/noise, actuator stiction) for sim-to-real.
- **Plant drift / aging** axis → the "RL re-training vs MPC re-identification"
  maintenance experiment.
- **Safety filter / predictive shield** wrapper for true online exploration.
