<div align="center">

# AIO-Gym

**A process-control playground that runs entirely in your browser.**

[**English**](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[▶ Live demo](https://supcon-international.github.io/AIO-Gym/) · MIT License

</div>

---

AIO-Gym turns four classic industrial control problems — a heated-tank cascade, the Johansson quadruple-tank, an exothermic CSTR, and a two-zone HVAC loop — into an interactive, real-time simulation. Drive it by hand, hand it to a PID or MPC controller, or let a reinforcement-learning policy run. The entire physics, control, and rendering stack runs client-side: open the page and it works — no server, no install. A parallel Python package (`aiogym/`) exposes the same plants as a Gymnasium environment with an NMPC oracle and parallel training, so policies trained offline drop straight back into the browser as ONNX.

### Highlights

- **Zero-install, zero-backend.** Pure static front-end; deploy to GitHub Pages or any static host.
- **Four plants, four controllers.** Manual, decentralized PID, APC-style MPC, and supervisory RL — switch live.
- **Economic, not just tracking.** Scored on an economic objective (value − energy − constraint violation), where a learned policy has real headroom over a fixed-setpoint PID/MPC.
- **Honest realism.** Sensor noise / deadtime / lag / bias and actuator stiction / slew toggle on or off; disturbances and equipment faults fire automatically, with a pop-up when they do.
- **Trilingual UI** (English / 中文 / 日本語) and an episodic KPI — one episode = 600 s of sim (≈ 1 min at 10×), scored as a per-episode average.
- **[Challenge mode](challenge.html).** A mobile + desktop mini-game across three plants (CSTR / HVAC / tank cascade): hand-control your plant *beside* an RL ghost running the same disturbances — two live P&IDs, side by side — and try to out-score it. Anti-idle economic scoring: doing nothing loses.

### Scenarios

| Scenario | What it is | The control challenge |
|---|---|---|
| **Heated-Tank Cascade** | Tanks in series, each heated | Level + temperature + energy + safety interlocks — the gentle on-ramp |
| **Quadruple-Tank (Johansson)** | Classic MIMO benchmark, cross-coupled pumps | A γ slider moves it into the *non-minimum-phase* regime where PID visibly struggles |
| **Exothermic CSTR** | Reaction + cooling jacket | Too little cooling → *thermal runaway*; production is maximized by hugging the safety edge |
| **Two-Zone HVAC** | Two rooms exchanging heat | Hold comfort against outdoor swings at minimum power |

### Control modes

- **Manual** — drag the actuator sliders like a board operator.
- **PID** — built-in decentralized multi-loop PID; edit setpoints and tune gains live.
- **MPC** — APC-style multivariable MPC running in the browser.
- **RL** — *supervisory* reinforcement learning: the policy chooses **setpoints**, and an inner PID regulates the plant to them. The floor is always PID; RL adds economic optimization on top. Policies load as ONNX and run in-browser — one economic policy per scenario ships built-in, and the exact reward it optimizes is printed in the panel.

> **Why supervisory?** A learned policy doesn't beat a well-tuned PID at *tracking* — it wins on *economics*. Letting RL pick setpoints (RTO-style) while PID guarantees regulation is the design that actually pays off, and it matches current "control-informed RL" practice.

### The training stack (`aiogym/`)

The same four plants are a native **Gymnasium** environment, so you can train without the browser:

- **NMPC oracle** — a CasADi / IPOPT nonlinear MPC (do-mpc style) as the perfect-model upper bound, the way [PC-Gym](https://github.com/MaximilianB2/pc-gym) uses it.
- **Parallel training** — Stable-Baselines3 SAC/PPO over `SubprocVecEnv`, one plant per CPU core (CPU beats MPS for these small MLPs).
- **Benchmarked** — every run ranks the policy against PID, MPC, and the oracle on the economic objective.

```bash
# Browser
./run.sh                       # → http://127.0.0.1:8000  (or just open the live demo)

# Training
cd aiogym && pip install -r requirements.txt
python train.py                # SAC · supervisory setpoints · economic reward · parallel envs
python -m pytest tests/        # env / oracle / vectorization checks
```

### Credits

Plant models, oracle-as-baseline, and realism parity are informed by **[PC-Gym](https://github.com/MaximilianB2/pc-gym)** and Maximilian Bloor et al.'s work on control-informed reinforcement learning. Released under the MIT License.
