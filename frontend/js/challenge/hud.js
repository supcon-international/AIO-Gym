// Challenge HUD — pure rendering. Plant P&IDs are reused from schematic.js (built
// in challenge.js, one per player); here we render the you-vs-RL economic-score
// board, toasts, the level-select card, and the result card. All strings via i18n.
import { t } from '../i18n.js?v=25';

// money format: costs are shown as positive spend, profits keep their sign
const fm = (v) => { const a = Math.abs(v); const d = a < 10 ? 1 : 0; return a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
export const moneyTxt = (v, money) => (money === 'profit' ? (v < 0 ? '−¥' : '¥') + fm(v) : '¥' + fm(v));

// ---------------- Scoreboard (¥/h — who runs the plant cheaper / more profitably) ----------------
export function makeScoreboard() {
  const $ = (id) => document.getElementById(id);
  const youV = $('cd-you-profit'), rlV = $('cd-rl-profit'), barY = $('cd-bar-you'), barR = $('cd-bar-rl'), lead = $('cd-lead');
  return {
    // youR/rlR are ¥/h profit-rates (costs are negative); HIGHER is always better.
    update(youR, rlR, money) {
      youV.textContent = moneyTxt(youR, money); rlV.textContent = moneyTxt(rlR, money);
      const scale = Math.max(Math.abs(youR), Math.abs(rlR), 1e-6);
      const sy = Math.max(5, Math.min(95, 50 + ((youR - rlR) / scale) * 120));
      barY.style.width = sy + '%'; barR.style.width = (100 - sy) + '%';
      const d = youR - rlR, pct = Math.abs(d) / scale * 100;
      if (pct < 1.5) { lead.textContent = t('势均力敌', 'dead even', '互角'); lead.className = 'cd-lead mono'; }
      else if (d > 0) {
        lead.textContent = (money === 'profit' ? t('你多赚 ', 'you +', 'あなた +') : t('你省 ', 'you save ', 'あなた節約 ')) + '¥' + fm(d) + '/h';
        lead.className = 'cd-lead mono you';
      } else {
        lead.textContent = (money === 'profit' ? t('RL 多赚 ', 'RL +', 'RL +') : t('RL 省 ', 'RL saves ', 'RL 節約 ')) + '¥' + fm(-d) + '/h';
        lead.className = 'cd-lead mono rl';
      }
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
  // d.you / d.rl are ¥/h profit-rates — higher always wins (costs are negative).
  const diff = d.you - d.rl, scale = Math.max(Math.abs(d.you), Math.abs(d.rl), 1e-6);
  const pct = Math.abs(diff) / scale * 100;
  const win = diff > 0, close = pct < 4;
  let vClass, vText;
  if (win && close) { vClass = 'win'; vText = t('险胜 RL！', 'You edged the RL!', 'RL に辛勝！'); }
  else if (win) { vClass = 'win'; vText = t('你赢了 RL！🏆', 'You beat the RL! 🏆', 'RL に勝利！🏆'); }
  else { vClass = 'lose'; vText = t('RL 赢了这一局', 'The RL won this round', 'RL の勝ち'); }

  const sub = (kwh, ok, prod) => d.compare === 'prod'
    ? t(`产率 ${prod.toFixed(1)} · 达标 ${ok}%`, `rate ${prod.toFixed(1)} · on-spec ${ok}%`, `生産 ${prod.toFixed(1)} · 規格 ${ok}%`)
    : t(`达标 ${ok}% · ${kwh.toFixed(kwh < 10 ? 2 : 0)} kWh`, `on-spec ${ok}% · ${kwh.toFixed(kwh < 10 ? 2 : 0)} kWh`, `規格 ${ok}% · ${kwh.toFixed(kwh < 10 ? 2 : 0)} kWh`);

  const dTxt = '¥' + fm(Math.abs(diff)) + '/h';
  const gap = d.money === 'profit'
    ? (win ? t(`你比 RL 多赚 <b>${dTxt}</b>(+${pct.toFixed(0)}%)`, `You out-earned the RL by <b>${dTxt}</b> (+${pct.toFixed(0)}%)`, `RL より <b>${dTxt}</b> 多く稼いだ(+${pct.toFixed(0)}%)`)
           : t(`RL 比你多赚 <b>${dTxt}</b> —— 它贴着 88° 安全线把产量做到最大。`, `The RL out-earned you by <b>${dTxt}</b> — it rides the 88° line to max yield.`, `RL が <b>${dTxt}</b> 多く稼いだ —— 88°線に沿って生産量最大化。`))
    : (win ? t(`你比 RL 省 <b>${dTxt}</b>(${pct.toFixed(0)}%)`, `You ran <b>${dTxt}</b> (${pct.toFixed(0)}%) cheaper than the RL`, `RL より <b>${dTxt}</b>(${pct.toFixed(0)}%)安く運転`)
           : t(`RL 比你省 <b>${dTxt}</b> —— 稳住达标的同时更省能。`, `The RL ran <b>${dTxt}</b> cheaper — on-spec at lower energy.`, `RL が <b>${dTxt}</b> 安く運転 —— 規格を守りつつ省エネ。`));

  const cell = (cls, name, rate, kwh, ok, prod) => `
    <div class="cd-rcell ${cls}">
      <div class="rk"><i class="dot"></i>${name}</div>
      <div class="rv mono">${moneyTxt(rate, d.money)}<span style="font-size:12px;opacity:.75">/h</span></div>
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
