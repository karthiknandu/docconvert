/* DocConvert learning memory – everything stays on this device.
   1 corrections you make · 2 personal dictionary · 3 recurring document layouts
   4 which settings work best · 5 problem log you can send for engine updates */
'use strict';
const Learn = (() => {
  const KEY = 'dc_learn_v1';
  const blank = () => ({ v: 1, corrections: {}, dict: {}, layouts: {}, stats: {}, problems: [], docs: 0, pairs: [], model: null });
  let M = blank();
  let dirty = false;

  /* ---------- storage: IndexedDB with localStorage fallback ---------- */
  function idb() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open('docconvert', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  async function load() {
    try {
      const db = await idb();
      const v = await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(KEY); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
      if (v) M = Object.assign(blank(), v);
      return;
    } catch (e) { }
    try { const s = localStorage.getItem(KEY); if (s) M = Object.assign(blank(), JSON.parse(s)); } catch (e) { }
  }
  async function save() {
    if (!dirty) return; dirty = false;
    trim();
    try {
      const db = await idb();
      await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(M, KEY); t.oncomplete = res; t.onerror = () => rej(t.error); });
      return;
    } catch (e) { }
    try { localStorage.setItem(KEY, JSON.stringify({ ...M, pairs: [] })); } catch (e) { }
  }
  function trim() {
    const cap = (obj, n) => { const k = Object.keys(obj); if (k.length <= n) return; k.sort((a, b) => (obj[a].n || obj[a]) - (obj[b].n || obj[b])).slice(0, k.length - n).forEach(x => delete obj[x]); };
    cap(M.dict, 20000); cap(M.corrections, 5000); cap(M.layouts, 300);
    if (M.problems.length > 500) M.problems = M.problems.slice(-500);
    if (M.pairs.length > 3000) M.pairs = M.pairs.slice(-3000);
  }
  const ready = load();

  /* ---------- 1 + 2: fix words ---------- */
  const strip = w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < rowMin) rowMin = cur[j]; }
      if (rowMin > max) return max + 1; prev = cur;
    }
    return prev[b.length];
  }
  let dictIndex = null; // by length → words
  function buildIndex() { dictIndex = {}; for (const w of Object.keys(M.dict)) if (M.dict[w] >= 2) (dictIndex[w.length] = dictIndex[w.length] || []).push(w); }
  /* returns {text, how} – how: 'correction' | 'dictionary' | null */
  function fixWord(t, conf) {
    if (!t) return { text: t, how: null };
    const c = M.corrections[t];
    if (c && (c.n >= 1 || (c.a || 0) >= 2)) return { text: c.to, how: 'correction' };
    if (conf >= 82) return { text: t, how: null };
    const core = strip(t); if (core.length < 4 || /\d/.test(core)) return { text: t, how: null };
    const low = core.toLowerCase();
    if (M.dict[low]) return { text: t, how: null };
    if (!dictIndex) buildIndex();
    const max = core.length >= 8 ? 2 : 1;
    let best = null, bd = max + 1, bn = 0;
    for (let L = core.length - max; L <= core.length + max; L++) for (const w of (dictIndex[L] || [])) {
      const d = lev(low, w, max);
      if (d < bd || (d === bd && M.dict[w] > bn)) { bd = d; best = w; bn = M.dict[w]; }
    }
    if (!best || bd > max) return { text: t, how: null };
    // keep the original capitalisation pattern
    let fixed = best;
    if (core === core.toUpperCase()) fixed = best.toUpperCase(); else if (core[0] === core[0].toUpperCase()) fixed = best[0].toUpperCase() + best.slice(1);
    return { text: t.replace(core, fixed), how: 'dictionary' };
  }
  /* auto = learned from the laptop AI; it only takes effect after it has been seen twice (you: at once) */
  function addCorrection(from, to, auto = false) {
    if (!from || from === to) return;
    const c = M.corrections[from] || { to, n: 0, a: 0 };
    if (auto) { if (c.n > 0 && c.to !== to) return; c.a = (c.to === to ? (c.a || 0) : 0) + 1; c.to = to; }
    else { c.to = to; c.n++; }
    c.t = Date.now(); M.corrections[from] = c;
    for (const w of to.split(/\s+/)) { const k = strip(w).toLowerCase(); if (k.length >= 3 && !/\d/.test(k)) M.dict[k] = (M.dict[k] || 0) + 3; }
    dictIndex = null; dirty = true;
  }
  function learnWords(words) { // words: [{t, conf}]
    let n = 0;
    for (const w of words) {
      if (w.conf < 92) continue; const k = strip(w.t).toLowerCase();
      if (k.length < 4 || k.length > 30 || /\d/.test(k) || !/^\p{L}+$/u.test(k)) continue;
      M.dict[k] = (M.dict[k] || 0) + 1; n++;
    }
    if (n) { dictIndex = null; dirty = true; }
  }
  function addPair(imgDataUrl, text, src = 'you') { M.pairs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), img: imgDataUrl, text, src, d: Date.now() }); dirty = true; }

  /* ---------- 3: recurring layouts ---------- */
  function signature(lines) {
    // first high-confidence lines near the top, letters only → stable across visits of the same letterhead
    const top = lines.filter(l => l.conf >= 85).slice(0, 6).map(l => l.words.map(w => w.t).join(' ').toLowerCase().replace(/[^\p{L}]+/gu, '')).filter(s => s.length >= 6);
    if (top.length < 2) return null;
    let h = 0; const s = top.slice(0, 3).join('|'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 'L' + (h >>> 0).toString(36);
  }
  const layout = sig => sig ? M.layouts[sig] : null;
  function rememberLayout(sig, info) { if (!sig) return; const o = M.layouts[sig] || { n: 0 }; Object.assign(o, info); o.n++; o.d = Date.now(); M.layouts[sig] = o; dirty = true; }

  /* ---------- 4: which settings win ---------- */
  function statWin(kind, variant) { const s = M.stats[kind] || (M.stats[kind] = {}); s[variant] = (s[variant] || 0) + 1; s._tries = (s._tries || 0) + 1; dirty = true; }
  function statTry(kind, variant) { const s = M.stats[kind] || (M.stats[kind] = {}); const k = '_t_' + variant; s[k] = (s[k] || 0) + 1; dirty = true; }
  /* skip a retry variant that has almost never helped for this kind of page (keeps 15% exploration) */
  function worthTrying(kind, variant) {
    const s = M.stats[kind]; if (!s) return true;
    const tried = s['_t_' + variant] || 0, won = s[variant] || 0;
    if (tried < 8) return true;
    if (won / tried >= 0.12) return true;
    return Math.random() < 0.15;
  }

  /* ---------- 5: problem log ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function logProblem(p) { M.problems.push({ id: uid(), d: new Date().toISOString().slice(0, 10), ...p }); dirty = true; }

  function stats() {
    return {
      docs: M.docs, corrections: Object.keys(M.corrections).length, words: Object.keys(M.dict).length,
      layouts: Object.keys(M.layouts).length, problems: M.problems.length, pairs: M.pairs.length,
      settings: Object.values(M.stats).reduce((a, s) => a + (s._tries || 0), 0)
    };
  }
  function exportAll() { return JSON.stringify(M); }
  function exportProblems() {
    return JSON.stringify({ app: 'DocConvert', exported: new Date().toISOString(), note: 'Content-free problem log: page measurements only, no document text.', problems: M.problems, stats: M.stats }, null, 1);
  }
  function exportPairs() { return JSON.stringify({ app: 'DocConvert', note: 'Corrected word images + text, for retraining an OCR model on a PC.', pairs: M.pairs }); }
  /* two-way merge of another device's learning into this one (safe to repeat) */
  function merge(o) {
    if (!o || o.v !== 1) throw new Error('This is not a DocConvert learning file.');
    for (const [k, v] of Object.entries(o.dict || {})) M.dict[k] = Math.max(M.dict[k] || 0, v);
    for (const [k, v] of Object.entries(o.corrections || {})) { const c = M.corrections[k]; if (!c || (v.t || 0) > (c.t || 0)) M.corrections[k] = v; else if (c.to === v.to) { c.n = Math.max(c.n || 0, v.n || 0); c.a = Math.max(c.a || 0, v.a || 0); } }
    for (const [k, v] of Object.entries(o.layouts || {})) { const c = M.layouts[k]; if (!c || (v.d || 0) > (c.d || 0)) M.layouts[k] = { ...v, n: Math.max(v.n || 0, (c && c.n) || 0) }; }
    for (const [kind, st] of Object.entries(o.stats || {})) { const c = M.stats[kind] || (M.stats[kind] = {}); for (const [k, v] of Object.entries(st)) c[k] = Math.max(c[k] || 0, v); }
    const have = new Set(M.problems.map(p => p.id)); for (const p of o.problems || []) if (p.id && !have.has(p.id)) M.problems.push(p);
    const hp = new Set(M.pairs.map(p => p.id)); for (const p of o.pairs || []) if (p.id && !hp.has(p.id)) M.pairs.push(p);
    M.docs = Math.max(M.docs, o.docs || 0);
    if (o.model && (!M.model || (o.model.d || 0) > (M.model.d || 0))) M.model = o.model;
    dictIndex = null; dirty = true;
  }
  function importAll(json) { merge(JSON.parse(json)); return save(); }
  /* sync with a remote store: backend = { get(): Promise<string|null>, put(json): Promise } */
  async function syncWith(backend) {
    await ready;
    const remote = await backend.get();
    if (remote) merge(JSON.parse(remote));
    // give old local entries ids so they merge cleanly next time
    for (const p of M.problems) if (!p.id) p.id = uid();
    for (const p of M.pairs) if (!p.id) p.id = uid();
    dirty = true; await save();
    await backend.put(JSON.stringify(M));
    M.lastSync = Date.now();
    return stats();
  }
  function reset() { M = blank(); dictIndex = null; dirty = true; return save(); }
  function docDone() { M.docs++; dirty = true; return save(); }

  return { ready, save, merge, syncWith, data: () => M, fixWord, addCorrection, learnWords, addPair, signature, layout, rememberLayout, statWin, statTry, worthTrying, logProblem, stats, exportAll, exportProblems, exportPairs, importAll, reset, docDone };
})();
