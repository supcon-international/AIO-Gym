# AIO-Gym · MQTT / UNS 接口

AIO-Gym 的浏览器仿真可经 **MQTT over WebSocket** 与外部双向通信。topic / payload 遵循
Unified Namespace（UNS）/ TIER0 风格：**ISA-95 层级 + 普通 JSON**（不使用 Sparkplug）。

外部程序（如 Python RL agent）连同一 broker 即可：**订阅状态、发布动作**。

## 命名空间

```
AIO-Gym/Sim/{Area}/{Line}
```
- `Area` = 场景：`HeatedTankCascade` | `QuadrupleTank` | `CSTR` | `HVAC`
- `Line` = 环境实例 id（默认 `env-1`，可在界面「外部接口」里改；多个环境并行用不同 Line）

下文 `base` 即 `AIO-Gym/Sim/{Area}/{Line}`。

## 主题

| 方向 | 主题 | retain | QoS | 说明 |
|------|------|:--:|:--:|------|
| sim → | `base/obs` | ✅ | 0 | 完整观测向量 + 设定值（RL 主用）|
| sim → | `base/reward` | | 0 | 每步奖励 + 分量 |
| sim → | `base/unit-{i}/state/temperature` | ✅ | 0 | 单点温度（UNS 可浏览）|
| sim → | `base/unit-{i}/state/level` | ✅ | 0 | 单点液位 |
| sim → | `base/alarms` | | 1 | 报警/联锁变化时 |
| sim → | `base/episode/status` | ✅ | 1 | 生命周期；LWT=offline |
| → sim | `base/action` | | 1 | 写动作向量（写入即接管，自动切「外部」模式）|
| → sim | `base/setpoint/{t\|h}{i}` | ✅ | 1 | 改设定值，如 `setpoint/t1`、`setpoint/h2` |
| → sim | `base/episode/cmd` | | 1 | `reset` / `pause` / `resume` |

## Payload

**obs**（订阅它做 RL）
```json
{ "ts":"2026-06-17T09:30:00.250Z", "t":12.5, "scenario":"cstr", "mode":"ext",
  "obs":[ /* 见下方契约 */ ], "setpoint":{"t_sp":[60],"h_sp":[0]},
  "action_dim":2, "terminated":false, "truncated":false }
```

**reward**
```json
{ "ts":"...", "t":12.5, "reward":-0.08, "components":{"tracking_temp":-0.05,"tracking_level":0,"safety":0} }
```

**action**（发布它来控制）
```json
{ "action":[0.6, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9] }
```

**episode/cmd**
```json
{ "cmd":"reset" }
```

## 观测 / 动作契约

```
obs    = [ levels(n), temps(n), t_sp(n), h_sp(受控 k 个), t_cold, t_amb ]   长度 3n+k+2
action = [ pumps(nP), valves(nV), heaters(nH) ]  全部 ∈ [0,1]               长度 nP+nV+nH
```
无液位的场景（CSTR/HVAC）`levels` 槽填 0。各场景维度：

| 场景 | n | obs 维 | action 维 [泵,阀,加热器] |
|------|:-:|:--:|------|
| HeatedTankCascade | 3 | 14 | 7 = [1,3,3] |
| QuadrupleTank | 4 | 16 | 6 = [2,0,4] |
| CSTR | 1 | 5 | 2 = [1(进料),0,1(冷却)] |
| HVAC | 2 | 8 | 2 = [0,0,2] |

> CSTR 的 `heaters[0]` 是**冷却**（值越大冷却越强）；HVAC 的 `heaters[i]` 0.5=关、>0.5 制热、<0.5 制冷。

## RL 回路（异步实时，默认）

1. agent 订阅 `base/obs`、`base/reward`；
2. 每收到 obs，计算动作，发布到 `base/action`（sim 下一步即应用，自动接管控制）；
3. 物理按真实时间推进，最近一次动作保持到下一次。

可复现的同步步进可用 `episode/cmd:reset` 起一回合，再据 `obs.t` 对齐。

## 本地 broker

见 [`deploy/`](../deploy)：`docker compose up` 起 Mosquitto，TCP `1883`（给 Python agent）+ WS `8083`（给浏览器）。
浏览器「外部接口」填 `ws://localhost:8083/mqtt`，agent 连 `localhost:1883`，两者同 broker 即互通。
零搭建演示可直接用公共测试 broker（界面默认 `wss://broker.emqx.io:8084/mqtt`）。
