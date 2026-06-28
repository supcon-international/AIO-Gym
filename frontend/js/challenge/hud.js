// Challenge HUD — pure rendering for the cascade game. The plant P&ID is reused
// from schematic.js (built in challenge.js); here we render the you-vs-RL economic
// scoreboard, toasts, and the intro/result overlay cards. All strings via i18n.
import { t } from '../i18n.js?v=15';

const r1 = (v) => (v < 0 ? '−' : '') + Math.abs(Math.round(v));

// ---------------- Scoreboard (economic score 0-100, higher = on-spec & low-energy) ----------------
export function makeScoreboard() {
  const $ = (id) => document.getElementById(id);
  const youV = $('cd-you-profit'), rlV = $('cd-rl-profit'), barY = $('cd-bar-you'), barR = $('cd-bar-rl'), lead = $('cd-lead');
  return {
    update(youS, rlS) {
      youV.textContent = r1(youS); rlV.textContent = r1(rlS);
      // emphasise the gap: centre the split, push it by the score difference
      const sy = Math.max(5, Math.min(95, 50 + (youS - rlS) * 1.4));
      barY.style.width = sy + '%'; barR.style.width = (100 - sy) + '%';
      const d = youS - rlS;
      if (Math.abs(d) < 1) { lead.textContent = t('势均力敌', 'dead even', '互角'); lead.className = 'cd-lead mono'; }
      else if (d > 0) { lead.textContent = t('你领先 ', 'you +', 'あなた +') + Math.round(d); lead.className = 'cd-lead mono you'; }
      else { lead.textContent = 'RL +' + Math.round(-d); lead.className = 'cd-lead mono rl'; }
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
    <h1>${t('你能比 <span class="em">RL</span> 更省吗？', 'Can you out-save the <span class="em">RL</span>?', '<span class="em">RL</span> より省エネできる？')}</h1>
    <p class="lede">${t(
      '你是双区空调的操作员。两个房间都要维持在 20–24° 舒适带——制冷或制热都费电。同一局里，一个 RL 智能体在<b>完全相同的室外天气扰动</b>下与你竞争：谁能既舒适又最省电。',
      'You run two-zone air-conditioning. Both rooms must stay in the 20–24° comfort band — cooling and heating both cost energy. In the same round, an RL agent competes under the <b>exact same outdoor weather</b>: who stays comfortable for the least energy.',
      'あなたは2ゾーン空調のオペレーター。両室を 20–24° の快適帯に保つ——冷房も暖房も電力を食う。同じラウンドで RL が<b>まったく同じ外気変動</b>の下で競う:快適かつ最小エネルギーは誰か。')}</p>
    <div class="cd-rules">
      ${rule('🌡', t('两个房间都要待在 <b>20–24°</b> 舒适带', 'Keep both rooms in the <b>20–24°</b> comfort band', '両室を <b>20–24°</b> 快適帯に'))}
      ${rule('⚡', t('制冷/制热越猛越费电——<b>经济分 = 舒适 × 省电</b>', 'Harder cool/heat = more energy — <b>score = comfort × low-energy</b>', '冷暖が強いほど電力——<b>スコア = 快適 × 省エネ</b>'))}
      ${rule('🌤', t('室外忽冷忽热，<b>随手调空调</b>跟上', 'The weather swings hot/cold — <b>work the AC</b> to keep up', '外気が変動、<b>空調を調整</b>して追従'))}
      ${rule('🤖', t('只有 <b>2 台空调</b>，简单直接；RL 同场竞速', 'Just <b>2 AC units</b> — simple; the RL races you', '<b>空調2台</b>だけ・シンプル;RL が並走'))}
    </div>
    <button class="cd-btn primary" id="cd-start">${t('开始挑战', 'Start', '挑戦開始')}</button>`;
  card.querySelector('#cd-start').onclick = onStart;
}

export function resultCard(card, d, onAgain, onBack) {
  // d: { you, rl (econ scores 0-100), youKwh, rlKwh, youOk(%) }
  const win = d.you > d.rl, close = Math.abs(d.you - d.rl) < 6;
  let vClass, vText;
  if (win && close) { vClass = 'win'; vText = t('险胜 RL！', 'You edged the RL!', 'RL に辛勝！'); }
  else if (win) { vClass = 'win'; vText = t('你赢了 RL！🏆', 'You beat the RL! 🏆', 'RL に勝利！🏆'); }
  else { vClass = 'lose'; vText = t('RL 赢了这一局', 'The RL won this round', 'RL の勝ち'); }
  const eGap = (d.youKwh - d.rlKwh) / (Math.abs(d.youKwh) + 1e-6) * 100;   // + = RL used less
  const gapLine = win
    ? t(`你的经济分领先 <b>${Math.round(d.you - d.rl)}</b>，全程达标率 ${d.youOk}%`,
        `You led the economic score by <b>${Math.round(d.you - d.rl)}</b>, on-spec ${d.youOk}% of the round`,
        `経済スコアで <b>${Math.round(d.you - d.rl)}</b> 上回り、規格達成率 ${d.youOk}%`)
    : t(`RL 用电比你少 <b>${Math.abs(eGap).toFixed(0)}%</b> —— 它学会贴着舒适带边缘、随外温调度省能。`,
        `The RL used <b>${Math.abs(eGap).toFixed(0)}%</b> less energy — it rides the edge of the comfort band, tracking the weather.`,
        `RL は電力を <b>${Math.abs(eGap).toFixed(0)}%</b> 削減——快適帯の端に沿い、外気に追従して省エネ。`);
  const cell = (cls, name, score, kwh) => `
    <div class="cd-rcell ${cls}">
      <div class="rk"><i class="dot"></i>${name}</div>
      <div class="rv mono">${r1(score)}</div>
      <div class="rsub">${kwh.toFixed(3)} kWh</div>
    </div>`;
  card.innerHTML = `
    <h1>${t('结算', 'Results', '結果')}</h1>
    <div class="cd-verdict ${vClass}">${vText}</div>
    <div class="cd-result-grid">
      ${cell('you', t('你', 'You', 'あなた'), d.you, d.youKwh)}
      ${cell('rl', 'RL', d.rl, d.rlKwh)}
    </div>
    <p class="cd-gap">${gapLine}</p>
    <button class="cd-btn primary" id="cd-again">${t('再来一局', 'Play again', 'もう一度')}</button>
    <button class="cd-btn ghost" id="cd-back2">${t('返回沙盘', 'Back to sandbox', 'サンドボックスへ')}</button>`;
  card.querySelector('#cd-again').onclick = onAgain;
  card.querySelector('#cd-back2').onclick = onBack;
}
