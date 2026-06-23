// Minimal trilingual (zh / en / ja) i18n for a no-framework app. LANG is a
// module-level singleton; `t(zh, en, ja)` picks the active string at the call site
// (no key dict — strings stay co-located with the code that renders them). `ja`
// falls back to `en` when omitted. setLang() persists the choice, swaps every static
// [data-zh]/[data-en]/[data-ja] element, and notifies listeners so the dynamic
// panels re-render.

const KEY = 'aiogym.lang';
const LANGS = ['zh', 'en', 'ja'];
let _lang = 'zh';
try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) _lang = s; } catch (e) { /* no storage */ }

const listeners = new Set();

export function lang() { return _lang; }
export function t(zh, en, ja) { return _lang === 'ja' ? (ja ?? en) : _lang === 'en' ? en : zh; }
export function onLang(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function nextLang() { return LANGS[(LANGS.indexOf(_lang) + 1) % LANGS.length]; }

// Swap text of every element carrying data-zh/data-en (and optional data-ja).
export function applyStatic(root) {
  (root || document).querySelectorAll('[data-zh][data-en]').forEach((e) => {
    e.textContent = _lang === 'ja' ? (e.getAttribute('data-ja') ?? e.getAttribute('data-en'))
      : _lang === 'en' ? e.getAttribute('data-en') : e.getAttribute('data-zh');
  });
}

export function setLang(l) {
  const next = LANGS.includes(l) ? l : 'zh';
  if (next === _lang) return;
  _lang = next;
  try { localStorage.setItem(KEY, _lang); } catch (e) { /* no storage */ }
  applyStatic();
  listeners.forEach((cb) => { try { cb(_lang); } catch (e) { /* keep going */ } });
}

// cycle zh -> en -> ja -> zh
export function toggleLang() { setLang(nextLang()); }
