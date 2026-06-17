// Disturbance & fault injection — JS port. Changes the environment (cold inlet,
// ambient, demand), the measurements (sensor noise) or breaks actuators (heater
// dead, valve stuck, pump trip). Same catalogue as the Python reference.

export const CATALOG = {
  cold_inlet: { label: 'Cold inlet temp step', kind: 'disturbance', default: { value: 8.0 } },
  ambient: { label: 'Ambient temp change', kind: 'disturbance', default: { value: 5.0 } },
  demand_surge: { label: 'Downstream demand surge', kind: 'disturbance', default: { value: 0.0006 } },
  sensor_noise: { label: 'Sensor noise', kind: 'disturbance', default: { level_std: 0.01, temp_std: 0.4 } },
  heater_fault: { label: 'Heater dead (stuck off)', kind: 'fault', default: { index: 1 } },
  valve_stuck: { label: 'Valve stuck', kind: 'fault', default: { index: 0, value: 0.15 }, needs: 'valves' },
  pump_trip: { label: 'Pump trip (no inflow)', kind: 'fault', default: {} },
};

function gauss(std) {
  if (std <= 0) return 0;
  const u = 1 - Math.random(), v = Math.random();
  return std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class DisturbanceManager {
  constructor(model) { this.active = {}; this.bind(model); }
  bind(model) { this.model = model; }

  set(dtype, params) {
    if (!CATALOG[dtype]) return;
    this.active[dtype] = { ...CATALOG[dtype].default, ...(params || {}) };
  }
  clear(dtype) { delete this.active[dtype]; }
  clearAll() { this.active = {}; }
  status() {
    const o = {};
    for (const k in this.active) o[k] = { params: this.active[k], label: CATALOG[k].label, kind: CATALOG[k].kind };
    return o;
  }

  environment() {
    const p = this.model.p;
    const env = { t_cold: p.t_cold, t_amb: p.t_amb, extra_outflow: 0 };
    if (this.active.cold_inlet) env.t_cold = p.t_cold + this.active.cold_inlet.value;
    if (this.active.ambient) env.t_amb = p.t_amb + this.active.ambient.value;
    if (this.active.demand_surge) env.extra_outflow = Math.max(0, this.active.demand_surge.value);
    return env;
  }

  applyActuatorFaults(act) {
    const out = { pumps: act.pumps.slice(), valves: act.valves.slice(), heaters: act.heaters.slice() };
    if (this.active.pump_trip) out.pumps = out.pumps.map(() => 0);
    if (this.active.heater_fault) {
      const i = this.active.heater_fault.index | 0;
      if (i >= 0 && i < out.heaters.length) out.heaters[i] = 0;
    }
    if (this.active.valve_stuck && out.valves.length) {
      const f = this.active.valve_stuck, i = f.index | 0;
      if (i >= 0 && i < out.valves.length) out.valves[i] = +f.value;
    }
    return out;
  }

  applySensorFaults(state) {
    const f = this.active.sensor_noise;
    if (!f) return state;
    const m = { ...state };
    m.levels = state.levels.map((h) => Math.max(0, h + gauss(+f.level_std)));
    m.temps = state.temps.map((T) => T + gauss(+f.temp_std));
    return m;
  }
}
