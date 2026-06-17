# AIO-Gym

**浏览器里的过程控制环境健身房。** 一组可交互的工业过程仿真（加热水箱、反应器、HVAC…），
你可以亲手操作、用 PID 自动控制、或让外部 RL 算法经 **MQTT** 接管——实时看工艺动画、趋势、报警和评分。

- **打开网页即用**：纯前端，无后端、无需安装，整套仿真在浏览器里跑。
- **可大规模分发**：静态文件，丢 GitHub Pages / 任意静态托管即可。
- **对 RL/算法友好**：所有状态与动作可经 MQTT（Unified Namespace 风格）双向交互。

> 在线打开 → 顶栏左上角切换场景，右上角切换控制方式（手动 / PID / RL / 外部）。

---

## 内置场景

| 场景 | 是什么 | 控制看点 |
|------|--------|----------|
| **多级加热水箱链** | 冷水逐级加热的串联水箱 | 液位 + 温度 + 能耗 + 安全联锁，入门直观 |
| **四水箱基准 (Johansson)** | 经典 MIMO 难题，两泵交叉进料 | 拖 γ 滑杆可变「非最小相位」，亲眼看 PID 变吃力 |
| **放热反应器 CSTR** | 放热反应 + 冷却夹套 | 冷却不足会**热失控**，对操作点敏感，超温自动切进料保护 |
| **双区 HVAC** | 两个互相传热的房间 | 抗室外冷热扰动维持室温，线性易上手 |

每个场景都有：工艺流程动画（P&ID）、实时趋势曲线、报警/联锁、0–100 评分；可一键复位、调倍速。
**扰动与故障**（进料波动、传感器噪声、加热器损坏、阀卡死、泵跳停…）可勾选「自动」让其随机发生。

## 四种控制方式

- **手动** — 拖滑杆当操作员；
- **PID** — 内置去中心化多回路 PID，可改设定值、在线整定；
- **RL** — 加载训练好的 **ONNX** 策略，在浏览器里推理控制；
- **外部** — 由外部程序经 **MQTT** 实时写动作接管（见下）。

## 运行

```bash
./run.sh            # 静态服务 → http://127.0.0.1:8000
```
任意静态服务器指向 `frontend/` 都行；也可直接部署到 GitHub Pages 等（纯前端、相对路径）。

## 外部接口（MQTT / UNS）

让外部 RL 算法或任何程序读状态、写动作——topic/payload 采用 Unified Namespace / TIER0 风格的
**普通 JSON over MQTT**。完整规范见 [`docs/MQTT_UNS.md`](docs/MQTT_UNS.md)。

```bash
docker compose -f deploy/docker-compose.yml up -d   # 本地 broker (WS 给浏览器, TCP 给 Python)
# 浏览器「外部接口」连 ws://localhost:8083/mqtt
cd agent && pip install -r requirements.txt
python mqtt_agent.py --area CSTR --policy random    # 外部程序接管控制
```
一旦外部发布动作，仿真自动切到「外部」模式跟随。`agent/` 还提供一个 Gymnasium 环境
（`gym_env.py`）和 PPO 训练示例（`train_ppo.py`，导出 ONNX 可再载回浏览器 RL 模式）。

## 目录

```
frontend/        纯前端应用（打开即用）
  js/sim/        浏览器内仿真引擎:模型 · RK4 积分 · 控制器(手动/PID/RL/外部) · 报警 · 评分
  js/            界面:工艺图 · 趋势 · 控制面板 · MQTT 桥 · 编排
agent/           Python:外部 MQTT agent · Gym 环境 · PPO 训练示例
deploy/          本地 MQTT broker (Mosquitto, docker-compose)
docs/            MQTT/UNS 接口规范
serve.py         零依赖静态服务器
```

## 技术一览

- **纯客户端仿真**：每个场景是一组常微分方程，用 **RK4** 在浏览器里 20 Hz 实时积分；系统很小，无需 WebAssembly。
- **解耦设计**：场景(`models.js`) × 控制器 × 接口（MQTT）相互独立，加新场景/控制器/接口都很省事。
- **界面**遵循 [Tier0 设计系统](https://github.com/FREEZONEX/Tier0-Design-System)，浅色工作台，移动端自适应。

## 路线图

- ✅ 4 个过程控制场景，手动/PID/RL/外部 四种控制，扰动·故障·报警·趋势·评分，纯客户端 + 移动端。
- ✅ MQTT/UNS 双向接口；浏览器内 ONNX 推理；外部 agent + Gym 环境示例。
- ⏳ 快速离线训练内核（把同一组方程的 numpy 版用于高速 RL 训练）。
- ⏳ 更多场景（精馏、换热器网络、生化反应器…）与 MPC。

## License

MIT — 见 [LICENSE](LICENSE)。
