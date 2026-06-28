// Challenge mode — Human vs RL on the exothermic CSTR. Two independent Engine
// instances (you = bare-hands manual cooling+feed, RL = its supervisory policy)
// run the SAME seeded disturbance timeline in lock-step. Whoever earns more wins.
import { Engine } from '../sim/engine.js?v=15';
import { t, lang, setLang, nextLang, applyStatic, onLang } from '../i18n.js?v=15';
import { mountArena, mountCurve, makeScoreboard, toast, introCard, resultCard, T_ECO, T_TRIP } from './hud.js?v=1';

const SCENARIO = 'cstr';
const TICK = 0.05;            // engine tick (s), matches the sandbox
const SPEED = 8;             // sim acceleration → 60 s real ≈ 480 s sim (< 600 s episode, so no reset)
const CONTROL_DT = 0.1;     // inner control/integration sub-step — decoupled from SPEED so the
                            // PID/RL loop stays fast enough that the exothermic feedback can't overshoot to trip
const DURATION_REAL = 60;    // one round, in wall-clock seconds
const SIM_TOTAL = DURATION_REAL * SPEED;
const CURVE_EVERY = 10;      // push a trace point every N ticks (~0.5 s real)
const LANG_NAMES = { zh: '中', en: 'EN', ja: '日本語' };

// deterministic PRNG so a round (seed) is exactly replayable for both players
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let tt = Math.imul(a ^ (a >>> 15), 1 | a);
    tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
    return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a deterministic disturbance timeline (cold-inlet swings ± a little sensor noise).
// Cold-inlet raises/lowers feed temperature → directly perturbs the reactor heat balance.
function buildTimeline(seed) {
  const rnd = mulberry32(seed), ev = [];
  let tt = 10 + rnd() * 8;
  while (tt < SIM_TOTAL - 12) {
    const warm = rnd() < 0.5;                       // half are heat-up swings (the dangerous ones)
    const mag = warm ? 4 + rnd() * 5 : -(3 + rnd() * 4);
    ev.push({ t: tt, dur: 9 + rnd() * 9, type: 'cold_inlet', params: { value: +mag.toFixed(2) }, warm });
    tt += 14 + rnd() * 16;
  }
  if (rnd() < 0.6) { const nt = SIM_TOTAL * (0.4 + rnd() * 0.3); ev.push({ t: nt, dur: 12, type: 'sensor_noise', params: { temp_std: 1.2, level_std: 0 }, noise: true }); }
  return ev.sort((a, b) => a.t - b.t);
}

class Challenge {
  constructor() {
    this.human = new Engine(SCENARIO);
    this.ghost = new Engine(SCENARIO);
    for (const e of [this.human, this.ghost]) { e.handleCommand({ type: 'set_auto_events', on: false }); e.handleCommand({ type: 'set_fidelity', level: 1 }); e.running = false; }
    this.ghost.setMode('rl');                         // loads rlpd_cstr.onnx (async; ready within the intro read-time)
    this.arena = mountArena(document.getElementById('cd-arena'));
    this.curve = mountCurve(document.getElementById('cd-curve'));
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
    const cool = document.getElementById('cd-cool'), feed = document.getElementById('cd-feed');
    const coolV = document.getElementById('cd-cool-val'), feedV = document.getElementById('cd-feed-val');
    this.cool = cool; this.feed = feed;
    cool.addEventListener('input', () => { coolV.textContent = cool.value + '%'; this.human.handleCommand({ type: 'manual_cmd', kind: 'heater', index: 0, value: +cool.value / 100 }); });
    feed.addEventListener('input', () => { feedV.textContent = feed.value + '%'; this.human.handleCommand({ type: 'manual_cmd', kind: 'pump', index: 0, value: +feed.value / 100 }); });
  }
  _bindLang() { document.getElementById('cd-lang').addEventListener('click', () => setLang(nextLang())); }
  _syncLangBtn() { document.getElementById('cd-lang').textContent = LANG_NAMES[nextLang()]; }
  _rebuildLangView() {
    this.arena = mountArena(document.getElementById('cd-arena'));   // arena labels are localized
    if (this.phase === 'intro') this.showIntro();
    else if (this.phase === 'done') this._showResult();
  }

  showIntro() {
    this.phase = 'intro';
    this.overlay.hidden = false;
    introCard(this.card, () => this.start());
  }

  start() {
    this.overlay.hidden = true;
    this.phase = 'play';
    this.seed = (Date.now() >>> 0) ^ 0x9e3779b9;
    this.timeline = buildTimeline(this.seed);
    this._tlIdx = 0; this._active = [];           // pending / active disturbance events
    this.tickN = 0; this.simT = 0;
    this.youOver = 0; this.rlOver = 0; this.youTrip = false; this.rlTrip = false;
    // reset both plants, re-apply the player's current slider positions
    this.human.reset(); this.ghost.reset(); this.curve.reset();
    // Start near a working steady state. The model's cold Ca=0.5 / T=50 start ignites a
    // large exothermic transient that overshoots to ~90° (can trip) before the operator
    // has even begun — unfair and confusing. Begin in the band where the game is played.
    for (const e of [this.human, this.ghost]) { e.integ.reset([0.10, 60]); e.state = e.integ.getState(e.lastAct, e.disturb.environment(), 0); }
    this.human.handleCommand({ type: 'manual_cmd', kind: 'heater', index: 0, value: +this.cool.value / 100 });
    this.human.handleCommand({ type: 'manual_cmd', kind: 'pump', index: 0, value: +this.feed.value / 100 });
    this.human.running = this.ghost.running = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._loop(), TICK * 1000);
  }

  _loop() {
    const dt = TICK * SPEED;
    this._applyTimeline();
    // sub-step the inner loop: coarse control steps let the exothermic feedback overshoot toward trip
    for (let acc = 0; acc < dt - 1e-9; acc += CONTROL_DT) { const s = Math.min(CONTROL_DT, dt - acc); this.human._tick(s); this.ghost._tick(s); }
    this.simT += dt; this.tickN++;

    const youT = this.human.state.temps[0], rlT = this.ghost.state.temps[0];
    if (youT > T_ECO) this.youOver += dt; if (rlT > T_ECO) this.rlOver += dt;
    if (this.human.mask.pump_trip) this.youTrip = true;
    if (this.ghost.mask.pump_trip) this.rlTrip = true;

    this.arena.update(youT, rlT);
    this.board.update(this.human.score.econProfit, this.ghost.score.econProfit);
    if (this.tickN % CURVE_EVERY === 0) this.curve.push(youT, rlT);

    const remain = Math.max(0, DURATION_REAL - this.tickN * TICK);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    this.clock.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    this.clock.className = 'cd-clock mono' + (remain <= 5 ? ' crit' : remain <= 10 ? ' warn' : '');

    if (this.simT >= SIM_TOTAL) this._end();
  }

  // Inject each timeline event into BOTH engines at its sim time, clear it when it expires.
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
    let msg, fault = false;
    if (e.noise) { msg = t('传感器噪声 · 读数变脏', 'Sensor noise · readings get noisy', 'センサーノイズ・測定値が乱れる'); }
    else if (e.warm) { msg = t(`进料升温 +${e.params.value}° · 当心超温`, `Feed warms +${e.params.value}° · watch the temp`, `供給が +${e.params.value}° 上昇・温度注意`); fault = true; }
    else { msg = t(`进料降温 ${e.params.value}° · 可趁机加料`, `Feed cools ${e.params.value}° · room to push feed`, `供給が ${e.params.value}° 低下・増給の好機`); }
    toast(this.toastHost, msg, fault);
  }

  _end() {
    clearInterval(this.timer); this.timer = null;
    this.human.running = this.ghost.running = false;
    this.phase = 'done';
    this._result = {
      you: this.human.score.econProfit, rl: this.ghost.score.econProfit,
      youOver: this.youOver, rlOver: this.rlOver, youTrip: this.youTrip, rlTrip: this.rlTrip,
    };
    this._showResult();
  }
  _showResult() {
    this.overlay.hidden = false;
    resultCard(this.card, this._result, () => this.start(), () => { location.href = './index.html'; });
  }
}

new Challenge();
