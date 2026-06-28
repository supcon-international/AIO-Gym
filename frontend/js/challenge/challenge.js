// Challenge mode — Human vs RL on the two-zone HVAC. You hand-control both AC
// units (cool ↔ off ↔ heat) to keep each room inside the comfort band [20,24]°C
// against an outdoor temperature that swings hot/cold — using the LEAST energy.
// An RL ghost runs the SAME seeded disturbances. Higher economic score wins.
// Reuses the sandbox engine + animated P&ID.
import { Engine } from '../sim/engine.js?v=15';
import { t, setLang, nextLang, applyStatic, onLang } from '../i18n.js?v=15';
import { buildSchematic } from '../schematic.js?v=15';
import { makeScoreboard, toast, introCard, resultCard } from './hud.js?v=9';

const SCENARIO = 'hvac';
const TICK = 0.05, SPEED = 8, CONTROL_DT = 0.1;
const DURATION_REAL = 60, SIM_TOTAL = DURATION_REAL * SPEED;
const N = 2;
const BANDS = [[20, 24], [20, 24]];                  // comfort bands (mirrors scoring ECON hvac)
const START = [22, 22];                              // both rooms start mid-band, on-spec
const UNIT0 = [0.5, 0.5];                            // 0.5 = AC off (neutral)
const LANG_NAMES = { zh: '中', en: 'EN', ja: '日本語' };
// Challenge-calibrated economic score: map per-step profit-rate to 0-100 over
// [idle/frozen, ideal]. scoring.js's ECON_REF is tuned for the sandbox's wider
// operating range and clamps every decent player to 100 here — useless for a
// head-to-head. This range keeps the good-strategy zone (where you and the RL
// both live) resolvable, so the better operator actually wins.
const SCORE_REF = [-32, 0];
const scoreOf = (eng) => {
  const rt = eng.score.report().econ.profit_rate;
  return Math.max(0, Math.min(100, 100 * (rt - SCORE_REF[0]) / (SCORE_REF[1] - SCORE_REF[0])));
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let tt = Math.imul(a ^ (a >>> 15), 1 | a);
    tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
    return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic timeline of outdoor-temperature swings: the weather turns hot or
// cold, dragging both rooms off the comfort band — you must work the AC to hold
// 20-24°C without over-spending energy.
function buildTimeline(seed) {
  const rnd = mulberry32(seed), ev = [];
  let tt = 9 + rnd() * 7;
  while (tt < SIM_TOTAL - 12) {
    const hot = rnd() < 0.5;
    const mag = hot ? (8 + rnd() * 9) : -(8 + rnd() * 9);   // outdoor jumps to ~28-37 or ~2-11°C
    ev.push({ t: tt, dur: 11 + rnd() * 10, type: 'ambient', params: { value: +mag.toFixed(2) }, hot });
    tt += 13 + rnd() * 15;
  }
  return ev.sort((a, b) => a.t - b.t);
}

class Challenge {
  constructor() {
    this.human = new Engine(SCENARIO);
    this.ghost = new Engine(SCENARIO);
    for (const e of [this.human, this.ghost]) { e.handleCommand({ type: 'set_auto_events', on: false }); e.handleCommand({ type: 'set_fidelity', level: 1 }); e.running = false; }
    this.ghost.setMode('rl');                        // loads rlpd_hvac.onnx (async; ready by start)
    this.units = UNIT0.slice();
    this.schematic = buildSchematic(document.getElementById('cd-arena'), this.human.model.metadata());
    this.board = makeScoreboard();
    this.toastHost = document.getElementById('cd-toast');
    this.overlay = document.getElementById('cd-overlay');
    this.card = document.getElementById('cd-card');
    this.clock = document.getElementById('cd-clock');
    this.timer = null; this.phase = 'intro';
    this._bindControls(); this._bindLang();
    applyStatic(); this._syncLangBtn();
    onLang(() => { this._syncLangBtn(); this._rebuildLangView(); });
    this.showIntro();
  }

  _bindControls() {
    this.sliders = [];
    for (let i = 0; i < N; i++) {
      const sl = document.getElementById('cd-h' + i), vv = document.getElementById('cd-h' + i + '-val');
      this.sliders.push(sl);
      sl.addEventListener('input', () => { this.units[i] = +sl.value / 100; vv.textContent = acLabel(this.units[i]); });
    }
  }
  _bindLang() { document.getElementById('cd-lang').addEventListener('click', () => setLang(nextLang())); }
  _syncLangBtn() { document.getElementById('cd-lang').textContent = LANG_NAMES[nextLang()]; }
  _rebuildLangView() {
    this.schematic = buildSchematic(document.getElementById('cd-arena'), this.human.model.metadata());
    for (let i = 0; i < N; i++) document.getElementById('cd-h' + i + '-val').textContent = acLabel(this.units[i]);
    if (this.phase === 'intro') this.showIntro();
    else if (this.phase === 'done') this._showResult();
  }

  showIntro() { this.phase = 'intro'; this.overlay.hidden = false; introCard(this.card, () => this.start()); }

  start() {
    this.overlay.hidden = true; this.phase = 'play';
    this.seed = (Date.now() >>> 0) ^ 0x9e3779b9;
    this.timeline = buildTimeline(this.seed);
    this._tlIdx = 0; this._active = [];
    this.tickN = 0; this.simT = 0; this.steps = 0; this.okSteps = [0, 0];
    this.human.reset(); this.ghost.reset();
    for (const e of [this.human, this.ghost]) { e.integ.reset(START.slice()); e.state = e.integ.getState(e.lastAct, e.disturb.environment(), 0); }
    this.units = UNIT0.slice();
    for (let i = 0; i < N; i++) {
      this.sliders[i].value = Math.round(this.units[i] * 100);
      document.getElementById('cd-h' + i + '-val').textContent = acLabel(this.units[i]);
      this.human.handleCommand({ type: 'manual_cmd', kind: 'heater', index: i, value: this.units[i] });
    }
    this.human.running = this.ghost.running = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._loop(), TICK * 1000);
  }

  _loop() {
    const dt = TICK * SPEED;
    this._applyTimeline();
    // keep the player's latest AC commands applied (bare-hands manual, no inner PID)
    for (let i = 0; i < N; i++) this.human.manual.setSingle('heater', i, this.units[i]);
    for (let acc = 0; acc < dt - 1e-9; acc += CONTROL_DT) {
      const s = Math.min(CONTROL_DT, dt - acc);
      this.human._tick(s);
      this.ghost._tick(s);
    }
    this.simT += dt; this.tickN++; this.steps++;

    const yT = this.human.state.temps;
    for (let i = 0; i < N; i++) if (yT[i] >= BANDS[i][0] && yT[i] <= BANDS[i][1]) this.okSteps[i]++;

    this.schematic.update(this.human.telemetry());
    this.board.update(scoreOf(this.human), scoreOf(this.ghost));
    this._updateCompare(yT);

    const remain = Math.max(0, DURATION_REAL - this.tickN * TICK);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    this.clock.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    this.clock.className = 'cd-clock mono' + (remain <= 5 ? ' crit' : remain <= 10 ? ' warn' : '');

    if (this.simT >= SIM_TOTAL) this._end();
  }

  _updateCompare(yT) {
    document.getElementById('cd-you-kwh').textContent = this.human.score.energy.toFixed(3);
    document.getElementById('cd-rl-kwh').textContent = this.ghost.score.energy.toFixed(3);
    const ok = yT.reduce((a, T, i) => a + (T >= BANDS[i][0] && T <= BANDS[i][1] ? 1 : 0), 0);
    const lamp = document.getElementById('cd-onspec');
    lamp.textContent = ok + '/2'; lamp.className = 'cd-cmp-v mono ' + (ok === 2 ? 'ok' : ok === 0 ? 'bad' : 'warn');
  }

  _applyTimeline() {
    while (this._tlIdx < this.timeline.length && this.timeline[this._tlIdx].t <= this.simT) {
      const e = this.timeline[this._tlIdx++];
      this.human.handleCommand({ type: 'set_disturbance', dtype: e.type, params: e.params });
      this.ghost.handleCommand({ type: 'set_disturbance', dtype: e.type, params: e.params });
      this._active.push({ type: e.type, until: this.simT + e.dur });
      this._notify(e);
    }
    for (let i = this._active.length - 1; i >= 0; i--) {
      if (this.simT >= this._active[i].until) {
        const ty = this._active[i].type;
        this.human.handleCommand({ type: 'clear_disturbance', dtype: ty });
        this.ghost.handleCommand({ type: 'clear_disturbance', dtype: ty });
        this._active.splice(i, 1);
      }
    }
  }

  _notify(e) {
    const out = (15 + e.params.value).toFixed(0);
    const msg = e.hot
      ? t(`室外升温到 ${out}° · 该开冷气`, `Outdoor up to ${out}° · cool it down`, `室外 ${out}° に上昇・冷房を`)
      : t(`室外降到 ${out}° · 该开暖气`, `Outdoor down to ${out}° · warm it up`, `室外 ${out}° に低下・暖房を`);
    toast(this.toastHost, msg, e.hot);
  }

  _end() {
    clearInterval(this.timer); this.timer = null;
    this.human.running = this.ghost.running = false;
    this.phase = 'done';
    this._result = {
      you: scoreOf(this.human), rl: scoreOf(this.ghost),
      youKwh: this.human.score.energy, rlKwh: this.ghost.score.energy,
      youOk: Math.round(100 * this.okSteps.reduce((a, b) => a + b, 0) / (N * Math.max(1, this.steps))),
    };
    this._showResult();
  }
  _showResult() {
    this.overlay.hidden = false;
    resultCard(this.card, this._result, () => this.start(), () => { location.href = './index.html'; });
  }
}

// AC slider label: 0.5 = off, >0.5 heat, <0.5 cool
function acLabel(u) {
  const k = Math.round(Math.abs(u - 0.5) * 200);
  if (k < 4) return t('关', 'off', 'オフ');
  return (u > 0.5 ? t('暖 ', 'heat ', '暖 ') : t('冷 ', 'cool ', '冷 ')) + k + '%';
}

new Challenge();
