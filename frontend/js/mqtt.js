// MQTT / Unified-Namespace bridge (browser side). Connects the in-browser
// engine to an MQTT broker over WebSocket so external clients (e.g. an RL agent
// in Python) can read state and write actions. Topic/payload style follows
// TIER0 / supcon UNS conventions (plain hierarchical JSON, no Sparkplug):
//
//   base = AIO-Gym/Sim/{Area}/{line}
//   sim  -> base/obs            (retained, full observation vector + setpoints)
//        -> base/reward         (per-step reward + components)
//        -> base/<unit>/state/<metric>   (retained, per-tag, UNS-browsable)
//        -> base/alarms         (on change)
//        -> base/episode/status (retained; LWT -> offline)
//   agent-> base/action         ({action:[pumps..,valves..,heaters..] in [0,1]})  -> takes control
//        -> base/setpoint/<t{i}|h{i}>     ({value})
//        -> base/episode/cmd    ({cmd:reset|start|pause|resume})
//
// mqtt.js is loaded on demand from a CDN only when the user connects.
const MQTT_CDN = 'https://cdn.jsdelivr.net/npm/mqtt@5/dist/mqtt.min.js';
const AREA = { cascade: 'HeatedTankCascade', quadruple: 'QuadrupleTank', cstr: 'CSTR', hvac: 'HVAC' };
const nowISO = () => new Date().toISOString();

export class MqttBridge {
  constructor(engine) {
    this.engine = engine; this.client = null; this.connected = false;
    this.status = '未连接'; this.line = 'env-1'; this._tObs = 0; this._tState = 0; this._alarmKey = '';
  }
  base() { return `AIO-Gym/Sim/${AREA[this.engine.scenario] || 'Process'}/${this.line}`; }
  getStatus() { return { connected: this.connected, status: this.status, base: this.base() }; }

  async connect(url, line) {
    if (line) this.line = line.trim() || 'env-1';
    this.status = '连接中…';
    try {
      if (!window.mqtt) await loadScript(MQTT_CDN);
      const base = this.base();
      this.client = window.mqtt.connect(url, {
        clean: true, connectTimeout: 8000, reconnectPeriod: 0,
        will: { topic: `${base}/episode/status`, payload: JSON.stringify({ ts: nowISO(), state: 'offline' }), qos: 1, retain: true },
      });
      this.client.on('connect', () => {
        this.connected = true; this.status = '已连接 · ' + url;
        this.client.subscribe([`${base}/action`, `${base}/setpoint/+`, `${base}/episode/cmd`], { qos: 1 });
        this._pubEpisode('running');
      });
      this.client.on('message', (t, p) => this._onMsg(t, p));
      this.client.on('error', (e) => { this.status = '错误: ' + (e.message || e); });
      this.client.on('close', () => { if (this.connected) this.status = '已断开'; this.connected = false; });
      return true;
    } catch (e) { this.status = '失败: ' + e.message; return false; }
  }
  disconnect() {
    if (this.client) { try { this._pubEpisode('offline'); } catch (e) {} this.client.end(true); }
    this.client = null; this.connected = false; this.status = '未连接';
  }

  // called every engine frame; throttles publish rates
  publish(f) {
    if (!this.connected || !this.client) return;
    const base = this.base(), now = performance.now();
    if (now - this._tObs >= 100) {                 // ~10 Hz: obs + reward
      this._tObs = now;
      const rew = this.engine.reward();
      this.client.publish(`${base}/obs`, JSON.stringify({
        ts: nowISO(), t: f.t, scenario: f.scenario, mode: f.mode,
        obs: this.engine.obs(), setpoint: { t_sp: f.setpoints.t_sp, h_sp: f.setpoints.h_sp },
        action_dim: this.engine.actionDim(), terminated: false, truncated: false,
      }), { qos: 0, retain: true });
      this.client.publish(`${base}/reward`, JSON.stringify({ ts: nowISO(), t: f.t, ...rew }), { qos: 0 });
    }
    if (now - this._tState >= 500) {               // ~2 Hz: per-tag UNS state
      this._tState = now;
      f.state.temps.forEach((v, i) => this.client.publish(`${base}/unit-${i + 1}/state/temperature`, JSON.stringify({ ts: nowISO(), value: +v.toFixed(3), unit: 'degC' }), { qos: 0, retain: true }));
      f.state.levels.forEach((v, i) => this.client.publish(`${base}/unit-${i + 1}/state/level`, JSON.stringify({ ts: nowISO(), value: +v.toFixed(4), unit: 'm' }), { qos: 0, retain: true }));
    }
    const ak = JSON.stringify(f.alarms.map((a) => a.type + a.tank));
    if (ak !== this._alarmKey) { this._alarmKey = ak; this.client.publish(`${base}/alarms`, JSON.stringify({ ts: nowISO(), alarms: f.alarms }), { qos: 1 }); }
  }

  _pubEpisode(state) {
    if (this.client) this.client.publish(`${this.base()}/episode/status`, JSON.stringify({ ts: nowISO(), state, scenario: this.engine.scenario }), { qos: 1, retain: true });
  }
  _onMsg(topic, payload) {
    let m = {}; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
    const base = this.base();
    if (topic === `${base}/action`) this.engine.handleCommand({ type: 'set_action', action: m.action || m.values || m });
    else if (topic === `${base}/episode/cmd`) {
      const c = m.cmd;
      if (c === 'reset') this.engine.handleCommand({ type: 'reset' });
      else if (c === 'pause') this.engine.handleCommand({ type: 'set_running', running: false });
      else if (c === 'start' || c === 'resume') this.engine.handleCommand({ type: 'set_running', running: true });
    } else if (topic.startsWith(`${base}/setpoint/`)) {
      const mt = /([th])(\d+)$/.exec(topic.split('/').pop());
      if (mt) { const sp = this.engine.setpoints, arr = mt[1] === 't' ? sp.t_sp : sp.h_sp, i = +mt[2] - 1; if (i >= 0 && i < arr.length && m.value != null) arr[i] = +m.value; }
    }
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('无法加载 mqtt.js (离线?)'));
    document.head.appendChild(s);
  });
}
