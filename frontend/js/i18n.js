// Minimal bilingual (zh/en) i18n for a no-framework app. LANG is a module-level
// singleton; `t(zh, en)` picks the active string at the call site (no key dict —
// strings stay co-located with the code that renders them). setLang() persists
// the choice, swaps every static [data-zh]/[data-en] element, and notifies
// listeners so the dynamic panels re-render.

const KEY = 'aiogym.lang';
let _lang = 'zh';
try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'zh') _lang = s; } catch (e) { /* no storage */ }

const listeners = new Set();

export function lang() { return _lang; }
export function t(zh, en) { return _lang === 'en' ? en : zh; }
export function onLang(cb) { listeners.add(cb); return () => listeners.delete(cb); }

// Swap text of every element carrying both data-zh and data-en attributes.
export function applyStatic(root) {
  (root || document).querySelectorAll('[data-zh][data-en]').forEach((e) => {
    e.textContent = _lang === 'en' ? e.getAttribute('data-en') : e.getAttribute('data-zh');
  });
}

export function setLang(l) {
  const next = l === 'en' ? 'en' : 'zh';
  if (next === _lang) return;
  _lang = next;
  try { localStorage.setItem(KEY, _lang); } catch (e) { /* no storage */ }
  applyStatic();
  listeners.forEach((cb) => { try { cb(_lang); } catch (e) { /* keep going */ } });
}

export function toggleLang() { setLang(_lang === 'en' ? 'zh' : 'en'); }
