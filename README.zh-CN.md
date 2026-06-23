<div align="center">

# AIO-Gym

**一个完全跑在浏览器里的过程控制实验场。**

[English](README.md) · [**简体中文**](README.zh-CN.md) · [日本語](README.ja.md)

[▶ 在线演示](https://supcon-international.github.io/AIO-Gym/) · MIT 许可

</div>

---

AIO-Gym 把四个经典的工业控制问题——多级加热水箱链、Johansson 四水箱、放热反应器 CSTR、双区 HVAC——做成了可交互的实时仿真。你可以亲手操作、交给 PID 或 MPC 控制，也可以让强化学习策略接管。整套物理、控制与渲染都在客户端运行：打开网页即用，无后端、无需安装。配套的 Python 包（`aiogym/`）把同样的对象封装成 Gymnasium 环境，带 NMPC oracle 和并行训练——离线训好的策略导出成 ONNX 就能直接回到浏览器里跑。

### 特点

- **零安装、零后端**：纯静态前端，丢到 GitHub Pages 或任意静态托管即可。
- **四个对象、四种控制器**：手动、去中心化 PID、APC 风格 MPC、监督式 RL，可实时切换。
- **比的是经济性，不是跟踪**：以经济目标打分（产值 − 能耗 − 约束越界），这正是固定设定点的 PID/MPC 让出真实优化空间、学习型策略能赢的地方。
- **诚实的真实度**：传感器噪声 / 死区 / 迟延 / 偏置、执行机构黏滞 / 速率限制都可开关；扰动与设备故障会自动随机触发，并弹出提示。
- **三语界面**（English / 中文 / 日本語）与回合制 KPI——一回合 = 600 秒仿真（10 倍速下约 1 分钟），按回合平均分计。

### 内置场景

| 场景 | 是什么 | 控制看点 |
|---|---|---|
| **多级加热水箱链** | 逐级加热的串联水箱 | 液位 + 温度 + 能耗 + 安全联锁，入门直观 |
| **四水箱（Johansson）** | 经典 MIMO 基准，两泵交叉进料 | 拖 γ 滑杆切到**非最小相位**区，亲眼看 PID 变吃力 |
| **放热反应器 CSTR** | 放热反应 + 冷却夹套 | 冷却不足会**热失控**；贴着安全边界跑才能产量最大 |
| **双区 HVAC** | 两个互相传热的房间 | 抗室外冷热扰动、用最小功率维持舒适区 |

### 四种控制方式

- **手动** — 像操作员一样拖滑杆。
- **PID** — 内置去中心化多回路 PID，可改设定点、在线整定。
- **MPC** — 浏览器里跑的 APC 风格多变量 MPC。
- **RL** — **监督式**强化学习：策略选**设定点**，内层 PID 把对象调到该设定点。底线永远是 PID，RL 只在上面叠加经济优化。策略以 ONNX 加载、浏览器内推理——每个场景内置一个经济策略，它优化的奖励函数会直接写在面板里。

> **为什么是监督式？** 学习型策略在**跟踪**上赢不过整定好的 PID，它赢在**经济性**。让 RL 选设定点（RTO 思路）、PID 保证调节，才是真正划算的设计，也契合当前 "control-informed RL" 的实践。

### 训练栈（`aiogym/`）

同样的四个对象也是原生 **Gymnasium** 环境，不开浏览器也能训练：

- **NMPC oracle** — 用 CasADi / IPOPT 的非线性 MPC（do-mpc 风格）作为完美模型上界，做法参考 [PC-Gym](https://github.com/MaximilianB2/pc-gym)。
- **并行训练** — Stable-Baselines3 SAC/PPO + `SubprocVecEnv`，每个 CPU 核一套对象（这种小 MLP，CPU 比 MPS 更快）。
- **自带基准** — 每次训练结束都会把策略和 PID、MPC、oracle 在经济目标上排名。

```bash
# 浏览器
./run.sh                       # → http://127.0.0.1:8000 （或直接打开在线演示）

# 训练
cd aiogym && pip install -r requirements.txt
python train.py                # SAC · 监督式设定点 · 经济奖励 · 并行环境
python -m pytest tests/        # 环境 / oracle / 向量化 检查
```

### 致谢

对象模型、oracle 作基线、真实度对齐等借鉴了 **[PC-Gym](https://github.com/MaximilianB2/pc-gym)** 以及 Maximilian Bloor 等人关于 control-informed 强化学习的工作。以 MIT 许可发布。
