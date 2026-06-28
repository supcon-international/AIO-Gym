// Challenge HUD — pure rendering. Plant P&IDs are reused from schematic.js (built
// in challenge.js, one per player); here we render the you-vs-RL economic-score
// board, toasts, the level-select card, and the result card. All strings via i18n.
import { t } from '../i18n.js?v=15';

const r1 = (v) => (v < 0 ? '−' : '') + Math.abs(Math.round(v));

// ---------------- Scoreboard (0-100, higher = better operator) ----------------
export function makeScoreboard() {
  const $ = (id) => document.getElementById(id);
  const youV = $('cd-you-profit'), rlV = $('cd-rl-profit'), barY = $('cd-bar-you'), barR = $('cd-bar-rl'), lead = $('cd-lead');
  return {
    update(youS, rlS) {
      youV.textContent = r1(youS); rlV.textContent = r1(rlS);
      const sy = Math.max(5, Math.min(95, 50 + (youS - rlS) * 1.4));   // centre split, push by the gap
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

// ---------------- Level-select card ----------------
export function selectCard(card, levels, onPick) {
  const items = Object.keys(levels).map((k) => {
    const L = levels[k];
    return `<button class="cd-level" data-k="${k}">
        <span class="cd-level-name">${L.name()}</span>
        <span class="cd-level-tag">${L.tag()}</span>
        <span class="cd-level-blurb">${L.blurb()}</span>
      </button>`;
  }).join('');
  card.innerHTML = `
    <h1>${t('挑战 <span class="em">RL</span>', 'Beat the <span class="em">RL</span>', '<span class="em">RL</span> に挑戦')}</h1>
    <p class="lede">${t('选一个设备,亲手操作,和 RL 在<b>完全相同的扰动</b>下同台竞速 —— 60 秒一局。',
      'Pick a plant, hand-control it, and race the RL under the <b>exact same disturbances</b> — 60 s a round.',
      '設備を選び手動操作、<b>同じ外乱</b>で RL と競う —— 1ラウンド60秒。')}</p>
    <div class="cd-levels">${items}</div>`;
  card.querySelectorAll('.cd-level').forEach((b) => { b.onclick = () => onPick(b.dataset.k); });
}

// ---------------- Result card ----------------
export function resultCard(card, d, onAgain, onMenu, onBack) {
  const win = d.you > d.rl, close = Math.abs(d.you - d.rl) < 5;
  let vClass, vText;
  if (win && close) { vClass = 'win'; vText = t('险胜 RL！', 'You edged the RL!', 'RL に辛勝！'); }
  else if (win) { vClass = 'win'; vText = t('你赢了 RL！🏆', 'You beat the RL! 🏆', 'RL に勝利！🏆'); }
  else { vClass = 'lose'; vText = t('RL 赢了这一局', 'The RL won this round', 'RL の勝ち'); }

  const sub = (kwh, ok, prod) => d.compare === 'prod'
    ? t(`产率 ${prod.toFixed(1)}`, `rate ${prod.toFixed(1)}`, `生産 ${prod.toFixed(1)}`)
    : t(`达标 ${ok}% · ${kwh.toFixed(2)} kWh`, `on-spec ${ok}% · ${kwh.toFixed(2)} kWh`, `規格 ${ok}% · ${kwh.toFixed(2)} kWh`);

  let gap;
  if (d.compare === 'prod') {
    gap = win ? t(`你的产值经济分领先 <b>${Math.round(d.you - d.rl)}</b>`, `You led the economic score by <b>${Math.round(d.you - d.rl)}</b>`, `経済スコアで <b>${Math.round(d.you - d.rl)}</b> 上回り`)
              : t(`RL 经济分高 <b>${Math.round(d.rl - d.you)}</b> —— 它贴着 88° 安全线把产量做到最大。`, `The RL led by <b>${Math.round(d.rl - d.you)}</b> — it rides the 88° line to max yield.`, `RL が <b>${Math.round(d.rl - d.you)}</b> 上回り —— 88°線に沿って生産量最大化。`);
  } else {
    const eGap = (d.youKwh - d.rlKwh) / (Math.abs(d.rlKwh) + 1e-6) * 100;
    gap = win ? t(`你达标 ${d.youOk}%、经济分领先 <b>${Math.round(d.you - d.rl)}</b>`, `On-spec ${d.youOk}%, economic score +<b>${Math.round(d.you - d.rl)}</b>`, `規格 ${d.youOk}%、経済スコア +<b>${Math.round(d.you - d.rl)}</b>`)
              : t(`RL 用电少 <b>${Math.abs(eGap).toFixed(0)}%</b> 还更稳 —— 它贴着舒适带边缘随扰动调度。`, `The RL used <b>${Math.abs(eGap).toFixed(0)}%</b> less energy and held spec — riding the band edge.`, `RL は電力 <b>${Math.abs(eGap).toFixed(0)}%</b> 減で安定 —— 帯の端に沿って調整。`);
  }

  const cell = (cls, name, score, kwh, ok, prod) => `
    <div class="cd-rcell ${cls}">
      <div class="rk"><i class="dot"></i>${name}</div>
      <div class="rv mono">${r1(score)}</div>
      <div class="rsub">${sub(kwh, ok, prod)}</div>
    </div>`;
  card.innerHTML = `
    <h1>${t('结算', 'Results', '結果')}</h1>
    <div class="cd-verdict ${vClass}">${vText}</div>
    <div class="cd-result-grid">
      ${cell('you', t('你', 'You', 'あなた'), d.you, d.youKwh, d.youOk, d.youProd)}
      ${cell('rl', 'RL', d.rl, d.rlKwh, d.rlOk, d.rlProd)}
    </div>
    <p class="cd-gap">${gap}</p>
    <button class="cd-btn primary" id="cd-again">${t('再来一局', 'Play again', 'もう一度')}</button>
    <div class="cd-btn-row">
      <button class="cd-btn ghost" id="cd-menu">${t('换设备', 'Pick plant', '設備変更')}</button>
      <button class="cd-btn ghost" id="cd-back2">${t('返回沙盘', 'Sandbox', 'サンドボックス')}</button>
    </div>`;
  card.querySelector('#cd-again').onclick = onAgain;
  card.querySelector('#cd-menu').onclick = onMenu;
  card.querySelector('#cd-back2').onclick = onBack;
}
