// Challenge HUD — pure rendering. The arena (two HTML thermometers), the mini
// overlaid temperature trace (SVG), the you-vs-RL scoreboard, toasts, and the
// intro/result overlay cards. challenge.js owns all logic and calls into here.
import { t } from '../i18n.js?v=15';

export const T_MIN = 40, T_MAX = 100, T_ECO = 88, T_TRIP = 92;
const pct = (T) => Math.max(0, Math.min(1, (T - T_MIN) / (T_MAX - T_MIN)));
const fmtMoney = (v) => (v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('en-US');

// ---------------- Arena: two thermometers + 88°/92° reference lines ----------------
export function mountArena(host) {
  const yEco = (1 - pct(T_ECO)) * 100, yTrip = (1 - pct(T_TRIP)) * 100;
  const therm = (cls, name) => `
    <div class="therm ${cls}">
      <div class="therm-track"><div class="therm-fill"><span class="therm-read mono">--</span></div></div>
      <div class="therm-cap"><i class="dot"></i>${name}</div>
    </div>`;
  host.innerHTML = `<div class="arena-stage"><div class="arena-plot">
      <div class="aline trip" style="top:${yTrip}%"><span>92° ${t('联锁', 'TRIP', 'インターロック')}</span></div>
      <div class="aline eco" style="top:${yEco}%"><span>88° ${t('盈利上限', 'profit cap', '利益上限')}</span></div>
      <div class="arena-therms">
        ${therm('you', t('你', 'You', 'あなた'))}
        ${therm('rl', 'RL')}
      </div>
    </div></div>`;
  const fills = host.querySelectorAll('.therm-fill');
  const reads = host.querySelectorAll('.therm-read');
  const set = (fill, read, T) => {
    fill.style.height = (pct(T) * 100).toFixed(1) + '%';
    read.textContent = T.toFixed(1) + '°';
    fill.classList.toggle('hot', T >= T_ECO && T < T_TRIP);
    fill.classList.toggle('crit', T >= T_TRIP);
  };
  return { update(youT, rlT) { set(fills[0], reads[0], youT); set(fills[1], reads[1], rlT); } };
}

// ---------------- Mini overlaid temperature trace ----------------
export function mountCurve(host) {
  const W = 320, H = 70, NS = 'http://www.w3.org/2000/svg';
  const y = (T) => (1 - pct(T)) * H;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  const mkLine = (yv, color) => { const l = document.createElementNS(NS, 'line'); l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', yv); l.setAttribute('y2', yv); l.setAttribute('stroke', color); l.setAttribute('stroke-width', 1); l.setAttribute('stroke-dasharray', '3 3'); l.setAttribute('vector-effect', 'non-scaling-stroke'); l.setAttribute('opacity', .5); return l; };
  svg.appendChild(mkLine(y(T_TRIP), '#FF4D4D')); svg.appendChild(mkLine(y(T_ECO), '#FFC23D'));
  const mkPath = (color, dash) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', 2); p.setAttribute('vector-effect', 'non-scaling-stroke'); p.setAttribute('stroke-linejoin', 'round'); if (dash) p.setAttribute('stroke-dasharray', '5 4'); return p; };
  const pRl = mkPath('#5B9DFF', true), pYou = mkPath('#B2ED1D', false);
  svg.appendChild(pRl); svg.appendChild(pYou); host.appendChild(svg);
  const you = [], rl = [];
  const draw = (arr, path) => {
    if (arr.length < 2) { path.setAttribute('d', ''); return; }
    const n = arr.length, d = arr.map((T, i) => `${(i / (n - 1) * W).toFixed(1)},${y(T).toFixed(1)}`);
    path.setAttribute('d', 'M' + d.join('L'));
  };
  return {
    push(youT, rlT) { you.push(youT); rl.push(rlT); draw(you, pYou); draw(rl, pRl); },
    reset() { you.length = 0; rl.length = 0; pYou.setAttribute('d', ''); pRl.setAttribute('d', ''); },
  };
}

// ---------------- Scoreboard ----------------
export function makeScoreboard() {
  const $ = (id) => document.getElementById(id);
  const youV = $('cd-you-profit'), rlV = $('cd-rl-profit'), barY = $('cd-bar-you'), barR = $('cd-bar-rl'), lead = $('cd-lead');
  return {
    update(youP, rlP) {
      youV.textContent = fmtMoney(youP); rlV.textContent = fmtMoney(rlP);
      const lo = Math.min(0, youP, rlP), a = youP - lo, b = rlP - lo, sum = a + b + 1e-6;
      const sy = Math.max(4, Math.min(96, (a / sum) * 100));
      barY.style.width = sy + '%'; barR.style.width = (100 - sy) + '%';
      const diff = youP - rlP;
      if (Math.abs(diff) < 1) { lead.textContent = t('势均力敌', 'dead even', '互角'); lead.className = 'cd-lead mono'; }
      else if (diff > 0) { lead.textContent = t('你领先 ', 'you +', 'あなた +') + fmtMoney(diff); lead.className = 'cd-lead mono you'; }
      else { lead.textContent = 'RL +' + fmtMoney(-diff); lead.className = 'cd-lead mono rl'; }
    },
  };
}

// ---------------- Toast ----------------
export function toast(host, msg, isFault) {
  const el = document.createElement('div');
  el.className = 'cd-toast' + (isFault ? ' fault' : '');
  el.innerHTML = `<i class="tdot"></i><span>${msg}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2600);
}

// ---------------- Overlay cards ----------------
export function introCard(card, onStart) {
  const rule = (icon, html) => `<div class="cd-rule"><span class="ri">${icon}</span><span>${html}</span></div>`;
  card.innerHTML = `
    <h1>${t('你能赢过 <span class="em">RL</span> 吗？', 'Can you beat the <span class="em">RL</span>?', '<span class="em">RL</span> に勝てる？')}</h1>
    <p class="lede">${t(
      '你是放热反应器的操作员。加料赚钱——但反应放热会把温度推向热失控。同一局里，一个 RL 智能体在<b>完全相同的扰动</b>下与你同台竞速。',
      'You run an exothermic reactor. Feed makes money — but the reaction\'s heat drives the temperature toward runaway. In the same round, an RL agent races you under the <b>exact same disturbances</b>.',
      'あなたは発熱反応器のオペレーター。供給で利益が出るが、反応熱が温度を暴走へ押し上げる。同じラウンドで、RL エージェントが<b>まったく同じ外乱</b>の下で競う。')}</p>
    <div class="cd-rules">
      ${rule('💰', t('<b>进料</b>越多，赚得越快', 'More <b>feed</b> = faster money', '<b>供給</b>が多いほど利益が速い'))}
      ${rule('🔥', t('温度过 <b>88°</b> 开始扣钱，冲到 <b>92°</b> 进料被强制切断、产量归零', 'Above <b>88°</b> you bleed money; hit <b>92°</b> and the feed trips — production stops', '<b>88°</b> 超で減点、<b>92°</b> で供給遮断・生産停止'))}
      ${rule('🤖', t('RL 幽灵<b>同场竞速</b>，结束比谁赚得多', 'The RL ghost <b>races alongside</b> — most profit wins', 'RL ゴーストが<b>並走</b>、利益が多い方の勝ち'))}
      ${rule('⏱', t('一局 <b>60 秒</b>，用冷却压住温度', '<b>60 s</b> per round — ride the cooling', '1 ラウンド <b>60 秒</b>、冷却で抑える'))}
    </div>
    <button class="cd-btn primary" id="cd-start">${t('开始挑战', 'Start', '挑戦開始')}</button>`;
  card.querySelector('#cd-start').onclick = onStart;
}

export function resultCard(card, d, onAgain, onBack) {
  // d: { you, rl, youOver, rlOver, youTrip, rlTrip }
  const win = d.you > d.rl, close = Math.abs(d.you - d.rl) / (Math.max(Math.abs(d.rl), Math.abs(d.you)) + 1e-6) < 0.08;
  let vClass, vText;
  if (d.youTrip) { vClass = 'trip'; vText = t('反应器联锁了 🔥', 'Your reactor tripped 🔥', '反応器がトリップ 🔥'); }
  else if (win && close) { vClass = 'win'; vText = t('险胜 RL！', 'You edged the RL!', 'RL に辛勝！'); }
  else if (win) { vClass = 'win'; vText = t('你赢了 RL！🏆', 'You beat the RL! 🏆', 'RL に勝利！🏆'); }
  else { vClass = 'lose'; vText = t('RL 赢了这一局', 'The RL won this round', 'RL の勝ち'); }
  const diff = d.rl - d.you, pctGap = Math.abs(diff) / (Math.abs(d.rl) + 1e-6) * 100;
  const gapLine = win
    ? t(`你比 RL 多赚 <b>${fmtMoney(-diff)}</b>`, `You out-earned the RL by <b>${fmtMoney(-diff)}</b>`, `RL より <b>${fmtMoney(-diff)}</b> 多く稼いだ`)
    : t(`RL 比你多赚 <b>${fmtMoney(diff)}</b>（高 ${pctGap.toFixed(0)}%）`, `The RL out-earned you by <b>${fmtMoney(diff)}</b> (+${pctGap.toFixed(0)}%)`, `RL があなたより <b>${fmtMoney(diff)}</b> 多く稼いだ（+${pctGap.toFixed(0)}%）`);
  const cell = (cls, name, val, over, trip) => `
    <div class="cd-rcell ${cls}">
      <div class="rk"><i class="dot"></i>${name}</div>
      <div class="rv mono">${fmtMoney(val)}</div>
      <div class="rsub">${trip ? t('已联锁 · 进料被切', 'tripped · feed cut', 'トリップ・供給遮断')
        : over > 0 ? t(`超温 ${over.toFixed(0)} 秒`, `${over.toFixed(0)}s over-temp`, `超温 ${over.toFixed(0)}秒`)
        : t('全程安全', 'safe throughout', '終始安全')}</div>
    </div>`;
  card.innerHTML = `
    <h1>${t('结算', 'Results', '結果')}</h1>
    <div class="cd-verdict ${vClass}">${vText}</div>
    <div class="cd-result-grid">
      ${cell('you', t('你', 'You', 'あなた'), d.you, d.youOver, d.youTrip)}
      ${cell('rl', 'RL', d.rl, d.rlOver, d.rlTrip)}
    </div>
    <p class="cd-gap">${gapLine}${win ? '' : t('—— RL 学会了贴着 88° 盈利线、随扰动动态调进料。', ' — the RL learned to ride the 88° line and adapt feed to each disturbance.', '—— RL は 88° 線に沿い、外乱ごとに供給を調整することを学習。')}</p>
    <button class="cd-btn primary" id="cd-again">${t('再来一局', 'Play again', 'もう一度')}</button>
    <button class="cd-btn ghost" id="cd-back2">${t('返回沙盘', 'Back to sandbox', 'サンドボックスへ')}</button>`;
  card.querySelector('#cd-again').onclick = onAgain;
  card.querySelector('#cd-back2').onclick = onBack;
}
