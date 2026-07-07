// Challenge mode — Human vs RL across four plants (CSTR / HVAC / fired heater /
// tank cascade). You hand-control the plant; an RL ghost runs the SAME seeded
// disturbances on its OWN identical plant, side by side. ONE money yardstick for
// every level (mirrors the sandbox's priced economics): profit-rate in ¥/h =
// product credit − energy×price − off-spec penalty. Costs are negative; HIGHER
// always wins. Anti-idle: idling drifts off-spec and the penalty dwarfs the
// energy saved. Reuses the sandbox engine + animated P&ID.
import { Engine } from '../sim/engine.js?v=26';
import { t, setLang, nextLang, applyStatic, onLang } from '../i18n.js?v=26';
import { buildSchematic } from '../schematic.js?v=26';
import { makeScoreboard, toast, selectCard, resultCard } from './hud.js?v=14';

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
    money: 'profit', compare: 'prod',
    wizard: () => [
      { at: '.cd-arena', title: t('目标:贴着 <span class="em">88°C</span> 跑', 'Goal: ride close to <span class="em">88°C</span>', '目標:<span class="em">88°C</span> ギリギリで運転'),
        body: t('这是放热反应器:越热反应越快、产量越高、赚得越多。上面两台一样的反应器,左边你开,右边 RL 开。', 'An exothermic reactor: hotter = faster reaction = more yield = more money. Two identical reactors — you run the left one, the RL runs the right.', '発熱反応器:高温ほど反応が速く生産も利益も大。同じ反応器が2基 — 左があなた、右が RL。') },
      { at: '#cd-controls', title: t('操作:进料赚钱,冷却保命', 'Controls: feed earns, cooling saves you', '操作:供給で稼ぎ、冷却で守る'),
        body: t('<b>进料</b>拉高 = 赚钱更快,但放热也更猛;<b>冷却</b>压住温度。加料越狠,冷却就要跟得越紧。', '<b>Feed</b> up = earn faster, but more heat released; <b>Cooling</b> holds the temperature down. The harder you feed, the harder you must cool.', '<b>供給</b>を上げるほど稼げるが発熱も激しい;<b>冷却</b>で温度を抑える。攻めるほど冷却も強く。') },
      { at: '.cd-arena', title: t('红线:<span class="em">92°C</span> 失控联锁', 'Red line: runaway trip at <span class="em">92°C</span>', 'レッドライン:<span class="em">92°C</span> で暴走遮断'),
        body: t('冲过 <span class="crit">92°C</span> 反应失控,安全联锁会<span class="crit">切断进料</span>——产量归零,眼睁睁看 RL 赚钱。', 'Past <span class="crit">92°C</span> the reaction runs away and the interlock <span class="crit">cuts your feed</span> — production stops while the RL keeps earning.', '<span class="crit">92°C</span> を超えると暴走、インターロックが<span class="crit">供給を遮断</span> — 生産停止、RL だけが稼ぎ続ける。') },
      { at: '.cd-board', title: t('比什么:利润 ¥/h', 'Scoring: profit ¥/h', '勝負:利益 ¥/h'),
        body: t('产量赚钱、冷却费电,合成<b>利润 ¥/h</b>,高者胜。RL 和你面对完全相同的扰动。', 'Yield earns, cooling costs — the net is <b>profit ¥/h</b>, higher wins. The RL faces exactly the same disturbances as you.', '生産で稼ぎ冷却は電気代 — 差引<b>利益 ¥/h</b>、高い方が勝ち。RL は同じ外乱に直面。') },
    ],
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
    money: 'cost', compare: 'energy', bands: [[20, 24], [20, 24]],
    wizard: () => [
      { at: '.cd-arena', title: t('目标:两室都保 <span class="em">20–24°C</span>', 'Goal: keep both rooms in <span class="em">20–24°C</span>', '目標:両室を <span class="em">20–24°C</span> に'),
        body: t('房间绿色 = 在舒适带内。室外温度会忽冷忽热,把房间拖出舒适带。', 'Green rooms = inside the comfort band. The outdoor weather swings hot and cold and drags the rooms off it.', '緑の部屋 = 快適帯内。外気温が急変し、部屋を帯域外へ引っ張る。') },
      { at: '#cd-controls', title: t('操作:一台空调一根滑杆', 'Controls: one slider per AC unit', '操作:空調1台に1スライダー'),
        body: t('<b>左 = 制冷,中间 = 关,右 = 制热</b>。开得越猛越费电——刚好够用才是最省的。', '<b>Left = cool, centre = off, right = heat</b>. The harder it runs, the more it costs — "just enough" is the cheap way.', '<b>左 = 冷房、中央 = オフ、右 = 暖房</b>。強いほど電気代がかさむ — 「ちょうど良い」が最安。') },
      { at: '.cd-board', title: t('比什么:电费 ¥/h', 'Scoring: electricity ¥/h', '勝負:電気代 ¥/h'),
        body: t('比<b>运行成本 ¥/h</b>,低者胜。注意:房间一旦出带,罚款很快就超过省下的那点电费。', 'Lowest <b>operating cost ¥/h</b> wins. Careful: once a room drifts off-band, the penalty quickly outgrows whatever power you saved.', '<b>運転コスト ¥/h</b> が低い方の勝ち。部屋が帯域を外れると、ペナルティは節電分をすぐ上回る。') },
    ],
  },
  heater: {
    scenario: 'heater', sub: 'refinery fired heater',
    name: () => t('管式加热炉', 'Fired Heater', '管式加熱炉'),
    tag: () => t('平衡 · 省燃料 vs 缺氧熄火', 'Balance · fuel vs low-O₂ trip', 'バランス · 省燃料 vs 低O₂遮断'),
    blurb: () => t('把出口温度稳在 370°C:火大费燃料,风大偷热,风太小 → 低氧联锁切燃料。燃料热值还会漂移。',
      'Hold the outlet at 370°C: more fuel costs, excess air steals heat, too little air trips the burner. Fuel quality drifts too.',
      '出口を 370°C に保つ:燃料は高い、過剰空気は熱を奪う、空気不足はバーナー遮断。燃料品質も変動。'),
    start: [700, 364, 3.4],
    controls: [
      { kind: 'heater', idx: 0, zh: '燃料', en: 'Fuel', ja: '燃料', hint: () => t('= 成本', '= cost', '= コスト'), cls: 'heat', init: 45 },
      { kind: 'valve', idx: 0, zh: '风门', en: 'Air damper', ja: 'ダンパー', cls: 'cool', init: 55 },
    ],
    autoLevel: false,
    disturb: { type: 'fuel_lhv', warmBias: 0.5, mag: [0.08, 0.15], every: [14, 28], dur: [12, 22] },
    money: 'cost', compare: 'energy', bands: [[362, 378]],
    wizard: () => [
      { at: '.cd-arena', title: t('目标:出口稳在 <span class="em">362–378°C</span>', 'Goal: hold the outlet in <span class="em">362–378°C</span>', '目標:出口を <span class="em">362–378°C</span> に'),
        body: t('燃料在炉膛烧,把盘管里的进料加热到出口温度(大字)。出了 <b>362–378</b> 这个窗就在亏罚款(过冷过热都罚)——出口数字变<b>黄</b>就是出带了。', 'Fuel fires the box and heats the feed coil to the outlet temperature (the big number). Outside the <b>362–378</b> window you bleed penalties (too cold AND too hot) — the readout turns <b>amber</b> when off-band.', '燃料が炉を焚き、コイル内の供給を出口温度(大きな数字)まで加熱。<b>362–378</b> の窓を外れるとペナルティ(低すぎも高すぎも) — 帯域外で数字が<b>黄色</b>に。') },
      { at: '#cd-controls', title: t('操作:燃料烧钱,风门给氧', 'Controls: fuel burns money, the damper feeds air', '操作:燃料は金、ダンパーは空気'),
        body: t('<b>燃料</b>越大越热也越烧钱;<b>风门</b>控制助燃风——风太大,多余空气把热量从烟囱带走(费燃料);风太小,缺氧。', '<b>Fuel</b> up = hotter but pricier; the <b>damper</b> sets combustion air — too much and excess air steals heat up the stack (wasting fuel), too little and you starve the flame.', '<b>燃料</b>を上げれば高温だが高コスト;<b>ダンパー</b>は燃焼空気 — 多すぎると余剰空気が熱を煙突へ奪い(燃料浪費)、少なすぎると酸欠。') },
      { at: '.cd-arena', title: t('红线:O₂ < <span class="em">1.2%</span> 切燃料', 'Red line: O₂ < <span class="em">1.2%</span> trips the burner', 'レッドライン:O₂ < <span class="em">1.2%</span> で燃料遮断'),
        body: t('看烟囱旁的 O₂ 读数。为省燃料把风关太小,O₂ 跌破 <span class="crit">1.2%</span>,燃烧器联锁<span class="crit">切断燃料</span>——温度崩盘。', 'Watch the O₂ readout by the stack. Choke the air to save fuel and when O₂ drops below <span class="crit">1.2%</span> the burner interlock <span class="crit">cuts the fuel</span> — temperature collapses.', '煙突横の O₂ 表示に注目。空気を絞りすぎて O₂ が <span class="crit">1.2%</span> を割るとバーナー遮断で<span class="crit">燃料カット</span> — 温度崩壊。') },
      { at: '.cd-board', title: t('比什么:运行成本 ¥/h', 'Scoring: operating cost ¥/h', '勝負:運転コスト ¥/h'),
        body: t('燃料费 + 罚款 = <b>运行成本 ¥/h</b>,低者胜。燃料热值还会漂移——同样的阀位,火力会变。', 'Fuel bill + penalties = <b>operating cost ¥/h</b>, lower wins. Fuel quality drifts too — the same valve gives a changing flame.', '燃料費 + ペナルティ = <b>運転コスト ¥/h</b>、低い方が勝ち。燃料品質も変動 — 同じ弁開度でも火力が変わる。') },
    ],
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
      { kind: 'heater', idx: 0, zh: '加热·T1', en: 'Heat · T1', ja: '加熱·T1', cls: 'heat', init: 14 },
      { kind: 'heater', idx: 1, zh: '加热·T2', en: 'Heat · T2', ja: '加熱·T2', cls: 'heat', init: 16 },
      { kind: 'heater', idx: 2, zh: '加热·T3', en: 'Heat · T3', ja: '加熱·T3', cls: 'heat', init: 18 },
    ],
    autoLevel: true,
    disturb: { type: 'cold_inlet', warmBias: 0.4, mag: [4, 9], every: [15, 30], dur: [10, 18] },
    money: 'cost', compare: 'energy', bands: [[34, 44], [48, 58], [60, 72]],
    wizard: () => [
      { at: '.cd-arena', title: t('目标:三罐各守一个温度窗', 'Goal: hold each tank in its temperature window', '目標:各タンクを温度ウィンドウ内に'),
        body: t('水从左往右逐罐流过,每罐一个温度窗:<b>T1 34–44、T2 48–58、T3 60–72°C</b>。出窗(过冷或过热)都罚钱。水位是自动的,你只管温度。', 'Water flows left to right through the tanks; each has a temperature window: <b>T1 34–44, T2 48–58, T3 60–72 °C</b>. Off-window (too cold OR too hot) is penalised. Levels hold themselves — you only own the temperatures.', '水は左から右へ流れ、各タンクに温度ウィンドウ:<b>T1 34–44、T2 48–58、T3 60–72°C</b>。外れると(低すぎも高すぎも)ペナルティ。液位は自動 — あなたは温度だけ。') },
      { at: '#cd-controls', title: t('操作:三根加热滑杆', 'Controls: three heater sliders', '操作:3本の加熱スライダー'),
        body: t('每根滑杆管一个罐的加热器。上游罐的热水会流进下游罐——<b>把热花在上游,下游能省</b>。', 'One slider per tank heater. Hot water from an upstream tank flows into the next — <b>heat spent upstream saves money downstream</b>.', '各スライダーが1タンクのヒーター。上流の熱水は下流へ流れる — <b>上流で加熱すれば下流は節約</b>。') },
      { at: '.cd-board', title: t('比什么:电费 ¥/h', 'Scoring: electricity ¥/h', '勝負:電気代 ¥/h'),
        body: t('比<b>运行成本 ¥/h</b>,低者胜:出窗要罚款,烧过头还白费电——贴着各自窗的下沿最省。', 'Lowest <b>operating cost ¥/h</b> wins: off-window costs penalties and overshooting wastes power on top — riding each window\'s lower edge is cheapest.', '<b>運転コスト ¥/h</b> が低い方の勝ち:ウィンドウ外はペナルティ、過熱は電力も浪費 — 各ウィンドウの下端に沿うのが最安。') },
    ],
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
    this._bindLang(); this._bindHelp();
    applyStatic(); this._syncLangBtn();
    onLang(() => { this._syncLangBtn(); this._rebuildLangView(); });
    this.showSelect();
  }

  _bindLang() { document.getElementById('cd-lang').addEventListener('click', () => setLang(nextLang())); }
  _bindHelp() {
    document.getElementById('cd-help').addEventListener('click', () => {
      if (!this.cfg || !this.cfg.wizard || this._wiz) return;
      const wasPlaying = this.phase === 'play' && !!this.timer;
      if (wasPlaying) { clearInterval(this.timer); this.timer = null; }   // pause the race
      this.showWizard(() => { if (wasPlaying) this.timer = setInterval(() => this._loop(), TICK * 1000); });
    });
    window.addEventListener('resize', () => { if (this._wiz) this._renderWizStep(); });
  }

  // ---- guided wizard: spotlight a real UI region per step + a step card ----
  showWizard(onDone) {
    this._wiz = { steps: this.cfg.wizard(), i: 0, onDone };
    document.getElementById('cd-wiz').hidden = false;
    this._renderWizStep();
  }
  _closeWizard() {
    const done = this._wiz && this._wiz.onDone;
    this._wiz = null;
    document.getElementById('cd-wiz').hidden = true;
    if (done) done();
  }
  _renderWizStep() {
    const wz = this._wiz; if (!wz) return;
    wz.steps = this.cfg.wizard();                     // re-localize on language switch
    const st = wz.steps[wz.i], n = wz.steps.length;
    const hole = document.getElementById('cd-wiz-hole');
    const tgt = document.querySelector(st.at);
    const r = tgt ? tgt.getBoundingClientRect() : { left: 20, top: 80, width: innerWidth - 40, height: 200 };
    const pad = 6;
    hole.style.left = (r.left - pad) + 'px'; hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + 2 * pad) + 'px'; hole.style.height = (r.height + 2 * pad) + 'px';
    const card = document.getElementById('cd-wiz-card');
    const last = wz.i === n - 1;
    card.innerHTML = `
      <div class="cd-wiz-step">${t('第', 'Step ', 'ステップ ')}${wz.i + 1} / ${n}${t(' 步', '', '')}</div>
      <div class="cd-wiz-title">${st.title}</div>
      <div class="cd-wiz-body">${st.body}</div>
      <div class="cd-wiz-btns">
        <button class="cd-btn ghost skip" id="cd-wiz-skip">${t('跳过', 'Skip', 'スキップ')}</button>
        <button class="cd-btn primary" id="cd-wiz-next">${last ? t('开始挑战', 'Start', '挑戦開始') : t('下一步', 'Next', '次へ')}</button>
      </div>
      <div class="cd-wiz-dots">${wz.steps.map((_, k) => `<i class="${k === wz.i ? 'on' : ''}"></i>`).join('')}</div>`;
    card.querySelector('#cd-wiz-skip').onclick = () => this._closeWizard();
    card.querySelector('#cd-wiz-next').onclick = () => { if (last) this._closeWizard(); else { wz.i++; this._renderWizStep(); } };
    // place the card opposite the hole's half of the screen
    const holeMidY = r.top + r.height / 2;
    card.style.top = '';
    card.style.bottom = '';
    if (holeMidY < innerHeight / 2) card.style.bottom = Math.max(14, innerHeight - r.top - r.height - 300) < 60 ? '16px' : (innerHeight * 0.10) + 'px';
    else card.style.top = '58px';
    if (holeMidY < innerHeight / 2 && r.bottom + 260 < innerHeight) { card.style.bottom = ''; card.style.top = (r.bottom + 14) + 'px'; }
    else if (holeMidY >= innerHeight / 2 && r.top - 260 > 0) { card.style.top = Math.max(12, r.top - card.offsetHeight - 14) + 'px'; card.style.bottom = ''; }
  }
  _syncLangBtn() { document.getElementById('cd-lang').textContent = LANG_NAMES[nextLang()]; }
  _rebuildLangView() {
    if (this._wiz) this._renderWizStep();
    if (this.cfg) {
      this.schY = buildSchematic(document.getElementById('cd-arena-you'), this.human.model.metadata(), { compact: true });
      this.schR = buildSchematic(document.getElementById('cd-arena-rl'), this.ghost.model.metadata(), { compact: true });
      this._buildControls();
      document.getElementById('cd-sub').textContent = this.cfg.sub;
      const cap = document.querySelector('.cd-vs-cap');
      if (cap) cap.textContent = this.cfg.money === 'profit' ? t('利润 ¥/h · 高者胜', 'Profit ¥/h · higher wins', '利益 ¥/h · 高い方が勝ち')
                                                              : t('运行成本 ¥/h · 低者胜', 'Cost ¥/h · lower wins', '運転コスト ¥/h · 低い方が勝ち');
    }
    if (this.phase === 'select') this.showSelect();
    else if (this.phase === 'done') this._showResult();
  }

  showSelect() {
    this.phase = 'select'; this.overlay.hidden = false;
    const hb = document.getElementById('cd-help'); if (hb) hb.hidden = true;
    if (this._wiz) { this._wiz.onDone = null; this._closeWizard(); }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    selectCard(this.card, LEVELS, (key) => this.pick(key));
  }

  pick(key) {
    this.levelKey = key; this.cfg = LEVELS[key];
    const sc = this.cfg.scenario;
    this.human = new Engine(sc); this.ghost = new Engine(sc);
    for (const e of [this.human, this.ghost]) { e.handleCommand({ type: 'set_auto_events', on: false }); e.running = false; }
    this.ghost.setMode('rl');
    document.getElementById('cd-sub').textContent = this.cfg.sub;
    const cap = document.querySelector('.cd-vs-cap');
    if (cap) cap.textContent = this.cfg.money === 'profit' ? t('利润 ¥/h · 高者胜', 'Profit ¥/h · higher wins', '利益 ¥/h · 高い方が勝ち')
                                                            : t('运行成本 ¥/h · 低者胜', 'Cost ¥/h · lower wins', '運転コスト ¥/h · 低い方が勝ち');
    this.schY = buildSchematic(document.getElementById('cd-arena-you'), this.human.model.metadata(), { compact: true });
    this.schR = buildSchematic(document.getElementById('cd-arena-rl'), this.ghost.model.metadata(), { compact: true });
    this._buildControls();
    this._beginRound();
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

  // Every round opens with the guided wizard (level pick AND play-again) so the
  // goal/controls/red-line briefing is never skipped by accident; Skip is one tap.
  _beginRound() {
    this.overlay.hidden = true;
    if (this.cfg.wizard) this.showWizard(() => this.start());
    else this.start();
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
    document.getElementById('cd-help').hidden = false;
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
    this.board.update(this._score(this.human), this._score(this.ghost), this.cfg.money);
    this._updateCompare();

    const remain = Math.max(0, DURATION_REAL - this.tickN * TICK);
    this.clock.textContent = `0:${Math.floor(remain % 60).toString().padStart(2, '0')}`;
    this.clock.className = 'cd-clock mono' + (remain <= 5 ? ' crit' : remain <= 10 ? ' warn' : '');
    if (this.simT >= SIM_TOTAL) this._end();
  }

  // The head-to-head metric: the engine's priced profit-rate (¥/h). Costs are
  // negative — higher is always better, one yardstick for every level.
  _score(eng) {
    return eng.score.report().econ.profit_rate;
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
    let msg, danger = e.warm && this.cfg.money === 'profit';
    if (this.cfg.disturb.type === 'ambient') {
      const out = (15 + e.params.value).toFixed(0);
      msg = e.warm ? t(`室外升温到 ${out}° · 该开冷气`, `Outdoor up to ${out}° · cool down`, `室外 ${out}°・冷房を`)
                   : t(`室外降到 ${out}° · 该开暖气`, `Outdoor down to ${out}° · warm up`, `室外 ${out}°・暖房を`);
    } else if (this.cfg.disturb.type === 'fuel_lhv') {
      const pct = Math.round(Math.abs(e.params.value) * 100);
      if (e.params.value < 0) { msg = t(`燃料热值降 ${pct}% · 火变弱了,补燃料`, `Fuel quality −${pct}% · flame weakens, add fuel`, `燃料品質 −${pct}%・火が弱い、増量を`); danger = true; }
      else msg = t(`燃料热值升 ${pct}% · 可以省点火`, `Fuel quality +${pct}% · ease off the fuel`, `燃料品質 +${pct}%・燃料を絞れる`);
    } else {
      msg = e.warm ? t(`进料升温 +${e.params.value}° · 当心超温`, `Feed warms +${e.params.value}° · watch temp`, `供給 +${e.params.value}°・温度注意`)
                   : t(`进料降温 ${e.params.value}° · 可加料`, `Feed cools ${e.params.value}° · push feed`, `供給 ${e.params.value}°・増給可`);
    }
    toast(this.toastHost, msg, danger);
  }

  _end() {
    clearInterval(this.timer); this.timer = null;
    this.human.running = this.ghost.running = false;
    this.phase = 'done';
    const you = this._score(this.human), rl = this._score(this.ghost);
    this._result = {
      money: this.cfg.money, compare: this.cfg.compare, you, rl,
      youKwh: this.human.score.energy, rlKwh: this.ghost.score.energy,
      youProd: this.human.score.prod * 1000, rlProd: this.ghost.score.prod * 1000,
      youOk: Math.round(100 * this.youOk / Math.max(1, this.steps)),
      rlOk: Math.round(100 * this.rlOk / Math.max(1, this.steps)),
    };
    this._showResult();
  }
  _showResult() {
    this.overlay.hidden = false;
    resultCard(this.card, this._result, () => this._beginRound(), () => this.showSelect(), () => { location.href = './index.html'; });
  }
}

// AC slider label: 0.5 = off, >0.5 heat, <0.5 cool
function acLabel(u) {
  const k = Math.round(Math.abs(u - 0.5) * 200);
  if (k < 4) return t('关', 'off', 'オフ');
  return (u > 0.5 ? t('暖 ', 'heat ', '暖 ') : t('冷 ', 'cool ', '冷 ')) + k + '%';
}

new Challenge();
