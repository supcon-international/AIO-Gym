// Challenge mode — Human vs RL, three picks: exothermic CSTR, two-zone HVAC, or
// the heated-tank cascade. You hand-control the plant; an RL ghost runs the SAME
// seeded disturbances on its OWN identical plant, side by side, so you can watch
// it in real time. Anti-idle scoring: CSTR rewards production (idle = 0); HVAC /
// cascade score = on-spec% × energy-factor (idle drifts off-spec → ~0). Reuses the
// sandbox engine + animated P&ID.
import { Engine } from '../sim/engine.js?v=15';
import { t, setLang, nextLang, applyStatic, onLang } from '../i18n.js?v=15';
import { buildSchematic } from '../schematic.js?v=15';
import { makeScoreboard, toast, selectCard, resultCard } from './hud.js?v=13';

const TICK = 0.05, SPEED = 8, CONTROL_DT = 0.1;
const DURATION_REAL = 60, SIM_TOTAL = DURATION_REAL * SPEED;
const LANG_NAMES = { zh: '中', en: 'EN', ja: '日本語' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------- Level catalogue ----------------
// Each level: which plant, how the player controls it, what the disturbance is,
// and how it's scored (production = profit-rate; comfort = on-spec × energy).
const LEVELS = {
  cstr: {
    scenario: 'cstr', sub: 'exothermic CSTR',
    name: () => t('放热反应器', 'Exothermic CSTR', '発熱反応器'),
    tag: () => t('进取 · 增产 vs 炸炉', 'Aggressive · yield vs runaway', '攻め · 増産 vs 暴走'),
    blurb: () => t('加料赚钱,但放热会逼近热失控。贴着安全边界把产量做到最大。',
      'Feed makes money, but the heat creeps toward runaway. Maximize yield on the safe edge.',
      '供給で利益、但し発熱が暴走へ。安全境界に貼り付いて生産量を最大化。'),
    start: [0.10, 60],
    controls: [
      { kind: 'pump', idx: 0, zh: '进料', en: 'Feed', ja: '供給', hint: () => t('= 赚钱', '= money', '= 利益'), cls: 'feed', init: 55 },
      { kind: 'heater', idx: 0, zh: '冷却', en: 'Cooling', ja: '冷却', cls: 'cool', init: 45 },
    ],
    autoLevel: false,
    disturb: { type: 'cold_inlet', warmBias: 0.5, mag: [4, 9], every: [14, 30], dur: [9, 18] },
    metric: 'production', compare: 'prod', scoreRef: [0, 7],
    bands: [[null, 88]],
  },
  hvac: {
    scenario: 'hvac', sub: 'two-zone HVAC',
    name: () => t('双区空调', 'Two-Zone HVAC', '2ゾーン空調'),
    tag: () => t('防守 · 舒适 vs 省电', 'Defensive · comfort vs energy', '守り · 快適 vs 省エネ'),
    blurb: () => t('两个房间都要待在 20–24° 舒适带,室外忽冷忽热。既舒适又最省电。',
      'Keep both rooms in the 20–24° band as the weather swings. Comfortable AND low-energy.',
      '両室を 20–24° に保つ、外気は変動。快適かつ省エネ。'),
    start: [22, 22],
    controls: [
      { kind: 'heater', idx: 0, zh: '空调·区1', en: 'AC · R1', ja: '空調·室1', cls: 'ac', init: 50 },
      { kind: 'heater', idx: 1, zh: '空调·区2', en: 'AC · R2', ja: '空調·室2', cls: 'ac', init: 50 },
    ],
    autoLevel: false,
    disturb: { type: 'ambient', warmBias: 0.5, mag: [6, 12], every: [13, 28], dur: [11, 21] },
    metric: 'comfort', compare: 'energy', bands: [[20, 24], [20, 24]], energyCap: 0.6,
  },
  cascade: {
    scenario: 'cascade', sub: 'heated-tank cascade',
    name: () => t('多级加热水箱', 'Heated-Tank Cascade', '多段加熱タンク'),
    tag: () => t('防守 · 达标 vs 省能', 'Defensive · on-spec vs energy', '守り · 規格 vs 省エネ'),
    blurb: () => t('三个水箱要各自到温(水位自动保持)。达标的前提下用最少的加热能耗。',
      'Three tanks must each reach temperature (levels auto-held). Stay on-spec at minimum heat.',
      '3タンクを各温度へ(液位は自動)。規格内で加熱を最小に。'),
    start: [0.42, 36, 0.42, 50, 0.42, 64],
    controls: [
      { kind: 'heater', idx: 0, zh: '加热·T1', en: 'Heat · T1', ja: '加熱·T1', cls: 'heat', init: 28 },
      { kind: 'heater', idx: 1, zh: '加热·T2', en: 'Heat · T2', ja: '加熱·T2', cls: 'heat', init: 30 },
      { kind: 'heater', idx: 2, zh: '加热·T3', en: 'Heat · T3', ja: '加熱·T3', cls: 'heat', init: 33 },
    ],
    autoLevel: true,
    disturb: { type: 'cold_inlet', warmBias: 0.4, mag: [4, 9], every: [15, 30], dur: [10, 18] },
    // economic profit-rate (energy + soft-band): RL rides the band to save energy; idle
    // (cold) and over-heating both bleed profit. "on-spec" lamp uses the lower bounds.
    metric: 'production', compare: 'energy', scoreRef: [-185, -108], bands: [[34, null], [48, null], [60, null]],
  },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let tt = Math.imul(a ^ (a >>> 15), 1 | a);
    tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
    return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTimeline(seed, d) {
  const rnd = mulberry32(seed), ev = [];
  let tt = 10 + rnd() * 7;
  while (tt < SIM_TOTAL - 12) {
    const warm = rnd() < d.warmBias;
    const m = d.mag[0] + rnd() * (d.mag[1] - d.mag[0]);
    ev.push({ t: tt, dur: d.dur[0] + rnd() * (d.dur[1] - d.dur[0]), type: d.type, params: { value: +((warm ? m : -m).toFixed(2)) }, warm });
    tt += d.every[0] + rnd() * (d.every[1] - d.every[0]);
  }
  return ev.sort((a, b) => a.t - b.t);
}

// on-spec fraction this step (avg across the level's bands)
function onSpecFrac(temps, bands) {
  let ok = 0;
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i], T = temps[i];
    if ((lo == null || T >= lo) && (hi == null || T <= hi)) ok++;
  }
  return ok / bands.length;
}

class Challenge {
  constructor() {
    this.overlay = document.getElementById('cd-overlay');
    this.card = document.getElementById('cd-card');
    this.clock = document.getElementById('cd-clock');
    this.toastHost = document.getElementById('cd-toast');
    this.board = makeScoreboard();
    this.timer = null; this.phase = 'select'; this.levelKey = null;
    this._bindLang();
    applyStatic(); this._syncLangBtn();
    onLang(() => { this._syncLangBtn(); this._rebuildLangView(); });
    this.showSelect();
  }

  _bindLang() { document.getElementById('cd-lang').addEventListener('click', () => setLang(nextLang())); }
  _syncLangBtn() { document.getElementById('cd-lang').textContent = LANG_NAMES[nextLang()]; }
  _rebuildLangView() {
    if (this.cfg) {
      this.schY = buildSchematic(document.getElementById('cd-arena-you'), this.human.model.metadata());
      this.schR = buildSchematic(document.getElementById('cd-arena-rl'), this.ghost.model.metadata());
      this._buildControls();
      document.getElementById('cd-sub').textContent = this.cfg.sub;
    }
    if (this.phase === 'select') this.showSelect();
    else if (this.phase === 'done') this._showResult();
  }

  showSelect() {
    this.phase = 'select'; this.overlay.hidden = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    selectCard(this.card, LEVELS, (key) => this.pick(key));
  }

  pick(key) {
    this.levelKey = key; this.cfg = LEVELS[key];
    const sc = this.cfg.scenario;
    this.human = new Engine(sc); this.ghost = new Engine(sc);
    for (const e of [this.human, this.ghost]) { e.handleCommand({ type: 'set_auto_events', on: false }); e.handleCommand({ type: 'set_fidelity', level: 1 }); e.running = false; }
    this.ghost.setMode('rl');
    document.getElementById('cd-sub').textContent = this.cfg.sub;
    this.schY = buildSchematic(document.getElementById('cd-arena-you'), this.human.model.metadata());
    this.schR = buildSchematic(document.getElementById('cd-arena-rl'), this.ghost.model.metadata());
    this._buildControls();
    this.start();
  }

  _buildControls() {
    const host = document.getElementById('cd-controls'); host.innerHTML = '';
    this.units = this.cfg.controls.map((c) => c.init / 100);
    this.cfg.controls.forEach((c, j) => {
      const wrap = document.createElement('div'); wrap.className = 'cd-ctl';
      const name = t(c.zh, c.en, c.ja) + (c.hint ? ` <span class="cd-ctl-hint">${c.hint()}</span>` : '');
      wrap.innerHTML = `<div class="cd-ctl-head"><span class="cd-ctl-lbl">${name}</span><span class="cd-ctl-val mono" id="cv${j}"></span></div>`;
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = 0; sl.max = 100; sl.step = 1; sl.value = Math.round(this.units[j] * 100);
      sl.className = 'cd-slider ' + c.cls; sl.id = 'cs' + j;
      wrap.appendChild(sl); host.appendChild(wrap);
      const vv = document.getElementById('cv' + j);
      const setLabel = () => { vv.textContent = c.cls === 'ac' ? acLabel(this.units[j]) : Math.round(this.units[j] * 100) + '%'; };
      sl.addEventListener('input', () => { this.units[j] = +sl.value / 100; setLabel(); });
      setLabel();
    });
    if (this.cfg.controls[0].cls === 'ac') host.insertAdjacentHTML('beforeend',
      `<div class="cd-ac-legend"><span>${t('← 制冷', '← cool', '← 冷房')}</span><span>${t('关', 'off', 'オフ')}</span><span>${t('制热 →', 'heat →', '暖房 →')}</span></div>`);
  }

  start() {
    this.overlay.hidden = true; this.phase = 'play';
    this.seed = (Date.now() >>> 0) ^ 0x9e3779b9;
    this.timeline = buildTimeline(this.seed, this.cfg.disturb);
    this._tlIdx = 0; this._active = [];
    this.tickN = 0; this.simT = 0; this.steps = 0; this.youOk = 0; this.rlOk = 0;
    this.human.reset(); this.ghost.reset();
    for (const e of [this.human, this.ghost]) { e.pid.reset(); e.integ.reset(this.cfg.start.slice()); e.state = e.integ.getState(e.lastAct, e.disturb.environment(), 0); }
    this.units = this.cfg.controls.map((c) => c.init / 100);
    this.cfg.controls.forEach((c, j) => {
      const sl = document.getElementById('cs' + j); if (sl) sl.value = Math.round(this.units[j] * 100);
      const vv = document.getElementById('cv' + j); if (vv) vv.textContent = c.cls === 'ac' ? acLabel(this.units[j]) : Math.round(this.units[j] * 100) + '%';
    });
    this.human.running = this.ghost.running = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this._loop(), TICK * 1000);
  }

  _loop() {
    const dt = TICK * SPEED;
    this._applyTimeline();
    for (let acc = 0; acc < dt - 1e-9; acc += CONTROL_DT) {
      const s = Math.min(CONTROL_DT, dt - acc);
      // player commands: heaters/pumps the player owns; auto-PID holds levels (cascade)
      if (this.cfg.autoLevel) {
        const pa = this.human.pid.compute(this.human.meas || this.human.state, this.human.setpoints, s);
        this.human.manual.setSingle('pump', 0, pa.pumps[0]);
        for (let i = 0; i < pa.valves.length; i++) this.human.manual.setSingle('valve', i, pa.valves[i]);
      }
      this.cfg.controls.forEach((c, j) => this.human.manual.setSingle(c.kind, c.idx, this.units[j]));
      this.human._tick(s); this.ghost._tick(s);
    }
    this.simT += dt; this.tickN++; this.steps++;
    this.youOk += onSpecFrac(this.human.state.temps, this.cfg.bands);
    this.rlOk += onSpecFrac(this.ghost.state.temps, this.cfg.bands);

    this.schY.update(this.human.telemetry());
    this.schR.update(this.ghost.telemetry());
    this.board.update(this._score(this.human, this.youOk), this._score(this.ghost, this.rlOk));
    this._updateCompare();

    const remain = Math.max(0, DURATION_REAL - this.tickN * TICK);
    this.clock.textContent = `0:${Math.floor(remain % 60).toString().padStart(2, '0')}`;
    this.clock.className = 'cd-clock mono' + (remain <= 5 ? ' crit' : remain <= 10 ? ' warn' : '');
    if (this.simT >= SIM_TOTAL) this._end();
  }

  // 0-100 challenge score. production: profit-rate mapped over [idle, ideal].
  // comfort: on-spec fraction × energy factor (idle → off-spec → ~0; on-spec & thrifty → high).
  _score(eng, okAccum) {
    if (this.cfg.metric === 'production') {
      const rt = eng.score.report().econ.profit_rate, [lo, hi] = this.cfg.scoreRef;
      return clamp(100 * (rt - lo) / (hi - lo), 0, 100);
    }
    const onSpec = okAccum / Math.max(1, this.steps);
    const ePen = clamp(eng.score.energy / this.cfg.energyCap, 0, 0.45);
    return clamp(100 * onSpec * (1 - ePen), 0, 100);
  }

  _updateCompare() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    if (this.cfg.compare === 'prod') {
      set('cd-cmp-a', (this.human.score.prod * 1000).toFixed(1));
      set('cd-cmp-b', (this.ghost.score.prod * 1000).toFixed(1));
      const yT = this.human.state.temps[0], lamp = document.getElementById('cd-cmp-c');
      if (lamp) { lamp.textContent = yT.toFixed(0) + '°'; lamp.className = 'cd-cmp-v mono ' + (yT >= 92 ? 'bad' : yT >= 88 ? 'warn' : 'ok'); }
    } else {
      set('cd-cmp-a', this.human.score.energy.toFixed(2));
      set('cd-cmp-b', this.ghost.score.energy.toFixed(2));
      const ok = Math.round(onSpecFrac(this.human.state.temps, this.cfg.bands) * this.cfg.bands.length);
      const lamp = document.getElementById('cd-cmp-c');
      if (lamp) { lamp.textContent = ok + '/' + this.cfg.bands.length; lamp.className = 'cd-cmp-v mono ' + (ok === this.cfg.bands.length ? 'ok' : ok === 0 ? 'bad' : 'warn'); }
    }
    document.getElementById('cd-cmp-c-lbl').textContent = this.cfg.compare === 'prod' ? t('反应温度', 'reactor T', '反応温度') : t('达标', 'on-spec', '規格');
    document.getElementById('cd-cmp-ab-lbl').textContent = this.cfg.compare === 'prod' ? t('产率', 'rate', '生産') : 'kWh';
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
    let msg;
    if (this.cfg.disturb.type === 'ambient') {
      const out = (15 + e.params.value).toFixed(0);
      msg = e.warm ? t(`室外升温到 ${out}° · 该开冷气`, `Outdoor up to ${out}° · cool down`, `室外 ${out}°・冷房を`)
                   : t(`室外降到 ${out}° · 该开暖气`, `Outdoor down to ${out}° · warm up`, `室外 ${out}°・暖房を`);
    } else {
      msg = e.warm ? t(`进料升温 +${e.params.value}° · 当心超温`, `Feed warms +${e.params.value}° · watch temp`, `供給 +${e.params.value}°・温度注意`)
                   : t(`进料降温 ${e.params.value}° · 可加料`, `Feed cools ${e.params.value}° · push feed`, `供給 ${e.params.value}°・増給可`);
    }
    toast(this.toastHost, msg, e.warm && this.cfg.metric === 'production');
  }

  _end() {
    clearInterval(this.timer); this.timer = null;
    this.human.running = this.ghost.running = false;
    this.phase = 'done';
    const you = this._score(this.human, this.youOk), rl = this._score(this.ghost, this.rlOk);
    this._result = {
      metric: this.cfg.metric, compare: this.cfg.compare, you, rl,
      youKwh: this.human.score.energy, rlKwh: this.ghost.score.energy,
      youProd: this.human.score.prod * 1000, rlProd: this.ghost.score.prod * 1000,
      youOk: Math.round(100 * this.youOk / Math.max(1, this.steps)),
      rlOk: Math.round(100 * this.rlOk / Math.max(1, this.steps)),
    };
    this._showResult();
  }
  _showResult() {
    this.overlay.hidden = false;
    resultCard(this.card, this._result, () => this.start(), () => this.showSelect(), () => { location.href = './index.html'; });
  }
}

// AC slider label: 0.5 = off, >0.5 heat, <0.5 cool
function acLabel(u) {
  const k = Math.round(Math.abs(u - 0.5) * 200);
  if (k < 4) return t('关', 'off', 'オフ');
  return (u > 0.5 ? t('暖 ', 'heat ', '暖 ') : t('冷 ', 'cool ', '冷 ')) + k + '%';
}

new Challenge();
