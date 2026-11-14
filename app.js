/* DocConvert – all conversions run in the browser. */
'use strict';
const BASE = new URL('.', location.href).href;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('dc_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dc_' + k, JSON.stringify(v)); } catch (e) { } }
};

/* ---------------- script loading ---------------- */
const loaded = {};
function loadScript(path) {
  if (!loaded[path]) loaded[path] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = BASE + path; s.onload = res;
    s.onerror = () => rej(new Error('Could not load ' + path));
    document.head.appendChild(s);
  });
  return loaded[path];
}
let DOCX = null, DOCXPREVIEW = null;
const lib = {
  async pdfjs() {
    await loadScript('vendor/pdf.min.js');
    const L = window.pdfjsLib;
    if (!L.GlobalWorkerOptions.workerPort) {
      try {
        const u = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(BASE + 'vendor/pdf.worker.min.js')});`], { type: 'text/javascript' }));
        L.GlobalWorkerOptions.workerPort = new Worker(u);
      } catch (e) { L.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdf.worker.min.js'; }
    }
    return L;
  },
  async pdflib() { await loadScript('vendor/pdf-lib.min.js'); return window.PDFLib; },
  async jszip() { await loadScript('vendor/jszip.min.js'); return window.JSZip; },
  async xlsx() { await loadScript('vendor/xlsx.full.min.js'); return window.XLSX; },
  async pptxgen() { await loadScript('vendor/pptxgen.bundle.js'); return window.PptxGenJS; },
  async h2c() { await loadScript('vendor/html2canvas.min.js'); return window.html2canvas; },
  async docx() {
    if (DOCX) return DOCX;
    const prev = window.docx;
    await loadScript('vendor/docx.iife.js');
    DOCX = window.docx;
    if (prev) window.docx = prev;
    return DOCX;
  },
  async docxPreview() {
    if (DOCXPREVIEW) return DOCXPREVIEW;
    await lib.jszip();
    const prev = window.docx;
    await loadScript('vendor/docx-preview.min.js');
    DOCXPREVIEW = window.docx;
    window.docx = prev;
    return DOCXPREVIEW;
  },
  async pptxPreview() { await loadScript('vendor/pptx-preview.umd.js'); return window.pptxPreview; },
  async tesseract() { await loadScript('tess/tesseract.min.js'); return window.Tesseract; }
};

/* ---------------- UI: progress / result / save ---------------- */
let busy = false;
function prog(msg, frac) {
  $('#prog').classList.add('on');
  if (msg != null) $('#progMsg').textContent = msg;
  if (frac != null) $('#progBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}
function progDone() { $('#prog').classList.remove('on'); $('#progBar').style.width = '0'; }

let dlNs = null;
const dlReady = (async () => {
  try { if (window.claude && window.claude.use) dlNs = await window.claude.use('downloads'); } catch (e) { dlNs = null; }
  return dlNs;
})();
async function saveFile(blob, name, btn) {
  const ns = dlNs || (window.claude && window.claude.use ? await Promise.race([dlReady, sleep(1500).then(() => null)]) : null);
  if (ns) {
    try { await ns.save({ filename: name, data: blob }); if (btn) btn.textContent = 'Saved ✓'; return; }
    catch (e) {
      const c = e && e.code;
      if (c === 'declined') { if (btn) btn.textContent = 'Save'; return; }
      if (c === 'rate_limited') { toastErr('Another save is still open. Finish it, then try again.'); return; }
      if (c !== 'unavailable' && c !== 'not_granted' && c !== 'capability_disabled' && c !== 'capability_removed') { toastErr('Could not save: ' + (e.message || c)); return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  if (btn) btn.textContent = 'Saved ✓';
}
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function showResult(files, hint) {
  const ul = $('#resList'); ul.innerHTML = '';
  $('#resTitle').textContent = files.length > 1 ? 'Done – ' + files.length + ' files' : 'Done';
  for (const f of files) {
    const li = document.createElement('li');
    const sp = document.createElement('span'); sp.textContent = f.name + '  ·  ' + fmtSize(f.blob.size);
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Save';
    b.onclick = () => saveFile(f.blob, f.name, b);
    li.append(sp, b); ul.appendChild(li);
  }
  $('#resHint').textContent = hint || '';
  $('#resHint').classList.remove('err');
  $('#result').classList.add('on');
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function toastErr(msg) {
  $('#resList').innerHTML = ''; $('#resTitle').textContent = 'Something went wrong';
  $('#resHint').textContent = msg; $('#resHint').classList.add('err');
  $('#result').classList.add('on');
}
async function run(fn) {
  if (busy) return; busy = true;
  $$('.btn.wide').forEach(b => b.disabled = true);
  $('#result').classList.remove('on');
  prog('Starting…', 0.02);
  try { await fn(); }
  catch (e) { console.error(e); toastErr((e && e.message) || String(e)); }
  finally { busy = false; progDone(); refreshButtons(); }
}
const baseName = n => (n || 'file').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file';

/* ---------------- tabs ---------------- */
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('main section').forEach(s => s.classList.toggle('on', s.id === b.dataset.t));
  $('#result').classList.remove('on');
  store.set('tab', b.dataset.t);
});
{ const t = store.get('tab', 'from'); const b = $(`#tabs button[data-t="${t}"]`); if (b) b.click(); }

function pickGroup(sel, cb) {
  $$(sel + ' .opt').forEach(o => o.onclick = () => {
    $$(sel + ' .opt').forEach(x => x.classList.toggle('on', x === o)); cb && cb(o.dataset.f);
  });
}

/* ---------------- OCR languages ---------------- */
let ocrLangs = store.get('langs', ['eng']).filter(c => LANGS.some(l => l[0] === c));
if (!ocrLangs.length) ocrLangs = ['eng'];
const langName = c => (LANGS.find(l => l[0] === c) || [c, c])[1];
function updateLangChip() { $('#langChip').textContent = 'OCR: ' + ocrLangs.map(langName).join(' + '); }
updateLangChip();
function renderLangList(q) {
  q = (q || '').toLowerCase();
  const box = $('#langList'); box.innerHTML = '';
  const order = [...ocrLangs.map(c => LANGS.find(l => l[0] === c)), ...LANGS.filter(l => !ocrLangs.includes(l[0]))];
  for (const [code, name] of order) {
    if (q && !name.toLowerCase().includes(q) && !code.includes(q)) continue;
    const lb = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = ocrLangs.includes(code);
    cb.onchange = () => {
      if (cb.checked) { if (ocrLangs.length >= 3) { cb.checked = false; return; } ocrLangs.push(code); }
      else { ocrLangs = ocrLangs.filter(c => c !== code); if (!ocrLangs.length) { ocrLangs = [code]; cb.checked = true; } }
      updateLangChip();
    };
    lb.append(cb, document.createTextNode(name));
    box.appendChild(lb);
  }
}
$('#langChip').onclick = () => { $('#langSearch').value = ''; renderLangList(''); $('#langModal').classList.add('on'); };
$('#langSearch').oninput = e => renderLangList(e.target.value);
$('#langDone').onclick = () => { $('#langModal').classList.remove('on'); store.set('langs', ocrLangs); };

let ocrWorker = null, ocrWorkerKey = '';
async function getOcr() {
  const key = ocrLangs.join('+');
  if (ocrWorker && ocrWorkerKey === key) return ocrWorker;
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) { } ocrWorker = null; }
  const T = await lib.tesseract();
  const mk = cacheMethod => T.createWorker(ocrLangs, 1, {
    workerPath: BASE + 'tess/worker.min.js',
    corePath: BASE + 'tess/',
    langPath: BASE + 'tessdata',
    gzip: true,
    cacheMethod,
    logger: m => {
      if (m.status === 'loading language traineddata') prog('Loading OCR language data (' + ocrLangs.map(langName).join(', ') + ')…', null);
      else if (m.status === 'loading tesseract core') prog('Starting OCR engine…', null);
    }
  });
  prog('Starting OCR engine…', null);
  try { ocrWorker = await mk('write'); }
  catch (e) { console.warn('OCR init with cache failed, retrying without', e); ocrWorker = await mk('none'); }
  ocrWorkerKey = key;
  return ocrWorker;
}
/* OCR one canvas. Returns {items (in canvas px), textPdf (Uint8Array|null), text} */
async function ocrCanvas(cv, wantPdf) {
  const w = await getOcr();
  const r = await w.recognize(cv, { pdfTextOnly: true }, { text: true, blocks: true, pdf: !!wantPdf });
  const items = [];
  for (const b of (r.data.blocks || [])) for (const p of (b.paragraphs || [])) for (const l of (p.lines || [])) {
    const lh = (l.bbox.y1 - l.bbox.y0);
    for (const wd of (l.words || [])) {
      const t = (wd.text || '').trim(); if (!t || /^[|¦!lI]$/.test(t) && (wd.confidence || 0) < 60 || /^\|+$/.test(t)) continue;
      items.push({ x: wd.bbox.x0, top: l.bbox.y0, w: wd.bbox.x1 - wd.bbox.x0, h: lh, size: Math.max(4, lh * 0.8), str: t, ocr: true });
    }
  }
  return { items, text: r.data.text || '', textPdf: r.data.pdf ? new Uint8Array(r.data.pdf) : null };
}

/* ---------------- canvas helpers ---------------- */
function newCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
const canvasBlob = (cv, type = 'image/jpeg', q = 0.88) => new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('Image encode failed')), type, q));
async function canvasBytes(cv, type, q) { return new Uint8Array(await (await canvasBlob(cv, type, q)).arrayBuffer()); }
function whiteCanvas(cv) { const c = newCanvas(cv.width, cv.height); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0); return c; }
async function loadImageFile(file, maxSide = 2600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Cannot read image ' + file.name)); i.src = URL.createObjectURL(file); });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = newCanvas(w * s, h * s); const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

/* ---------------- PDF reading ---------------- */
async function openPdf(buf) {
  const L = await lib.pdfjs();
  return L.getDocument({
    data: buf, cMapUrl: BASE + 'vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: BASE + 'vendor/standard_fonts/', isEvalSupported: false
  }).promise;
}
async function renderPage(page, maxSide = 2200, minScale = 1) {
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.max(minScale, Math.min(4, maxSide / Math.max(v1.width, v1.height)));
  const vp = page.getViewport({ scale });
  const cv = newCanvas(vp.width, vp.height);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { cv, scale };
}
async function pageTextItems(page) {
  const L = window.pdfjsLib;
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = L.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]) || 10;
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.5) continue; // skip rotated / vertical text runs
    items.push({ x: t[4], top: t[5] - size * 0.85, w: it.width * (vp.scale || 1), h: size, size, str: it.str });
  }
  return { items, w: vp.width, h: vp.height };
}
function parseRange(str, n) {
  const set = new Set();
  for (const part of String(str).split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/); if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}
/* Read a PDF into page models: {w,h,items,lines,ocr,cv?} */
async function readPdfPages(pdf, pageNums, { ocr, needImage, imgMax = 2200, label = 'Reading' }) {
  const out = [];
  for (let k = 0; k < pageNums.length; k++) {
    const n = pageNums[k];
    prog(`${label} page ${n} of ${pdf.numPages}…`, 0.05 + 0.85 * k / pageNums.length);
    const page = await pdf.getPage(n);
    const t = await pageTextItems(page);
    const chars = t.items.reduce((s, i) => s + i.str.trim().length, 0);
    const pm = { n, w: t.w, h: t.h, items: t.items, ocr: false };
    let rendered = null;
    if (ocr && chars < 20) {
      prog(`OCR on page ${n} of ${pdf.numPages}…`, 0.05 + 0.85 * k / pageNums.length);
      rendered = await renderPage(page, 2400);
      const r = await ocrCanvas(rendered.cv, false);
      const s = rendered.scale;
      pm.items = r.items.map(i => ({ ...i, x: i.x / s, top: i.top / s, w: i.w / s, h: i.h / s, size: i.size / s }));
      pm.ocr = true;
    }
    if (needImage) pm.cv = (rendered && Math.max(rendered.cv.width, rendered.cv.height) <= imgMax * 1.2) ? rendered.cv : (await renderPage(page, imgMax)).cv;
    pm.lines = buildLines(pm.items);
    page.cleanup();
    out.push(pm);
  }
  return out;
}

/* ---------------- layout analysis ---------------- */
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function buildLines(items) {
  const its = items.filter(i => i.str.trim()).map(i => ({ ...i, cy: i.top + i.h / 2 })).sort((a, b) => a.cy - b.cy || a.x - b.x);
  const lines = [];
  for (const it of its) {
    let ln = null;
    for (let j = lines.length - 1; j >= 0 && j >= lines.length - 3; j--) {
      const L = lines[j];
      if (Math.abs(L.cy - it.cy) < Math.min(L.size, it.size) * 0.5) { ln = L; break; }
    }
    if (!ln) { ln = { items: [], cy: it.cy, size: it.size }; lines.push(ln); }
    ln.items.push(it);
    ln.cy = ln.items.reduce((s, i) => s + i.cy, 0) / ln.items.length;
    ln.size = median(ln.items.map(i => i.size));
  }
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    L.top = Math.min(...L.items.map(i => i.top)); L.bottom = Math.max(...L.items.map(i => i.top + i.h));
    L.x = L.items[0].x; L.right = Math.max(...L.items.map(i => i.x + i.w));
    // cells: split on big gaps
    const cells = []; let cur = null;
    for (const it of L.items) {
      const gap = cur ? it.x - cur.x2 : Infinity;
      const big = Math.max(L.size * 1.2, 9);
      if (!cur || gap > big) { cur = { x: it.x, x2: it.x + it.w, text: it.str }; cells.push(cur); }
      else {
        const sp = gap > L.size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
        cur.text += (sp ? ' ' : '') + it.str; cur.x2 = Math.max(cur.x2, it.x + it.w);
      }
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
    L.cells = cells.filter(c => c.text);
    L.text = L.cells.map(c => c.text).join(L.cells.length > 1 ? '\t' : '');
  }
  return lines.filter(L => L.cells.length).sort((a, b) => a.top - b.top);
}
/* Column intervals from multi-cell lines */
function columnsOf(lines) {
  const spans = [];
  for (const L of lines) if (L.cells.length > 1) for (const c of L.cells) spans.push([c.x, c.x2]);
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const s of spans) {
    const last = cols[cols.length - 1];
    if (last && s[0] <= last[1] + 2) last[1] = Math.max(last[1], s[1]); else cols.push([s[0], s[1]]);
  }
  return cols;
}
function colIndex(cols, c) {
  let best = 0, bestOv = -Infinity;
  cols.forEach((k, i) => {
    const ov = Math.min(k[1], c.x2) - Math.max(k[0], c.x);
    const d = ov > 0 ? ov : -Math.min(Math.abs(c.x - k[0]), Math.abs(c.x - k[1]));
    if (d > bestOv) { bestOv = d; best = i; }
  });
  return best;
}
function linesToGrid(lines) {
  const cols = columnsOf(lines);
  return lines.map(L => {
    if (!cols.length) return [L.text.replace(/\t/g, ' ')];
    const row = [];
    for (const c of L.cells) {
      const i = colIndex(cols, c);
      row[i] = row[i] ? row[i] + ' ' + c.text : c.text;
    }
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    return row;
  });
}
/* Blocks for documents: paragraphs and tables */
function pageBlocks(pm) {
  const lines = pm.lines; if (!lines.length) return [];
  const body = median(lines.flatMap(L => L.items.map(() => L.size))) || 11;
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    // table: >= 3 consecutive lines with >= 2 cells
    let j = i;
    while (j < lines.length && lines[j].cells.length >= 2) j++;
    if (j - i >= 3) { blocks.push({ type: 'table', rows: linesToGrid(lines.slice(i, j)), size: body }); i = j; continue; }
    const L = lines[i];
    const prev = blocks[blocks.length - 1];
    const prevLine = i > 0 ? lines[i - 1] : null;
    const text = L.cells.map(c => c.text).join('    ');
    const isHead = L.size >= body * 1.25;
    let join = prev && prev.type === 'p' && prevLine && !prev.head && !isHead &&
      (L.top - prevLine.bottom) < Math.max(L.size, prevLine.size) * 0.9 &&
      Math.abs(L.size - prevLine.size) < body * 0.2 &&
      !(/[.:!?。！？]$/.test(prev.text) && prevLine.right < pm.w * 0.7) &&
      !/^([•\-–▪●◦*]|\d+[.)]|[a-z][.)])\s/.test(text);
    if (prev && prev.head && isHead && prevLine && (L.top - prevLine.bottom) < L.size * 0.6 && Math.abs(L.size - prevLine.size) < 1) join = true;
    if (join) {
      prev.text = /[-‐]$/.test(prev.text) && /^[a-z]/.test(text) ? prev.text.slice(0, -1) + text : prev.text + ' ' + text;
      prev.right = Math.max(prev.right, L.right); prev.nlines++;
    } else {
      blocks.push({ type: 'p', text, size: L.size, head: isHead ? (L.size >= body * 1.6 ? 1 : 2) : 0, x: L.x, right: L.right, nlines: 1, gapBefore: prevLine ? L.top - prevLine.bottom : 0 });
    }
    i++;
  }
  for (const b of blocks) if (b.type === 'p') {
    const cx = (b.x + b.right) / 2;
    b.center = b.nlines === 1 && Math.abs(cx - pm.w / 2) < pm.w * 0.06 && (b.right - b.x) < pm.w * 0.7 && b.x > pm.w * 0.15;
    b.indent = Math.max(0, b.x - (pm.marginL || 0));
  }
  return blocks;
}
function pagesToText(pages) {
  return pages.map(pm => {
    const t = pageBlocks(pm).map(b => b.type === 'table' ? b.rows.map(r => r.join('\t')).join('\n') : b.text).join('\n\n');
    return pages.length > 1 ? `----- Page ${pm.n} -----\n${t}` : t;
  }).join('\n\n');
}

/* ---------------- writers ---------------- */
async function writeDocx(pages, mode) {
  const D = await lib.docx();
  const sections = [];
  for (const pm of pages) {
    pm.marginL = Math.min(...pm.lines.map(l => l.x), pm.w * 0.1);
    const children = [];
    const margin = 720; // twips (0.5 in)
    const pageWtw = Math.round(pm.w * 20), pageHtw = Math.round(pm.h * 20);
    if (mode !== 'text' && pm.cv) {
      const jpg = await canvasBytes(pm.cv, 'image/jpeg', 0.85);
      const maxWpx = (pageWtw - 2 * margin) / 15, maxHpx = (pageHtw - 2 * margin) / 15 - 4;
      const s = Math.min(maxWpx / pm.cv.width, maxHpx / pm.cv.height);
      children.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'jpg', data: jpg, transformation: { width: Math.round(pm.cv.width * s), height: Math.round(pm.cv.height * s) } })] }));
    }
    if (mode !== 'image') {
      if (mode === 'both' && pm.cv) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      for (const b of pageBlocks(pm)) {
        if (b.type === 'table') {
          const ncol = Math.max(...b.rows.map(r => r.length));
          const fs = Math.round(Math.min(22, Math.max(16, b.size * 2)));
          children.push(new D.Table({
            width: { size: 100, type: D.WidthType.PERCENTAGE },
            rows: b.rows.map(r => new D.TableRow({
              children: Array.from({ length: ncol }, (_, k) => new D.TableCell({
                children: [new D.Paragraph({ children: [new D.TextRun({ text: r[k] || '', size: fs })] })]
              }))
            }))
          }));
          children.push(new D.Paragraph({ children: [] }));
        } else {
          const size = Math.round(Math.min(48, Math.max(16, b.size * 2)));
          children.push(new D.Paragraph({
            heading: b.head === 1 ? D.HeadingLevel.HEADING_1 : b.head === 2 ? D.HeadingLevel.HEADING_2 : undefined,
            alignment: b.center ? D.AlignmentType.CENTER : undefined,
            indent: !b.center && b.indent > 20 ? { left: Math.round(Math.min(b.indent, pm.w * 0.4) * 20) } : undefined,
            spacing: { after: 120 },
            children: [new D.TextRun({ text: b.text, size, bold: b.head ? true : undefined, color: b.head ? '000000' : undefined })]
          }));
        }
      }
      if (!children.length) children.push(new D.Paragraph({ children: [] }));
    }
    sections.push({ properties: { page: { size: { width: pageWtw, height: pageHtw }, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children });
  }
  const doc = new D.Document({ creator: 'DocConvert', styles: { default: { document: { run: { font: 'Calibri' } } } }, sections });
  return D.Packer.toBlob(doc);
}
function toNumber(s) {
  const t = s.trim();
  if (!/^[(\-+]?[$€£₹¥]?\s?\d[\d,]*(\.\d+)?%?\)?$/.test(t)) return null;
  if (/^0\d/.test(t)) return null; // keep codes like 0123
  let v = parseFloat(t.replace(/[(),$€£₹¥\s%+]/g, ''));
  if (isNaN(v)) return null;
  if (/^\(.*\)$/.test(t) || /^-/.test(t)) v = -Math.abs(v);
  if (/%$/.test(t)) return { v: v / 100, z: '0.##%' };
  return { v };
}
async function writeXlsx(pages, oneSheet) {
  const X = await lib.xlsx();
  const wb = X.utils.book_new();
  const mkSheet = rows => {
    const aoa = rows.map(r => r.map(c => { const n = toNumber(c || ''); return n ? n.v : c; }));
    const ws = X.utils.aoa_to_sheet(aoa.length ? aoa : [['(no text found)']]);
    rows.forEach((r, ri) => r.forEach((c, ci) => { const n = toNumber(c || ''); if (n && n.z) { const a = X.utils.encode_cell({ r: ri, c: ci }); if (ws[a]) ws[a].z = n.z; } }));
    const ncol = Math.max(1, ...rows.map(r => r.length));
    ws['!cols'] = Array.from({ length: ncol }, (_, k) => ({ wch: Math.min(60, Math.max(8, ...rows.map(r => String(r[k] || '').length + 2))) }));
    return ws;
  };
  if (oneSheet) {
    const rows = [];
    pages.forEach((pm, i) => { if (i) rows.push([]); rows.push(...linesToGrid(pm.lines)); });
    X.utils.book_append_sheet(wb, mkSheet(rows), 'All pages');
  } else {
    for (const pm of pages) X.utils.book_append_sheet(wb, mkSheet(linesToGrid(pm.lines)), 'Page ' + pm.n);
  }
  const out = X.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
async function writePptx(pages, mode) {
  const P = await lib.pptxgen();
  const pptx = new P();
  const wIn = pages[0].w / 72, hIn = pages[0].h / 72;
  const sW = 10, sH = sW * hIn / wIn; // keep a standard 10in width
  pptx.defineLayout({ name: 'PDF', width: sW, height: sH });
  pptx.layout = 'PDF';
  for (const pm of pages) {
    const s = pptx.addSlide();
    const k = sW / (pm.w / 72); // inch scale factor
    const fit = Math.min(sW / (pm.w / 72), sH / (pm.h / 72));
    if (mode === 'image' && pm.cv) {
      const jpg = await canvasBlob(pm.cv, 'image/jpeg', 0.88);
      const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(jpg); });
      const w = pm.w / 72 * fit, h = pm.h / 72 * fit;
      s.addImage({ data, x: (sW - w) / 2, y: (sH - h) / 2, w, h });
      const txt = pagesToText([pm]); if (txt.trim()) s.addNotes(txt);
    } else {
      for (const L of pm.lines) {
        const x = L.x / 72 * fit, y = L.top / 72 * fit;
        const w = Math.min(sW - x, (L.right - L.x) / 72 * fit + 0.4), h = (L.bottom - L.top) / 72 * fit * 1.25 + 0.05;
        s.addText(L.cells.map(c => c.text).join('   '), { x, y, w: Math.max(0.3, w), h: Math.max(0.15, h), fontSize: Math.max(6, Math.round(L.size * fit * 0.98 * 10) / 10), margin: 0, valign: 'top', fontFace: 'Calibri', color: '222222', fit: 'none', wrap: false });
      }
    }
    void k;
  }
  return pptx.write({ outputType: 'blob' });
}
async function zipOrSingle(entries, zipName) {
  if (entries.length === 1) return [{ name: entries[0].name, blob: entries[0].blob }];
  const Z = await lib.jszip(); const z = new Z();
  for (const e of entries) z.file(e.name, e.blob);
  return [{ name: zipName, blob: await z.generateAsync({ type: 'blob' }) }];
}

/* Build PDF from page images, optionally with OCR text layer. pages: [{cv, w, h}] (w,h in pt) */
async function buildImagePdf(imgPages, ocr, label = 'Building PDF') {
  const PL = await lib.pdflib();
  const doc = await PL.PDFDocument.create();
  for (let i = 0; i < imgPages.length; i++) {
    const p = imgPages[i];
    prog(`${label}: page ${i + 1} of ${imgPages.length}${ocr ? ' (OCR)' : ''}…`, 0.1 + 0.85 * i / imgPages.length);
    const page = doc.addPage([p.pw, p.ph]);
    const jpg = await doc.embedJpg(await canvasBytes(p.cv, 'image/jpeg', 0.86));
    const r = p.rect || { x: 0, y: 0, w: p.pw, h: p.ph };
    page.drawImage(jpg, { x: r.x, y: r.y, width: r.w, height: r.h });
    if (ocr) {
      const res = await ocrCanvas(p.cv, true);
      if (res.textPdf && res.textPdf.length) {
        const [emb] = await doc.embedPdf(res.textPdf, [0]);
        page.drawPage(emb, { x: r.x, y: r.y, width: r.w, height: r.h });
      }
    }
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
/* place an image canvas on a page; returns {cv,pw,ph,rect} */
function placeOnPage(cv, size, orient, margin = 0) {
  if (size === 'fit') { const s = 72 / 150; return { cv, pw: cv.width * s, ph: cv.height * s }; }
  let [pw, ph] = PAGE[size] || PAGE.a4;
  const land = orient === 'l' || (orient === 'auto' && cv.width > cv.height * 1.08);
  if (land) [pw, ph] = [ph, pw];
  const s = Math.min((pw - 2 * margin) / cv.width, (ph - 2 * margin) / cv.height);
  const w = cv.width * s, h = cv.height * s;
  return { cv, pw, ph, rect: { x: (pw - w) / 2, y: (ph - h) / 2, w, h } };
}

/* =============== FROM PDF =============== */
let fromFile = null, fromFmt = store.get('fromFmt', 'docx');
const FROM_OPTS = {
  docx: `<div class="row"><span class="msg">Layout:</span><select id="o_docx"><option value="text">Editable text</option><option value="both">Editable text + page pictures</option><option value="image">Exact look (page pictures)</option></select></div>`,
  xlsx: `<div class="row"><span class="msg">Sheets:</span><select id="o_xlsx"><option value="per">One sheet per page</option><option value="one">All pages in one sheet</option></select></div>`,
  pptx: `<div class="row"><span class="msg">Slides:</span><select id="o_pptx"><option value="image">Exact look (one picture per page)</option><option value="text">Editable text boxes</option></select></div>`,
  jpg: `<div class="row"><span class="msg">Format:</span><select id="o_img"><option value="jpg">JPG</option><option value="png">PNG</option></select><select id="o_dpi"><option value="150">Normal (150 dpi)</option><option value="220">High (220 dpi)</option><option value="300">Print (300 dpi)</option></select></div>`,
  txt: '', ocrpdf: `<div class="hint">Every scanned page gets a hidden text layer. Pages that already have text are kept as they are.</div>`
};
function setFromFmt(f) {
  fromFmt = f; store.set('fromFmt', f);
  $$('#fromFmt .opt').forEach(o => o.classList.toggle('on', o.dataset.f === f));
  $('#fromOpts').innerHTML = FROM_OPTS[f] || '';
  $('#fromOcr').closest('label').style.display = (f === 'jpg' || f === 'ocrpdf') ? 'none' : '';
}
pickGroup('#fromFmt', setFromFmt); setFromFmt(fromFmt);
$('#fromDrop').onclick = () => $('#fromFile').click();
$('#fromFile').onchange = e => setFromFile(e.target.files[0]);
$('#fromRange').onchange = e => $('#fromCustom').style.display = e.target.value === 'custom' ? '' : 'none';
function setFromFile(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toastErr('Please choose a PDF file.'); return; }
  fromFile = f;
  $('#fromDrop').classList.add('has');
  $('#fromDrop').innerHTML = `<b>${escapeHtml(f.name)}</b><br>${fmtSize(f.size)} · tap to change`;
  refreshButtons();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
$('#fromGo').onclick = () => run(async () => {
  const buf = await fromFile.arrayBuffer();
  prog('Opening PDF…', 0.03);
  let pdf;
  try { pdf = await openPdf(buf.slice(0)); }
  catch (e) { throw new Error(/password/i.test(e.message || e.name) ? 'This PDF is password-protected. Remove the password first.' : 'Could not open this PDF (' + (e.message || e) + ').'); }
  const rangeSel = $('#fromRange').value;
  const nums = rangeSel === 'first' ? [1] : rangeSel === 'custom' ? parseRange($('#fromCustom').value, pdf.numPages) : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  if (!nums.length) throw new Error('No valid pages chosen. Example: 1-3,5');
  const name = baseName(fromFile.name);
  const ocr = $('#fromOcr').checked;
  let files = [], hint = '';
  if (fromFmt === 'docx') {
    const mode = $('#o_docx').value;
    const pages = await readPdfPages(pdf, nums, { ocr: ocr && mode !== 'image', needImage: mode !== 'text', imgMax: 1800 });
    prog('Writing Word file…', 0.93);
    files = [{ name: name + '.docx', blob: await writeDocx(pages, mode) }];
    hint = ocrHint(pages);
  } else if (fromFmt === 'xlsx') {
    const pages = await readPdfPages(pdf, nums, { ocr, needImage: false });
    prog('Writing Excel file…', 0.93);
    files = [{ name: name + '.xlsx', blob: await writeXlsx(pages, $('#o_xlsx').value === 'one') }];
    hint = ocrHint(pages) + ' Columns are detected from the text positions; check merged cells.';
  } else if (fromFmt === 'pptx') {
    const mode = $('#o_pptx').value;
    const pages = await readPdfPages(pdf, nums, { ocr: ocr, needImage: mode === 'image', imgMax: 2000 });
    prog('Writing PowerPoint file…', 0.93);
    files = [{ name: name + '.pptx', blob: await writePptx(pages, mode) }];
    hint = mode === 'image' ? 'Each page is one slide; the page text is in the speaker notes.' : ocrHint(pages);
  } else if (fromFmt === 'txt') {
    const pages = await readPdfPages(pdf, nums, { ocr, needImage: false });
    files = [{ name: name + '.txt', blob: new Blob([pagesToText(pages)], { type: 'text/plain;charset=utf-8' }) }];
    hint = ocrHint(pages);
  } else if (fromFmt === 'jpg') {
    const fmt = $('#o_img').value, dpi = +$('#o_dpi').value;
    const ents = [];
    for (let k = 0; k < nums.length; k++) {
      prog(`Rendering page ${nums[k]} of ${pdf.numPages}…`, 0.05 + 0.85 * k / nums.length);
      const page = await pdf.getPage(nums[k]);
      const vp = page.getViewport({ scale: dpi / 72 }); const cv = newCanvas(vp.width, vp.height); { const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); await page.render({ canvasContext: c, viewport: vp }).promise; }
      ents.push({ name: `${name}_p${String(nums[k]).padStart(3, '0')}.${fmt}`, blob: await canvasBlob(cv, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92) });
      page.cleanup();
    }
    prog('Packing…', 0.95);
    files = await zipOrSingle(ents, name + '_images.zip');
    hint = ents.length > 1 ? 'All pages are in one ZIP file.' : '';
  } else if (fromFmt === 'ocrpdf') {
    const PL = await lib.pdflib();
    const src = await PL.PDFDocument.load(buf, { ignoreEncryption: true });
    const doc = await PL.PDFDocument.create();
    let nocr = 0;
    for (let k = 0; k < nums.length; k++) {
      const n = nums[k];
      prog(`Page ${n} of ${pdf.numPages}…`, 0.05 + 0.9 * k / nums.length);
      const page = await pdf.getPage(n);
      const t = await pageTextItems(page);
      const chars = t.items.reduce((s, i) => s + i.str.trim().length, 0);
      if (chars >= 20) { const [cp] = await doc.copyPages(src, [n - 1]); doc.addPage(cp); continue; }
      prog(`OCR on page ${n} of ${pdf.numPages}…`, null);
      const { cv } = await renderPage(page, 2400);
      const res = await ocrCanvas(cv, true);
      const np = doc.addPage([t.w, t.h]);
      np.drawImage(await doc.embedJpg(await canvasBytes(cv, 'image/jpeg', 0.85)), { x: 0, y: 0, width: t.w, height: t.h });
      if (res.textPdf) { const [emb] = await doc.embedPdf(res.textPdf, [0]); np.drawPage(emb, { x: 0, y: 0, width: t.w, height: t.h }); }
      nocr++; page.cleanup();
    }
    files = [{ name: name + '_searchable.pdf', blob: new Blob([await doc.save()], { type: 'application/pdf' }) }];
    hint = nocr ? `${nocr} page(s) read with OCR in ${ocrLangs.map(langName).join(' + ')}.` : 'All pages already had text, so nothing needed OCR.';
  }
  prog('Done', 1);
  showResult(files, hint.trim());
});
function ocrHint(pages) {
  const n = pages.filter(p => p.ocr).length;
  const empty = pages.filter(p => !p.lines.length).length;
  let h = n ? `${n} scanned page(s) read with OCR (${ocrLangs.map(langName).join(' + ')}).` : '';
  if (empty && !$('#fromOcr').checked) h += ` ${empty} page(s) had no text – turn on OCR for scanned pages.`;
  return h;
}

/* =============== TO PDF =============== */
let toFiles = [];
$('#toDrop').onclick = () => $('#toFile').click();
$('#toFile').onchange = e => { toFiles = toFiles.concat(Array.from(e.target.files)); e.target.value = ''; renderToList(); };
function renderToList() {
  const ul = $('#toList'); ul.innerHTML = '';
  toFiles.forEach((f, i) => {
    const li = document.createElement('li');
    const sp = document.createElement('span'); sp.textContent = f.name + ' · ' + fmtSize(f.size);
    const b = document.createElement('button'); b.className = 'btn sec'; b.textContent = '✕'; b.onclick = () => { toFiles.splice(i, 1); renderToList(); };
    li.append(sp, b); ul.appendChild(li);
  });
  $('#toDrop').classList.toggle('has', toFiles.length > 0);
  refreshButtons();
}
const kindOf = f => {
  const n = f.name.toLowerCase();
  if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/.test(n)) return 'img';
  if (/\.docx$/.test(n)) return 'docx';
  if (/\.(xlsx|xls|csv|ods)$/.test(n)) return 'xlsx';
  if (/\.pptx$/.test(n)) return 'pptx';
  if (/\.(html?)$/.test(n)) return 'html';
  if (/\.(txt|md|json|log|xml|ini|cfg)$/.test(n) || /^text\//.test(f.type)) return 'txt';
  if (/\.(doc|ppt)$/.test(n)) return 'old';
  return 'unknown';
};
$('#toGo').onclick = () => run(async () => {
  const size = $('#toSize').value, orient = $('#toOrient').value, ocr = $('#toOcr').checked;
  const files = [];
  const imgs = toFiles.filter(f => kindOf(f) === 'img');
  const others = toFiles.filter(f => kindOf(f) !== 'img');
  if (imgs.length) {
    const pages = [];
    for (let i = 0; i < imgs.length; i++) { prog(`Reading image ${i + 1} of ${imgs.length}…`, 0.05 + 0.2 * i / imgs.length); pages.push(placeOnPage(await loadImageFile(imgs[i]), size, orient, size === 'fit' ? 0 : 18)); }
    const name = imgs.length === 1 ? baseName(imgs[0].name) : 'images_' + new Date().toISOString().slice(0, 10);
    files.push({ name: name + '.pdf', blob: await buildImagePdf(pages, ocr) });
  }
  for (const f of others) {
    const k = kindOf(f);
    if (k === 'old') throw new Error(`${f.name}: old .doc/.ppt files are not supported. Save it as .docx/.pptx first.`);
    if (k === 'unknown') throw new Error(`${f.name}: this file type is not supported.`);
    prog(`Converting ${f.name}…`, 0.1);
    let blob;
    if (k === 'txt' && !ocr) blob = await textToPdf(await f.text(), size, orient);
    if (!blob) {
      const cvs = k === 'docx' ? await docxToCanvases(f) : k === 'xlsx' ? await xlsxToCanvases(f) : k === 'pptx' ? await pptxToCanvases(f) : await htmlToCanvases(f, k);
      const pages = [];
      for (const c of cvs) {
        if (c.page) pages.push(...slicePages(c.cv, c.page, c.mx || 0, c.my || 0, c.natural || 0));
        else pages.push(placeOnPage(c.cv, size === 'fit' ? 'fit' : size, c.orient || orient, 0));
      }
      blob = await buildImagePdf(pages, ocr, `Building ${f.name}`);
    }
    files.push({ name: baseName(f.name) + '.pdf', blob });
  }
  prog('Done', 1);
  showResult(files, ocr ? 'Text layer added with OCR, so you can search and copy text.' : '');
});

/* hidden render stage */
function stage(widthPx) {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;left:-20000px;top:0;width:${widthPx}px;background:#fff;color:#000;z-index:-1;font-family:Calibri,Carlito,Arial,sans-serif`;
  document.body.appendChild(d); return d;
}
async function snap(el, scale = 2) {
  const h2c = await lib.h2c();
  return h2c(el, { scale, backgroundColor: '#ffffff', useCORS: false, logging: false, windowWidth: el.scrollWidth + 50 });
}
/* split a tall canvas into page images, cutting between text lines.
   mx/my: page margins (pt). natural: max px per pt (prevents upscaling small content). */
function slicePages(cv, page, mx = 0, my = mx, natural = 0) {
  const [pw, ph] = page;
  const contentW = pw - 2 * mx, contentH = ph - 2 * my;
  const pxPerPt = Math.max(cv.width / contentW, natural || 0);
  const sliceH = Math.floor(contentH * pxPerPt);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const out = []; let y = 0;
  while (y < cv.height - 2) {
    let end = Math.min(cv.height, y + sliceH);
    if (end < cv.height) {
      const look = Math.floor(sliceH * 0.3);
      const data = ctx.getImageData(0, end - look, cv.width, look).data;
      for (let r = look - 1; r > 0; r--) {
        let dark = 0; const o = r * cv.width * 4;
        for (let x = 0; x < cv.width; x++) { const i = o + x * 4; if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 140) { if (++dark > 1) break; } }
        if (dark <= 1) { end = end - look + r; break; }
      }
    }
    const h = end - y;
    const c = newCanvas(cv.width, h); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(cv, 0, y, cv.width, h, 0, 0, cv.width, h);
    out.push({ cv: c, pw, ph, rect: { x: mx, y: ph - my - h / pxPerPt, w: cv.width / pxPerPt, h: h / pxPerPt } });
    y = end;
  }
  return out;
}
const cssLen = v => { const m = String(v || '').match(/([\d.]+)\s*(pt|px|in|cm|mm)?/); if (!m) return 0; const n = +m[1]; return ({ pt: n, px: n * 0.75, in: n * 72, cm: n * 72 / 2.54, mm: n * 72 / 25.4 })[m[2] || 'px']; };
async function docxToCanvases(f) {
  const DP = await lib.docxPreview();
  const st = stage(1000);
  try {
    prog(`Laying out ${f.name}…`, 0.15);
    await DP.renderAsync(await f.arrayBuffer(), st, null, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true, experimental: true, useBase64URL: true });
    await sleep(300);
    const secs = $$('section.docx', st);
    if (!secs.length) throw new Error('Could not read this Word file.');
    const out = [];
    for (let i = 0; i < secs.length; i++) {
      prog(`Drawing page ${i + 1} of ${secs.length}…`, 0.2 + 0.3 * i / secs.length);
      const s = secs[i];
      const pw = cssLen(s.style.width) || 612, ph = cssLen(s.style.minHeight || s.style.height) || 792;
      s.style.margin = '0'; s.style.boxShadow = 'none';
      const cs = getComputedStyle(s);
      const padT = cssLen(cs.paddingTop), padB = cssLen(cs.paddingBottom);
      const cv = await snap(s, 2);
      const pxPerPt = cv.width / pw;
      if (cv.height <= ph * pxPerPt * 1.01) out.push({ cv, page: [pw, ph], mx: 0, my: 0, single: true });
      else { // overflowing section: drop its own top/bottom padding, then slice with page margins
        const t = Math.round(padT * pxPerPt), b = Math.round(padB * pxPerPt);
        const c = newCanvas(cv.width, Math.max(10, cv.height - t - b)); c.getContext('2d').drawImage(cv, 0, -t);
        out.push({ cv: c, page: [pw, ph], mx: 0, my: Math.max(36, (padT + padB) / 2) });
      }
    }
    return out;
  } finally { st.remove(); }
}
async function xlsxToCanvases(f) {
  const X = await lib.xlsx();
  const wb = X.read(await f.arrayBuffer(), { type: 'array', cellStyles: true, cellDates: true });
  const out = [];
  for (let i = 0; i < wb.SheetNames.length; i++) {
    const nm = wb.SheetNames[i], ws = wb.Sheets[nm];
    if (!ws['!ref']) continue;
    prog(`Drawing sheet "${nm}"…`, 0.15 + 0.4 * i / wb.SheetNames.length);
    const st = stage(4000);
    try {
      st.innerHTML = `<style>.xs{padding:10px;display:inline-block}.xs h4{font:600 15px Arial,sans-serif;margin:0 0 8px}.xs table{border-collapse:collapse;font:12px Calibri,Carlito,Arial,sans-serif}.xs td{border:1px solid #bbb;padding:3px 6px;white-space:nowrap;vertical-align:top}.xs tr:first-child td{background:#eef2f8;font-weight:600}</style><div class="xs">${wb.SheetNames.length > 1 ? `<h4>${escapeHtml(nm)}</h4>` : ''}${X.utils.sheet_to_html(ws, { header: '', footer: '' })}</div>`;
      const box = $('.xs', st);
      $$('td', box).forEach(td => { if (/^[-+]?[\d.,]+%?$/.test(td.textContent.trim())) td.style.textAlign = 'right'; });
      st.style.width = (box.scrollWidth + 4) + 'px';
      const cv = await snap(box, 2);
      const land = cv.width > cv.height * 0.9 || cv.width > 1400;
      let [pw, ph] = PAGE[$('#toSize').value] || PAGE.a4;
      const o = $('#toOrient').value;
      if ((o === 'auto' && land) || o === 'l') [pw, ph] = [ph, pw];
      out.push({ cv, page: [pw, ph], mx: 28, my: 28, natural: 2 / 0.75 });
    } finally { st.remove(); }
  }
  if (!out.length) throw new Error('The spreadsheet is empty.');
  return out;
}
async function pptxToCanvases(f) {
  const PP = await lib.pptxPreview();
  const st = stage(1280);
  try {
    prog(`Laying out ${f.name}…`, 0.15);
    const pv = PP.init(st, { width: 1280, height: 720, mode: 'list' });
    await pv.preview(await f.arrayBuffer());
    await sleep(500);
    let slides = $$('.pptx-preview-slide-wrapper', st);
    if (!slides.length) slides = Array.from((st.firstElementChild || st).children).filter(e => e.offsetHeight > 100);
    if (!slides.length) throw new Error('Could not read this PowerPoint file.');
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      prog(`Drawing slide ${i + 1} of ${slides.length}…`, 0.2 + 0.35 * i / slides.length);
      const el = slides[i]; el.style.margin = '0'; el.style.boxShadow = 'none';
      const cv = await snap(el, 1.5);
      out.push({ cv, orient: cv.width >= cv.height ? 'l' : 'p' });
    }
    return out;
  } finally { st.remove(); }
}
async function htmlToCanvases(f, k) {
  const st = stage(794);
  try {
    const raw = await f.text();
    if (k === 'html') {
      const d = new DOMParser().parseFromString(raw, 'text/html');
      d.querySelectorAll('script,iframe,object,embed,link,meta').forEach(e => e.remove());
      st.innerHTML = `<div style="padding:48px 56px;font:15px/1.5 system-ui,Arial,sans-serif">${d.body.innerHTML}</div>`;
    } else {
      const pre = document.createElement('div');
      pre.style.cssText = 'padding:48px 56px;font:14px/1.55 system-ui,"Noto Sans",Arial,sans-serif;white-space:pre-wrap;word-break:break-word';
      pre.textContent = raw; st.appendChild(pre);
    }
    const cv = await snap(st.firstElementChild, 2);
    const sz = $('#toSize').value === 'letter' ? PAGE.letter : PAGE.a4;
    return [{ cv, page: sz, mx: 0, my: 24, natural: 2 / 0.75 }];
  } finally { st.remove(); }
}
/* Latin text → real text PDF (searchable, small). Returns null when script needs canvas rendering. */
async function textToPdf(text, size, orient) {
  if (/[^\u0000-ÿ–—‘’“”•…€]/.test(text)) return null;
  const PL = await lib.pdflib();
  const doc = await PL.PDFDocument.create();
  const font = await doc.embedFont(PL.StandardFonts.Helvetica);
  let [pw, ph] = PAGE[size] || PAGE.a4; if (orient === 'l') [pw, ph] = [ph, pw];
  const m = 56, fs = 11, lh = 15.5, maxW = pw - 2 * m;
  const lines = [];
  for (const para of text.replace(/\r/g, '').replace(/\t/g, '    ').split('\n')) {
    if (!para) { lines.push(''); continue; }
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      const t = cur + word;
      if (font.widthOfTextAtSize(t, fs) <= maxW) { cur = t; continue; }
      if (cur.trim()) lines.push(cur.replace(/\s+$/, ''));
      cur = word.trimStart();
      while (font.widthOfTextAtSize(cur, fs) > maxW) { let k = cur.length; while (k > 1 && font.widthOfTextAtSize(cur.slice(0, k), fs) > maxW) k--; lines.push(cur.slice(0, k)); cur = cur.slice(k); }
    }
    lines.push(cur);
  }
  let page = null, y = 0;
  for (const ln of lines) {
    if (!page || y < m) { page = doc.addPage([pw, ph]); y = ph - m - fs; }
    if (ln) page.drawText(ln, { x: m, y, size: fs, font, color: PL.rgb(0.1, 0.1, 0.1) });
    y -= lh;
  }
  if (!page) doc.addPage([pw, ph]);
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

/* =============== SCAN =============== */
let scanPages = []; let scanFmt = 'pdf';
pickGroup('#scanFmt', f => { scanFmt = f; $('#scanOcrRow').style.display = f === 'pdf' ? '' : 'none'; });
$('#scanCam').onclick = () => $('#scanCamIn').click();
$('#scanGal').onclick = () => $('#scanGalIn').click();
$('#scanCamIn').onchange = e => addScans(e.target.files, e.target);
$('#scanGalIn').onchange = e => addScans(e.target.files, e.target);
async function addScans(fl, input) {
  const list = Array.from(fl || []); input.value = '';
  for (const f of list) {
    try {
      prog('Preparing page…', null);
      const src = await loadImageFile(f, 2400);
      const pg = { src, rot: 0, quad: [[0, 0], [1, 0], [1, 1], [0, 1]], filter: 'enh' };
      pg.quad = autoQuad(src) || pg.quad;
      processScan(pg); scanPages.push(pg);
    } catch (e) { toastErr(e.message); }
  }
  progDone(); renderScans(); refreshButtons();
}
function rotated(cv, rot) {
  if (!rot) return cv;
  const sw = rot % 2 ? cv.height : cv.width, sh = rot % 2 ? cv.width : cv.height;
  const c = newCanvas(sw, sh); const x = c.getContext('2d');
  x.translate(sw / 2, sh / 2); x.rotate(rot * Math.PI / 2); x.drawImage(cv, -cv.width / 2, -cv.height / 2);
  return c;
}
function processScan(pg) {
  const r = rotated(pg.src, pg.rot);
  const q = pg.quad.map(([u, v]) => [u * r.width, v * r.height]);
  const full = pg.quad.every((p, i) => Math.abs(p[0] - [0, 1, 1, 0][i]) < 1e-3 && Math.abs(p[1] - [0, 0, 1, 1][i]) < 1e-3);
  const w = full ? r : warp(r, q);
  pg.out = applyFilter(w, pg.filter);
  pg.thumb = null;
}
function renderScans() {
  const box = $('#scanPages'); box.innerHTML = '';
  scanPages.forEach((pg, i) => {
    const d = document.createElement('div'); d.className = 'pg';
    if (!pg.thumb) { const s = 260 / Math.max(pg.out.width, pg.out.height); const t = newCanvas(pg.out.width * s, pg.out.height * s); t.getContext('2d').drawImage(pg.out, 0, 0, t.width, t.height); pg.thumb = t.toDataURL('image/jpeg', 0.7); }
    d.innerHTML = `<img src="${pg.thumb}" alt="page ${i + 1}"><span class="n">${i + 1}</span><div class="tools"><button title="Move left">◀</button><button title="Crop and filter">✂️</button><button title="Delete">🗑️</button><button title="Move right">▶</button></div>`;
    const [l, c, del, rt] = $$('button', d);
    l.onclick = () => { if (i > 0) { [scanPages[i - 1], scanPages[i]] = [scanPages[i], scanPages[i - 1]]; renderScans(); } };
    rt.onclick = () => { if (i < scanPages.length - 1) { [scanPages[i + 1], scanPages[i]] = [scanPages[i], scanPages[i + 1]]; renderScans(); } };
    del.onclick = () => { scanPages.splice(i, 1); renderScans(); refreshButtons(); };
    c.onclick = () => openCrop(pg);
    box.appendChild(d);
  });
}
/* perspective warp: map dest rect → source quad */
function homography(src, dst) { // returns 3x3 mapping dst→src given 4 pairs
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8; // gaussian elimination
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];[b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const h = b.map((v, i) => v / A[i][i]); h.push(1); return h;
}
function warp(cv, q) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2]))), H = Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])));
  const lim = 2400 / Math.max(W, H); if (lim < 1) { W = Math.round(W * lim); H = Math.round(H * lim); }
  const h = homography(q, [[0, 0], [W, 0], [W, H], [0, H]]);
  const sd = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  const out = newCanvas(W, H); const oc = out.getContext('2d'); const od = oc.createImageData(W, H); const o = od.data;
  const sw = cv.width, sh = cv.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const z = h[6] * x + h[7] * y + 1;
    const u = (h[0] * x + h[1] * y + h[2]) / z, v = (h[3] * x + h[4] * y + h[5]) / z;
    const x0 = Math.max(0, Math.min(sw - 2, u | 0)), y0 = Math.max(0, Math.min(sh - 2, v | 0));
    const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
    const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, di = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) o[di + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
    o[di + 3] = 255;
  }
  oc.putImageData(od, 0, 0); return out;
}
function applyFilter(cv, f) {
  const out = newCanvas(cv.width, cv.height); const x = out.getContext('2d', { willReadFrequently: true });
  x.drawImage(cv, 0, 0);
  if (f === 'orig') return out;
  const id = x.getImageData(0, 0, out.width, out.height), d = id.data, N = out.width * out.height;
  if (f === 'enh' || f === 'gray') {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 16) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; }
    const tot = Math.ceil(N / 4);
    const pct = (h, p) => { let s = 0; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= tot * p) return v; } return 255; };
    const hi = hist.map(h => Math.max(pct(h, 0.92), 60)), lo = hist.map((h, c) => Math.min(pct(h, 0.01), hi[c] - 60));
    const lut = [0, 1, 2].map(c => { const t = new Uint8ClampedArray(256); const r = Math.max(1, hi[c] - lo[c]); for (let v = 0; v < 256; v++) { const n = Math.max(0, (v - lo[c]) / r); t[v] = 255 * Math.pow(Math.min(1, n), 1.15); } return t; });
    for (let i = 0; i < d.length; i += 4) {
      let r = lut[0][d[i]], g = lut[1][d[i + 1]], b = lut[2][d[i + 2]];
      if (f === 'gray') { r = g = b = 0.299 * r + 0.587 * g + 0.114 * b; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  } else if (f === 'bw') {
    const W = out.width, H = out.height, g = new Float32Array(N), I = new Float64Array((W + 1) * (H + 1));
    for (let i = 0, p = 0; i < N; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    for (let y = 0; y < H; y++) { let s = 0; for (let x2 = 0; x2 < W; x2++) { s += g[y * W + x2]; I[(y + 1) * (W + 1) + x2 + 1] = I[y * (W + 1) + x2 + 1] + s; } }
    const S = Math.max(8, Math.round(Math.max(W, H) / 40)), T = 0.13;
    for (let y = 0; y < H; y++) for (let x2 = 0; x2 < W; x2++) {
      const x1 = Math.max(0, x2 - S), x3 = Math.min(W - 1, x2 + S), y1 = Math.max(0, y - S), y2 = Math.min(H - 1, y + S);
      const cnt = (x3 - x1 + 1) * (y2 - y1 + 1);
      const sum = I[(y2 + 1) * (W + 1) + x3 + 1] - I[y1 * (W + 1) + x3 + 1] - I[(y2 + 1) * (W + 1) + x1] + I[y1 * (W + 1) + x1];
      const v = g[y * W + x2] * cnt <= sum * (1 - T) ? 0 : 255; const p = (y * W + x2) * 4;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  }
  x.putImageData(id, 0, 0); return out;
}
/* simple automatic page detection: bright paper on darker background */
function autoQuad(cv) {
  const s = 300 / Math.max(cv.width, cv.height); const W = Math.round(cv.width * s), H = Math.round(cv.height * s);
  const c = newCanvas(W, H); const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Otsu threshold
  const hist = new Float64Array(256); for (const v of g) hist[v | 0]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128; const tot = W * H;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF; const between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; th = t; } }
  // largest bright connected region from centre-ish
  const mask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) mask[i] = g[i] > th ? 1 : 0;
  const lab = new Int32Array(W * H); let bestLab = 0, bestN = 0, L = 0;
  for (let i = 0; i < W * H; i++) if (mask[i] && !lab[i]) {
    L++; let n = 0; const st = [i]; lab[i] = L;
    while (st.length) { const p = st.pop(); n++; const px = p % W, py = (p / W) | 0; for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= W * H) continue; const qx = q % W; if (Math.abs(qx - px) > 1) continue; if (mask[q] && !lab[q]) { lab[q] = L; st.push(q); } } }
    if (n > bestN) { bestN = n; bestLab = L; }
  }
  if (bestN < tot * 0.15 || bestN > tot * 0.97) return null;
  // corners: extremes of x+y and x-y
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  let touches = 0;
  for (let y = 0; y < H; y++) for (let x2 = 0; x2 < W; x2++) if (lab[y * W + x2] === bestLab) {
    const a = x2 + y, b = x2 - y;
    if (a < tl[2]) tl = [x2, y, a]; if (a > br[2]) br = [x2, y, a];
    if (b > tr[2]) tr = [x2, y, b]; if (b < bl[2]) bl = [x2, y, b];
    if (x2 === 0 || y === 0 || x2 === W - 1 || y === H - 1) touches++;
  }
  if (touches > (W + H) * 0.8) return null; // paper fills frame – keep full image
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4, cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const q = [tl, tr, br, bl].map(p => [(p[0] + (cx - p[0]) * 0.015) / W, (p[1] + (cy - p[1]) * 0.015) / H]);
  const area = Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % 4]; return s + p[0] * n[1] - n[0] * p[1]; }, 0) / 2);
  return area > 0.2 ? q : null;
}
/* crop editor */
let cropPg = null, cropState = null;
function openCrop(pg) {
  cropPg = pg; cropState = { rot: pg.rot, quad: pg.quad.map(p => [...p]), filter: pg.filter };
  $('#cropModal').classList.add('on'); drawCrop();
}
function drawCrop() {
  const r = rotated(cropPg.src, cropState.rot);
  const cv = $('#cropCv'); const wrap = $('#cropWrap');
  const maxW = wrap.clientWidth || 360, maxH = Math.min(window.innerHeight * 0.62, wrap.clientHeight || 500);
  const s = Math.min(maxW / r.width, maxH / r.height, 1);
  cv.width = Math.round(r.width * s); cv.height = Math.round(r.height * s);
  cv.getContext('2d').drawImage(r, 0, 0, cv.width, cv.height);
  $$('#cropFilters .opt').forEach(o => o.classList.toggle('on', o.dataset.k === cropState.filter));
  placeHandles();
}
function placeHandles() {
  const cv = $('#cropCv'), wrap = $('#cropWrap');
  $$('.handle', wrap).forEach(h => h.remove());
  const cr = cv.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const ox = cr.left - wr.left, oy = cr.top - wr.top;
  const pts = cropState.quad.map(([u, v]) => [ox + u * cr.width, oy + v * cr.height]);
  const svg = $('#cropSvg'); svg.setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`); svg.setAttribute('width', wr.width); svg.setAttribute('height', wr.height);
  $('#cropPoly').setAttribute('points', pts.map(p => p.join(',')).join(' '));
  pts.forEach((p, i) => {
    const h = document.createElement('div'); h.className = 'handle'; h.style.left = p[0] + 'px'; h.style.top = p[1] + 'px';
    h.onpointerdown = e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId);
      h.onpointermove = ev => {
        const c2 = cv.getBoundingClientRect();
        cropState.quad[i] = [Math.max(0, Math.min(1, (ev.clientX - c2.left) / c2.width)), Math.max(0, Math.min(1, (ev.clientY - c2.top) / c2.height))];
        placeHandles();
      };
      h.onpointerup = () => { h.onpointermove = null; };
    };
    wrap.appendChild(h);
  });
}
$$('#cropFilters .opt').forEach(o => o.onclick = () => { cropState.filter = o.dataset.k; $$('#cropFilters .opt').forEach(x => x.classList.toggle('on', x === o)); });
$('#cropRot').onclick = () => { cropState.rot = (cropState.rot + 1) % 4; cropState.quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; drawCrop(); };
$('#cropReset').onclick = () => { cropState.quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; placeHandles(); };
$('#cropCancel').onclick = () => $('#cropModal').classList.remove('on');
$('#cropOk').onclick = async () => {
  Object.assign(cropPg, cropState); $('#cropOk').disabled = true; await sleep(20);
  try { processScan(cropPg); } finally { $('#cropOk').disabled = false; }
  $('#cropModal').classList.remove('on'); renderScans();
};
window.addEventListener('resize', () => { if ($('#cropModal').classList.contains('on')) drawCrop(); });

$('#scanGo').onclick = () => run(async () => {
  const name = 'scan_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const size = $('#scanSize').value;
  let files = [], hint = '';
  if (scanFmt === 'pdf') {
    const ocr = $('#scanOcr').checked;
    const pages = scanPages.map(p => placeOnPage(p.out, size, 'auto', size === 'fit' ? 0 : 14));
    files = [{ name: name + '.pdf', blob: await buildImagePdf(pages, ocr, 'Building PDF') }];
    hint = ocr ? 'Searchable PDF – text read with OCR in ' + ocrLangs.map(langName).join(' + ') + '.' : '';
  } else if (scanFmt === 'jpg') {
    const ents = [];
    for (let i = 0; i < scanPages.length; i++) ents.push({ name: `${name}_p${i + 1}.jpg`, blob: await canvasBlob(scanPages[i].out, 'image/jpeg', 0.9) });
    files = await zipOrSingle(ents, name + '_images.zip');
  } else {
    const pages = [];
    for (let i = 0; i < scanPages.length; i++) {
      prog(`OCR on page ${i + 1} of ${scanPages.length}…`, 0.1 + 0.8 * i / scanPages.length);
      const cv = scanPages[i].out; const r = await ocrCanvas(cv, false);
      const s = 72 / 150; // treat scans as 150 dpi
      const items = r.items.map(it => ({ ...it, x: it.x * s, top: it.top * s, w: it.w * s, h: it.h * s, size: Math.min(14, it.size * s) }));
      pages.push({ n: i + 1, w: cv.width * s, h: cv.height * s, items, lines: buildLines(items), ocr: true });
    }
    prog('Writing file…', 0.95);
    if (scanFmt === 'docx') files = [{ name: name + '.docx', blob: await writeDocx(pages.map(p => ({ ...p, w: 595.28, h: p.h * 595.28 / p.w, _sw: p.w })).map(fixScale), 'text') }];
    else files = [{ name: name + '.txt', blob: new Blob([pagesToText(pages)], { type: 'text/plain;charset=utf-8' }) }];
    hint = 'Text read with OCR in ' + ocrLangs.map(langName).join(' + ') + '. Check it for errors.';
  }
  prog('Done', 1);
  showResult(files, hint);
});
/* rescale OCR page model to A4 width for Word */
function fixScale(p) {
  const k = 595.28 / p._sw;
  const items = p.items.map(i => ({ ...i, x: i.x * k, top: i.top * k, w: i.w * k, h: i.h * k, size: Math.max(8, Math.min(16, i.size * k)) }));
  return { ...p, items, lines: buildLines(items) };
}

/* ---------------- buttons ---------------- */
function refreshButtons() {
  if (busy) return;
  $('#fromGo').disabled = !fromFile;
  $('#toGo').disabled = !toFiles.length;
  $('#scanGo').disabled = !scanPages.length;
  $('#scanGo').textContent = scanPages.length ? `Save ${scanPages.length} page${scanPages.length > 1 ? 's' : ''}` : 'Save';
}
refreshButtons();
/* drag & drop */
for (const [id, fn] of [['#fromDrop', fl => setFromFile(fl[0])], ['#toDrop', fl => { toFiles = toFiles.concat(Array.from(fl)); renderToList(); }]]) {
  const el = $(id);
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('has'); });
  el.addEventListener('drop', e => { e.preventDefault(); fn(e.dataTransfer.files); });
}
window.DC = { readPdfPages, openPdf, buildLines, pageBlocks, linesToGrid, ocrCanvas, getOcr }; // for testing
