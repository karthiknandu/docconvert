/* DocConvert quality engine.
   Every page goes through: inspect → repair image → read text (with retries) → clean → layout → self-check.
   Everything runs on the device. */
'use strict';
const Engine = (() => {

  /* ================= report ================= */
  let R = null;
  function resetReport() { docLangs = null; probes = 0; lastWinner = null; R = { counts: {}, flagged: new Set(), notes: [], langSwitch: null }; return R; }
  function note(key, n = 1) { if (R) R.counts[key] = (R.counts[key] || 0) + n; }
  function flag(pageNo) { if (R) R.flagged.add(pageNo); }
  const LABELS = {
    upscaled: n => `Enlarged ${n} low-resolution page(s) for better reading`,
    deskew: n => `Straightened ${n} tilted page(s)`,
    rotated: n => `Turned ${n} sideways/upside-down page(s) upright`,
    cropped: n => `Cropped the background around ${n} photo(s)`,
    whitened: n => `Removed shadows and whitened the paper on ${n} page(s)`,
    sharpened: n => `Sharpened ${n} blurry page(s)`,
    split: n => `Split ${n} photo(s) that held two pages`,
    blank: n => `Skipped ${n} blank page(s)`,
    picture: n => `Kept ${n} page(s) as pictures (charts, graphs, photos)`,
    images: n => `Kept ${n} logo(s)/signature(s)/stamp(s)/figure(s) as images`,
    junkLines: n => `Removed ${n} junk text line(s) (logos, handwriting, specks)`,
    junkWords: n => `Removed ${n} unreadable word(s)`,
    textFix: n => `Corrected ${n} number/web/email reading error(s)`,
    learnedFix: n => `Applied ${n} of your earlier corrections`,
    dictFix: n => `Fixed ${n} word(s) using your personal dictionary`,
    layoutHit: n => `Recognised ${n} page(s) from a layout seen before – reused what worked`,
    skipped: n => `Skipped ${n} retry step(s) that never help on this kind of page (faster)`,
    retried: n => `Re-read ${n} page(s) with different settings for a better result`,
    garbled: n => `${n} page(s) had broken embedded text – read with OCR instead`,
    ocr: n => `Read ${n} scanned page(s) with OCR`,
    reread: n => `Read ${n} boxed table/text area(s) separately so nothing is missed`,
    ai: n => `Read ${n} hard page(s) with the laptop AI`,
    aiTaught: n => `The laptop AI taught the phone ${n} word correction(s)`,
    aiFail: n => `Laptop AI could not be used for ${n} page(s) – used the phone's own reading`,
    tables: n => `Rebuilt ${n} table(s)`,
    fakeTables: n => `Ignored ${n} false table(s)`,
    headerFooter: n => `Moved repeated header/footer text out of ${n} page(s)`,
    pageNums: n => `Removed ${n} page-number line(s) from the text`,
    columns: n => `Read ${n} two-column page(s) in the right order`,
    lists: n => `Rebuilt ${n} list item(s)`,
    faithful: n => `Kept the original look for ${n} page(s) (forms, bills, receipts, cards) with the text editable in place`,
    flowPages: n => `Rebuilt ${n} page(s) as flowing, editable text`,
    fit: n => `Adjusted text size so ${n} page(s) fit on one page each`
  };
  function reportLines() {
    if (!R) return [];
    const out = [];
    if (R.langSwitch) out.push(R.langSwitch);
    for (const k of Object.keys(LABELS)) if (R.counts[k]) out.push(LABELS[k](R.counts[k]));
    out.push(...R.notes);
    return out;
  }
  function flaggedPages() { return R ? [...R.flagged].sort((a, b) => a - b) : []; }

  /* ================= image helpers ================= */
  const cnv = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const ctx2 = c => c.getContext('2d', { willReadFrequently: true });
  function scaled(src, w, h) {
    const c = cnv(w, h); const x = ctx2(c); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height); return c;
  }
  function grayOf(cv) {
    const d = ctx2(cv).getImageData(0, 0, cv.width, cv.height).data; const n = cv.width * cv.height; const g = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    return g;
  }
  function grayCanvas(g, w, h) {
    const c = cnv(w, h); const x = ctx2(c); const id = x.createImageData(w, h); const d = id.data;
    for (let i = 0, p = 0; i < g.length; i++, p += 4) { d[p] = d[p + 1] = d[p + 2] = g[i]; d[p + 3] = 255; }
    x.putImageData(id, 0, 0); return c;
  }
  function otsu(g) {
    const hist = new Float64Array(256); for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = -1, th = 128; const tot = g.length;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF; const b = wB * wF * (mB - mF) ** 2; if (b > best) { best = b; th = t; } }
    return th;
  }
  function rotateCanvas(cv, deg) {
    if (!deg) return cv;
    const r = deg * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const W = Math.round(cv.width * c + cv.height * s), H = Math.round(cv.width * s + cv.height * c);
    const o = cnv(W, H); const x = ctx2(o); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.imageSmoothingQuality = 'high'; x.translate(W / 2, H / 2); x.rotate(r); x.drawImage(cv, -cv.width / 2, -cv.height / 2);
    return o;
  }
  function crop(cv, x, y, w, h) { const c = cnv(w, h); const t = ctx2(c); t.fillStyle = '#fff'; t.fillRect(0, 0, c.width, c.height); t.drawImage(cv, x, y, w, h, 0, 0, w, h); return c; }

  /* small working copy: grey + binary (dark = 1) */
  function probe(cv, maxW = 1000) {
    const s = Math.min(1, maxW / cv.width); const w = Math.max(1, Math.round(cv.width * s)), h = Math.max(1, Math.round(cv.height * s));
    const sc = scaled(cv, w, h); const g = grayOf(sc); const th = Math.min(otsu(g), 200);
    const b = new Uint8Array(g.length); let ink = 0;
    for (let i = 0; i < g.length; i++) if (g[i] < th && g[i] < 170) { b[i] = 1; ink++; }
    return { g, b, w, h, s, ink: ink / g.length };
  }

  /* --- skew: projection profile --- */
  function profileScore(pts, w, h, ang) {
    const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const off = w * Math.abs(sa) + 2; const bins = new Float64Array(Math.ceil(h + 2 * off) + 2);
    for (let i = 0; i < pts.length; i += 2) { const y = pts[i + 1] * ca - pts[i] * sa + off; bins[y | 0]++; }
    let s = 0; for (let i = 1; i < bins.length; i++) { const d = bins[i] - bins[i - 1]; s += d * d; } return s;
  }
  function inkPoints(P, cap = 70000) {
    const n = P.b.reduce((a, v) => a + v, 0); const step = Math.max(1, Math.floor(n / cap)); const pts = []; let k = 0;
    for (let y = 0; y < P.h; y++) for (let x = 0; x < P.w; x++) if (P.b[y * P.w + x] && (k++ % step === 0)) pts.push(x, y);
    return pts;
  }
  /* character-sized blobs → their bottom-centre points (robust against borders, photos, shadows) */
  function charPoints(P) {
    const { b, w, h } = P; const lab = new Int32Array(b.length); const pts = []; const hts = []; let L = 0; const st = [];
    const maxH = Math.max(8, h * 0.03), maxW = Math.max(10, w * 0.06);
    for (let i = 0; i < b.length; i++) if (b[i] && !lab[i]) {
      L++; lab[i] = L; st.length = 0; st.push(i); let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
      while (st.length) { const p = st.pop(); const px = p % w, py = (p / w) | 0; n++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= b.length || lab[q] || !b[q]) continue; if (Math.abs((q % w) - px) > 1) continue; lab[q] = L; st.push(q); } }
      const bh = y1 - y0 + 1, bw = x1 - x0 + 1;
      if (bh >= 3 && bh <= maxH && bw >= 2 && bw <= maxW && n >= 4) { pts.push((x0 + x1) / 2, y1); hts.push(bh); }
    }
    pts.heights = hts; return pts;
  }
  function bestAngle(pts, w, h, range) {
    let best = 0, bs = -1;
    for (let a = -range; a <= range; a += 0.5) { const s = profileScore(pts, w, h, a); if (s > bs) { bs = s; best = a; } }
    for (let a = best - 0.5; a <= best + 0.5; a += 0.1) { const s = profileScore(pts, w, h, a); if (s > bs) { bs = s; best = a; } }
    return { a: best, s: bs };
  }
  function detectSkew(P) {
    const pts = charPoints(P);
    if (pts.length < 2 * 60) return { angle: 0, sideways: false, text: false };
    const h0 = bestAngle(pts, P.w, P.h, 15);
    const s0 = profileScore(pts, P.w, P.h, 0);
    const t = []; for (let i = 0; i < pts.length; i += 2) t.push(pts[i + 1], pts[i]);
    const v0 = bestAngle(t, P.h, P.w, 15);
    const need = Math.abs(h0.a) > 3 ? 1.15 : 1.03;
    const angle = Math.abs(h0.a) >= 0.25 && h0.s > s0 * need ? +h0.a.toFixed(2) : 0;
    const hs = pts.heights.slice().sort((a, b) => a - b);
    return { angle, sideways: v0.s > h0.s * 1.3, text: true, charH: hs[hs.length >> 1] / P.s };
  }
  /* --- blur: variance of Laplacian --- */
  function blurScore(P) {
    const { g, w, h } = P; let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x; const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += v; s2 += v * v; n++;
    }
    return n ? s2 / n - (s / n) ** 2 : 1e9;
  }
  /* --- shadow removal + paper whitening (colour) --- */
  function whiten(cv) {
    const W = cv.width, H = cv.height; const f = Math.max(4, Math.round(Math.max(W, H) / 220));
    const sw = Math.max(8, Math.round(W / f)), sh = Math.max(8, Math.round(H / f));
    const small = scaled(cv, sw, sh); const sd = ctx2(small).getImageData(0, 0, sw, sh); const d = sd.data;
    // paper colour: bright end of each channel → one white-balance gain for the whole page (no colour blotches)
    const pct = c => { const h = new Uint32Array(256); for (let i = c; i < d.length; i += 4) h[d[i]]++; let acc = 0; const tot = sw * sh; for (let v = 255; v >= 0; v--) { acc += h[v]; if (acc > tot * 0.1) return Math.max(60, v); } return 255; };
    const gain = [pct(0), pct(1), pct(2)].map(v => 255 / v); const gm = Math.max(...gain); for (let c = 0; c < 3; c++) gain[c] /= gm;
    // background brightness (shadows) from luminance only
    let a = new Float32Array(sw * sh); for (let i = 0; i < sw * sh; i++) a[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    const r = Math.max(2, Math.round(Math.max(sw, sh) / 45));
    for (let pass = 0; pass < 2; pass++) {
      const t = new Float32Array(a.length);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let m = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < sw) { const v = a[y * sw + xx]; if (v > m) m = v; } } t[y * sw + x] = m; }
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { let m = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < sh) { const v = t[yy * sw + x]; if (v > m) m = v; } } a[y * sw + x] = m; }
    }
    for (let i = 0; i < sw * sh; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = a[i];
    ctx2(small).putImageData(sd, 0, 0);
    const bg = cnv(W, H); const bx = ctx2(bg); bx.filter = `blur(${Math.round(f * 2)}px)`; bx.imageSmoothingQuality = 'high'; bx.drawImage(small, 0, 0, W, H); bx.filter = 'none';
    const bd = bx.getImageData(0, 0, W, H).data; const out = cnv(W, H); const ox = ctx2(out); ox.drawImage(cv, 0, 0);
    const od = ox.getImageData(0, 0, W, H); const o = od.data;
    for (let i = 0; i < o.length; i += 4) { const k = 255 / Math.max(60, bd[i]); for (let c = 0; c < 3; c++) o[i + c] = Math.min(255, o[i + c] * k * gain[c] * (c === 0 ? 1 : 1)); }
    // contrast: push ink darker
    const hist = new Uint32Array(256); for (let i = 0; i < o.length; i += 16) hist[(o[i] * 77 + o[i + 1] * 150 + o[i + 2] * 29) >> 8]++;
    let tot = 0; for (const v of hist) tot += v; let acc = 0, lo = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > tot * 0.004) { lo = v; break; } }
    lo = Math.min(lo, 120);
    if (lo > 8) for (let i = 0; i < o.length; i += 4) for (let c = 0; c < 3; c++) o[i + c] = Math.max(0, (o[i + c] - lo) * 255 / (255 - lo));
    ox.putImageData(od, 0, 0); return out;
  }
  function sharpen(cv) {
    const o = cnv(cv.width, cv.height); const x = ctx2(o); x.filter = 'blur(1.2px)'; x.drawImage(cv, 0, 0); x.filter = 'none';
    const b = x.getImageData(0, 0, o.width, o.height); const s = ctx2(cv).getImageData(0, 0, o.width, o.height); const d = s.data, bd = b.data;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, d[i + c] + 0.9 * (d[i + c] - bd[i + c])));
    x.putImageData(s, 0, 0); return o;
  }
  /* binary + despeckle variant for a second OCR attempt */
  function binarize(cv) {
    const W = cv.width, H = cv.height, g = grayOf(cv), N = W * H; const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
    const S = Math.max(10, Math.round(Math.max(W, H) / 50)), T = 0.15; const b = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x1 = Math.max(0, x - S), x2 = Math.min(W - 1, x + S), y1 = Math.max(0, y - S), y2 = Math.min(H - 1, y + S);
      const cnt = (x2 - x1 + 1) * (y2 - y1 + 1), sum = I[(y2 + 1) * (W + 1) + x2 + 1] - I[y1 * (W + 1) + x2 + 1] - I[(y2 + 1) * (W + 1) + x1] + I[y1 * (W + 1) + x1];
      if (g[y * W + x] * cnt <= sum * (1 - T) && g[y * W + x] < 200) b[y * W + x] = 1;
    }
    // despeckle: remove tiny components
    const lab = new Int32Array(N); const minA = Math.max(6, Math.round(N / 400000)); const st = [];
    for (let i = 0; i < N; i++) if (b[i] && !lab[i]) {
      const comp = [i]; lab[i] = 1; st.length = 0; st.push(i);
      while (st.length && comp.length <= minA) { const p = st.pop(); const px = p % W; for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= N || lab[q] || !b[q]) continue; const qx = q % W; if (Math.abs(qx - px) > 1) continue; lab[q] = 1; st.push(q); comp.push(q); } }
      if (comp.length <= minA && !st.length) for (const p of comp) b[p] = 0;
    }
    const out = new Uint8ClampedArray(N); for (let i = 0; i < N; i++) out[i] = b[i] ? 0 : 255;
    return grayCanvas(out, W, H);
  }
  /* two pages side by side in one photo */
  function findSplit(P) {
    if (P.w < P.h * 1.15) return 0;
    const col = new Float64Array(P.w); for (let y = 0; y < P.h; y++) for (let x = 0; x < P.w; x++) col[x] += P.b[y * P.w + x];
    let best = -1, bestRun = 0, run = 0, start = 0;
    for (let x = Math.round(P.w * 0.35); x < P.w * 0.65; x++) {
      if (col[x] < P.h * 0.004) { if (!run) start = x; run++; if (run > bestRun) { bestRun = run; best = start + run / 2; } } else run = 0;
    }
    if (bestRun < P.w * 0.015) return 0;
    const inkL = col.slice(0, best).reduce((a, v) => a + v, 0) / (best * P.h), inkR = col.slice(best).reduce((a, v) => a + v, 0) / ((P.w - best) * P.h);
    return inkL > 0.01 && inkR > 0.01 ? best / P.w : 0;
  }

  /* ================= stage 1–2: inspect + repair =================
     input: canvas (colour). opts: {pageNo, photo: bool (may have background), allowSplit}
     returns [{display (colour, cleaned), ocrImg (for OCR), blank, sideways, blurry, info}] (2 when split) */
  function repair(cv, opts = {}) {
    const pageNo = opts.pageNo || 0;
    let P = probe(cv);
    if (P.ink < 0.0015) { note('blank'); return [{ display: cv, ocrImg: cv, blank: true }]; }
    // two pages in one photo
    if (opts.allowSplit) {
      const sx = findSplit(P);
      if (sx) {
        note('split');
        const L = crop(cv, 0, 0, Math.round(cv.width * sx), cv.height), Rr = crop(cv, Math.round(cv.width * sx), 0, cv.width - Math.round(cv.width * sx), cv.height);
        return [...repair(L, { ...opts, allowSplit: false }), ...repair(Rr, { ...opts, allowSplit: false })];
      }
    }
    let img = cv;
    // background around the paper
    if (opts.photo && typeof autoQuad === 'function' && typeof warp === 'function') {
      const q = autoQuad(img);
      if (q) {
        const area = Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % 4]; return s + p[0] * n[1] - n[0] * p[1]; }, 0) / 2);
        const dd = (p, q) => Math.hypot((p[0] - q[0]) * img.width, (p[1] - q[1]) * img.height); const asp = (dd(q[0], q[1]) + dd(q[3], q[2])) / Math.max(1, dd(q[0], q[3]) + dd(q[1], q[2]));
        if (area < 0.9 && area > 0.3 && asp > 0.55 && asp < 1.9) { img = warp(img, q.map(([u, v]) => [u * img.width, v * img.height])); note('cropped'); }
      }
    }
    // resolution: aim for ~300 dpi equivalent (A4 width ≈ 2480 px)
    const target = opts.targetW || 2400;
    if (img.width < target * 0.8) { const s = Math.min(3, target / img.width); img = scaled(img, img.width * s, img.height * s); if (opts.lowRes !== false) note('upscaled'); }
    // lighting / paper colour first, so shadows don't confuse the tilt check
    const before = probe(img, 400); const bgMean = before.g.reduce((a, v) => a + v, 0) / before.g.length;
    let wh = img;
    if (opts.whiten !== false) { wh = whiten(img); if (bgMean < 225 || opts.photo) note('whitened'); }
    // skew / sideways
    P = probe(wh);
    const sk = detectSkew(P);
    if (sk.angle) { wh = rotateCanvas(wh, -sk.angle); note('deskew'); }
    // reading resolution: aim for ~30 px tall characters – big print is read smaller (faster), tiny print enlarged
    if (sk.charH) {
      const k = Math.max(0.5, Math.min(1.4, 22 / sk.charH));
      const nw = Math.round(wh.width * k);
      if (Math.abs(k - 1) > 0.12 && nw >= 1100 && nw <= 2800) wh = scaled(wh, nw, wh.height * k);
    }
    // blur
    const P2 = probe(wh, 1000); const bl = blurScore(P2);
    let blurry = false;
    if (bl < 260) { wh = sharpen(wh); note('sharpened'); if (bl < 90) { blurry = true; flag(pageNo); } }
    return [{ display: wh, ocrImg: wh, blank: false, sideways: sk.sideways, blurry, ink: P2.ink, angle: sk.angle, textLike: sk.text }];
  }

  /* ================= stage 3: read (OCR with retries) ================= */
  const workers = {};
  async function worker(langs) {
    const key = langs.join('+');
    if (workers[key]) return workers[key];
    const T = await lib.tesseract();
    const mk = cacheMethod => T.createWorker(langs, 1, { workerPath: BASE + 'tess/worker.min.js', corePath: BASE + 'tess/', langPath: BASE + 'tessdata', gzip: true, cacheMethod });
    workers[key] = (async () => { try { return await mk('write'); } catch (e) { return await mk('none'); } })();
    return workers[key];
  }
  /* pool of OCR engines so several pages are read at the same time */
  const POOL_N = (() => { try { const o = +localStorage.getItem('dc_pool'); if (o) return o; } catch (e) { } return Math.max(2, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2))); })();
  const pools = {};
  async function newWorker(langs) {
    const T = await lib.tesseract();
    const mk = cacheMethod => T.createWorker(langs, 1, { workerPath: BASE + 'tess/worker.min.js', corePath: BASE + 'tess/', langPath: BASE + 'tessdata', gzip: true, cacheMethod });
    try { return await mk('write'); } catch (e) { return await mk('none'); }
  }
  async function acquire(langs) {
    const key = langs.join('+'); const P = pools[key] || (pools[key] = { n: 0, free: [], wait: [] });
    if (P.free.length) return P.free.pop();
    if (P.n < POOL_N) { P.n++; try { return await newWorker(langs); } catch (e) { P.n--; throw e; } }
    return new Promise(r => P.wait.push(r));
  }
  function release(langs, w) { const P = pools[langs.join('+')]; const nx = P.wait.shift(); if (nx) nx(w); else P.free.push(w); }
  const T = (k, t0) => { if (typeof window !== 'undefined' && window.__time) window.__time[k] = (window.__time[k] || 0) + (performance.now() - t0); };
  async function runOcr(img, langs, psm, wantPdf) {
    const w = await acquire(langs); const t0 = performance.now();
    try {
      await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1' });
      const r = await w.recognize(img, { pdfTextOnly: true }, { blocks: true, text: true, pdf: !!wantPdf });
      return { data: r.data, W: img.width, H: img.height, pdf: r.data.pdf ? new Uint8Array(r.data.pdf) : null };
    } finally { T('ocr:' + img.width, t0); T('ocrCalls', t0 - 1); release(langs, w); }
  }
  const isWordy = t => { if (/^\(?(\d{1,3}|[a-z]|[ivx]{1,4})[.)]$/i.test(t) || /^[•·▪●◦○■➢►✓✔*\-–]$/.test(t)) return true; const a = (t.match(/[\p{L}\p{N}]/gu) || []).length; return a >= Math.max(1, t.length * 0.6); };
  /* flatten tesseract output into words + lines, apply junk filters */
  function harvest(res) {
    const words = [], lines = []; const W = res.W;
    let bi = 0;
    for (const b of (res.data.blocks || [])) {
      bi++;
      let pi = 0;
      for (const p of (b.paragraphs || [])) {
        pi++;
        for (const l of (p.lines || [])) {
          const lw = [];
          for (const wd of (l.words || [])) {
            const t = (wd.text || '').trim().replace(/^[|¦\[]+(?=\S)|(?<=\S)[|¦\]]+$/g, ''); if (!t) continue;
            const bb = wd.bbox; lw.push({ t, conf: wd.confidence, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 });
          }
          if (lw.length > 1 && /^([*+•·°»>●▪■◦○-]|e|o|«)$/.test(lw[0].t) && /^\p{Lu}/u.test(lw[1].t) && lw[1].conf >= 75 && (lw[1].x0 - lw[0].x1) > (lw[0].y1 - lw[0].y0) * 0.4) { lw[0].t = '•'; lw[0].conf = 95; }
          if (lw.length) lines.push({ words: lw, bbox: l.bbox, rowH: (l.rowAttributes && l.rowAttributes.row_height) || (l.bbox.y1 - l.bbox.y0), block: bi, para: bi * 1000 + pi });
        }
      }
    }
    // stats
    const hs = lines.map(l => l.rowH).sort((a, b) => a - b); const medH = hs.length ? hs[hs.length >> 1] : 20;
    let junkW = 0, junkL = 0; const kept = [];
    for (const l of lines) {
      const good = l.words.filter(w => {
        const h = w.y1 - w.y0, wd = w.x1 - w.x0;
        if (w.conf < 35) return false;
        if (h > medH * 4 || h < medH * 0.25) return false;
        if (wd > h * 25 && w.t.length < 6) return false; // stretched page-edge artefacts
        if (w.conf < 65 && !isWordy(w.t)) return false;
        if (W && w.t.length <= 2 && (w.x1 < W * 0.07 || w.x0 > W * 0.94) && !/^\d+[.)]?$/.test(w.t)) return false; // punch holes, page edge
        if (/^[«»<>§¶|¦\\\/\[\]]+$/.test(w.t)) return false;
        if (/^[lI1!]$/.test(w.t) && w.conf < 90) return false;
        if (/^(.)\1{2,}$/.test(w.t) && !/^[.\-_=]+$/.test(w.t) && w.conf < 85) return false;
        if (/^[—–\-_=~.]{4,}$/.test(w.t)) return false; // separator rules
        return true;
      });
      junkW += l.words.length - good.length;
      const chars = good.reduce((a, w) => a + w.t.length, 0);
      const mc = good.length ? good.reduce((a, w) => a + w.conf * w.t.length, 0) / Math.max(1, chars) : 0;
      const alnum = good.map(w => w.t).join('').match(/[\p{L}\p{N}]/gu) || [];
      const sep = l.words.filter(w => /^[|¦\[\]{}!lI1\/\\_—–-]{1,2}$/.test(w.t)).length; // table rules read as characters
      const bad = !good.length || good.length < (l.words.length - sep) * 0.4 || mc < 55 || alnum.length < 0.5 * chars ||
        (good.length === 1 && good[0].t.length <= 2 && good[0].conf < 88 && !/^\d+[.)]?$/.test(good[0].t)) ||
        (alnum.length <= 5 && mc < 80 && !/^\d+[.)]?$/.test(good.map(w => w.t).join('')));
      if (bad) { junkL++; continue; }
      kept.push({ ...l, words: good, conf: mc });
    }
    const keptChars = kept.reduce((a, l) => a + l.words.reduce((b, w) => b + w.t.length, 0), 0);
    const score = kept.reduce((a, l) => a + l.words.reduce((b, w) => b + w.t.length * (w.conf / 100) ** 2, 0), 0);
    const meanConf = keptChars ? kept.reduce((a, l) => a + l.conf * l.words.reduce((b, w) => b + w.t.length, 0), 0) / keptChars : 0;
    const rawConf = res.data.confidence || 0;
    return { lines: kept, junkW, junkL, score, meanConf, rawConf, chars: keptChars, medH };
  }
  async function rotatedTry(img, langs, sideways) {
    const s = Math.min(1, 1000 / Math.max(img.width, img.height)); const small = scaled(img, img.width * s, img.height * s);
    const sc = {};
    const test = async deg => (sc[deg] = harvest(await runOcr(rotateCanvas(small, deg), langs, 3, false)).score);
    await test(0);
    if (sideways) { await test(90); await test(270); }
    await test(180);
    if (!sideways && sc[180] < sc[0] * 1.5) { await test(90); await test(270); }
    let best = 0; for (const d in sc) if (sc[d] > sc[best] * 1.3) best = +d;
    return best;
  }
  const PROBE_LANGS = ['hin', 'tam', 'tel', 'kan', 'mal', 'ben', 'guj', 'pan', 'ara', 'chi_sim', 'jpn', 'kor', 'rus', 'tha'];
  const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}]+$/u;
  let probeWorker = null, probeLang = null, probes = 0, lastWinner = null, docLangs = null;
  let probeChain = Promise.resolve();
  function probeWith(lang, img) { const r = probeChain.then(() => probeWith1(lang, img)); probeChain = r.catch(() => { }); return r; } // one at a time
  async function probeWith1(lang, img) {
    if (!probeWorker) { const T = await lib.tesseract(); probeWorker = await T.createWorker([lang], 1, { workerPath: BASE + 'tess/worker.min.js', corePath: BASE + 'tess/', langPath: BASE + 'tessdata', gzip: true }); }
    else if (probeLang !== lang) await probeWorker.reinitialize([lang], 1);
    probeLang = lang;
    const r = await probeWorker.recognize(img, {}, { blocks: true, text: false });
    // count confidently read characters that are really in this script (not Latin)
    let n = 0;
    for (const b of (r.data.blocks || [])) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
      const t = (w.text || '').trim(); if (!t || w.confidence < 72 || LATIN.test(t)) continue;
      n += (t.match(/\p{L}/gu) || []).length;
    }
    return n;
  }
  async function scriptProbe(img, langs) {
    if (probes >= 3) return langs;
    probes++;
    const s = Math.min(1, 1100 / img.width); const small = crop(scaled(img, img.width * s, img.height * s), 0, Math.round(img.height * s * 0.15), Math.round(img.width * s), Math.round(img.height * s * 0.6));
    const order = PROBE_LANGS;
    let best = null, bestN = 0, second = 0;
    for (const L of order) {
      if (langs.includes(L)) continue;
      if (typeof prog === 'function') prog(`Checking the page's script (${typeof langName === 'function' ? langName(L) : L})…`, null);
      let n = 0; try { n = await probeWith(L, small); } catch (e) { console.warn("probe fail", L, e); continue; }
      if (window.__dbgProbe) window.__dbgProbe.push([L, n]);
      if (n > bestN) { second = bestN; bestN = n; best = L; } else if (n > second) second = n;
      if (n >= 80 && n > second * 2) { best = L; bestN = n; second = 0; break; } // clear hit – most likely scripts are tried first
    }
    const strict = ['tha', 'chi_sim', 'jpn', 'kor', 'rus', 'ara'].includes(best); // scripts that give false hits on noisy Latin print
    if (best && bestN >= (strict ? 150 : 40) && bestN > second * (strict ? 3 : 1.5)) { lastWinner = best; return [best, ...langs.filter(l => l !== best)].slice(0, 3); }
    return langs;
  }
  /* read one repaired page: returns harvested model + chosen image + optional text PDF */
  async function read(page, langs, opts = {}) {
    const pageNo = opts.pageNo || 0;
    let img = page.ocrImg, display = page.display;
    let useLangs = docLangs || langs;
    let res = await runOcr(img, useLangs, 3, opts.wantPdf); let H = harvest(res); let tries = 1;
    const kindKey = opts.photo ? 'photo' : 'scan';
    const L = typeof Learn !== 'undefined' ? Learn : null;
    const sig = L ? L.signature(H.lines) : null; const lay = L ? L.layout(sig) : null;
    let knownLangs = false, winner = 'base';
    if (lay) {
      note('layoutHit');
      if (lay.langs && lay.langs.join() !== useLangs.join()) { const r2 = await runOcr(img, lay.langs, 3, opts.wantPdf); const H2 = harvest(r2); tries++; if (H2.score > H.score) { res = r2; H = H2; useLangs = lay.langs; } knownLangs = true; }
      else if (lay.langs) knownLangs = true;
    }
    // upright?
    if ((H.meanConf < 70 || H.chars < 80 || page.sideways) && (page.ink || 0) > 0.004) {
      const deg = await rotatedTry(img, useLangs, page.sideways);
      if (deg) {
        img = rotateCanvas(img, deg); display = rotateCanvas(display, deg); note('rotated');
        res = await runOcr(img, useLangs, 3, opts.wantPdf); H = harvest(res); tries++;
      }
    }
    // other language/script? (unreadable text, or many lines that could not be read)
    const lowRead = (H.meanConf < 50 && H.chars < 200) || (H.junkL >= 8 && H.junkL > H.lines.length * 0.6);
    if (!knownLangs && lowRead && (page.ink || 0) > 0.01 && (page.ink || 0) < 0.3 && page.textLike !== false && opts.allowProbe !== false) {
      const nl = await scriptProbe(img, useLangs);
      if (nl.join() !== useLangs.join()) {
        useLangs = nl;
        const nm = nl.filter(l => l !== 'eng').map(l => typeof langName === 'function' ? langName(l) : l).join(', ');
        const r2 = await runOcr(img, useLangs, 3, opts.wantPdf); const H2 = harvest(r2); tries++;
        if (H2.score > H.score * 1.2) { res = r2; H = H2; if (R) R.notes.push(`Page ${pageNo}: text looked like ${nm} – read in ${nm}`); }
      }
    }
    // alternative settings when the result is weak
    if (H.meanConf < 72 || H.junkL > Math.max(5, H.lines.length * 0.4)) {
      const variants = [['clean', () => runOcr(binarize(img), useLangs, 3, opts.wantPdf)], ['column', () => runOcr(img, useLangs, 4, opts.wantPdf)]];
      const pref = lay && lay.variant; if (pref === 'column') variants.reverse();
      for (let k = 0; k < variants.length; k++) {
        const [name, run] = variants[k];
        if (k === 1 && H.meanConf >= 65) break;
        if (L && name !== pref && !L.worthTrying(kindKey, name)) { note('skipped'); continue; }
        if (L) L.statTry(kindKey, name);
        const r2 = await run(); const H2 = harvest(r2); tries++;
        if (H2.score > H.score * 1.05) { res = r2; H = H2; winner = name; if (L) L.statWin(kindKey, name); }
      }
    }
    if (tries > 1) note('retried');
    if (L && sig) L.rememberLayout(sig, { langs: useLangs.join() !== langs.join() ? useLangs : (lay && lay.langs) || null, variant: winner !== 'base' ? winner : (lay && lay.variant) || null });
    if (L) L.learnWords(H.lines.flatMap(l => l.words));
    note('junkWords', H.junkW); note('junkLines', H.junkL);
    if (H.meanConf < 70 && H.chars > 30) flag(pageNo);
    return { H, img, display, textPdf: res.pdf, sig };
  }

  /* ================= stage 4: clean text ================= */
  function fixToken(t, conf) {
    let o = t;
    const digits = (t.match(/\d/g) || []).length, letters = (t.match(/\p{L}/gu) || []).length;
    if (digits >= 3 && digits >= letters * 2 && !/^www/i.test(t)) o = o.replace(/[Oo](?=\d|$)|(?<=\d)[Oo]/g, '0').replace(/(?<=\d)[lI|](?=\d)|^[lI|](?=\d{2})/g, '1');
    if (/^www[^.]/i.test(o)) o = o.replace(/^www/i, 'www.');
    if (/^(https?:\/\/)?www\./i.test(o)) o = o.replace(/([a-z0-9-])(com|org|net|gov|edu|in|co)$/i, (m, a, tld) => /\.(com|org|net|gov|edu|in|co)$/i.test(o) ? m : a + '.' + tld);
    o = o.replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl');
    if (o !== t) note('textFix');
    if (typeof Learn !== 'undefined') { const f = Learn.fixWord(o, conf == null ? 100 : conf); if (f.how) { note(f.how === 'correction' ? 'learnedFix' : 'dictFix'); o = f.text; } }
    return o;
  }
  function joinWords(ws) {
    let s = ws.map(w => fixToken(w.t)).join(' ');
    s = s.replace(/\s+([,.;:!?%)\]])/g, '$1').replace(/([(\[])\s+/g, '$1').replace(/\s*@\s*/g, '@').replace(/\s{2,}/g, ' ');
    return s.trim();
  }

  /* convert harvested OCR (px) into page items (pt) for the layout stage */
  function toItems(H, pxPerPt) {
    const items = [];
    H.lines.forEach((l, li) => {
      const lh = l.bbox.y1 - l.bbox.y0, tall = lh > l.rowH * 2.2;
      for (const w of l.words) {
        const y0 = tall ? w.y0 : l.bbox.y0, h = tall ? (w.y1 - w.y0) * 1.25 : lh, sz = tall ? (w.y1 - w.y0) * 1.1 : lh; // line box height ≈ font size (calibrated)
        items.push({ x: w.x0 / pxPerPt, top: y0 / pxPerPt, w: (w.x1 - w.x0) / pxPerPt, h: h / pxPerPt, size: Math.max(5, sz / pxPerPt), str: fixToken(w.t, w.conf), conf: w.conf, para: l.para, ocr: true, li, src: w });
      }
    });
    return items;
  }

  /* ================= picture regions (logos, signatures, charts) ================= */
  function pictureRegions(display, textBoxesPx, opts = {}) {
    const P = probe(display, 500); const s = P.s; const W = P.w, H = P.h; const m = P.b.slice();
    // remove text boxes (padded)
    for (const b of textBoxesPx) {
      const pad = 3; const x0 = Math.max(0, Math.floor(b.x0 * s) - pad), x1 = Math.min(W - 1, Math.ceil(b.x1 * s) + pad), y0 = Math.max(0, Math.floor(b.y0 * s) - pad), y1 = Math.min(H - 1, Math.ceil(b.y1 * s) + pad);
      for (let y = y0; y <= y1; y++) m.fill(0, y * W + x0, y * W + x1 + 1);
    }
    // remove long thin rules (table lines)
    for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x <= W; x++) { if (x < W && m[y * W + x]) run++; else { if (run > W * 0.2) for (let k = x - run; k < x; k++) m[y * W + k] = 0; run = 0; } } }
    for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y <= H; y++) { if (y < H && m[y * W + x]) run++; else { if (run > H * 0.15) for (let k = y - run; k < y; k++) m[k * W + x] = 0; run = 0; } } }
    // dilate to merge strokes
    const d = new Uint8Array(m.length); const r = 6;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) d.fill(1, yy * W + Math.max(0, x - r), yy * W + Math.min(W - 1, x + r) + 1);
    const lab = new Int32Array(d.length); const regs = []; let L = 0;
    for (let i = 0; i < d.length; i++) if (d[i] && !lab[i]) {
      L++; const st = [i]; lab[i] = L; let x0 = W, y0 = H, x1 = 0, y1 = 0, ink = 0;
      while (st.length) { const p = st.pop(); const px = p % W, py = (p / W) | 0; if (m[p]) ink++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= d.length || lab[q] || !d[q]) continue; if (Math.abs((q % W) - px) > 1) continue; lab[q] = L; st.push(q); } }
      const bw = x1 - x0, bh = y1 - y0, area = bw * bh;
      const eM = Math.max(2, W * 0.03); const touches = x0 <= eM || y0 <= eM || x1 >= W - eM || y1 >= H - eM;
      if (area < W * H * (opts.minArea || 0.012) || bw < W * 0.04 || bh < H * 0.015 || ink < 40) continue;
      if (touches && area < W * H * 0.5) continue; // edge shadows, sticky notes, punch holes
      // a region that mostly holds recognised text is text, not a picture
      let tArea = 0; for (const tb of textBoxesPx) { const ox = Math.min(x1 / s, tb.x1) - Math.max(x0 / s, tb.x0), oy = Math.min(y1 / s, tb.y1) - Math.max(y0 / s, tb.y0); if (ox > 0 && oy > 0) tArea += ox * oy; }
      if (tArea > area / (s * s) * 0.06) continue;
      regs.push({ x0: x0 / s, y0: y0 / s, x1: x1 / s, y1: y1 / s, area: area / (W * H) });
    }
    return regs;
  }

  /* Markdown from the laptop AI → layout blocks */
  function mdToBlocks(md) {
    const out = []; let table = null;
    const clean = t => t.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
    for (const raw of md.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (/^\|/.test(line)) {
        if (/^[|\s:\-]+$/.test(line) && line.includes('-')) continue; // separator row
        const cells = line.replace(/^\||\|$/g, '').split('|').map(clean);
        if (!table) { table = { type: 'table', rows: [] }; out.push(table); }
        table.rows.push(cells); continue;
      }
      table = null;
      if (!line) { out.push({ type: 'gap' }); continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { out.push({ type: 'p', text: clean(m[2]), head: m[1].length === 1 ? 1 : 2, nlines: 1 }); continue; }
      if ((m = line.match(/^[-*•]\s+(.*)$/))) { out.push({ type: 'p', text: clean(m[1]), list: 'bullet', nlines: 1 }); continue; }
      if ((m = line.match(/^(\d{1,3}[.)])\s+(.*)$/))) { out.push({ type: 'p', text: m[1] + ' ' + clean(m[2]), list: 'num', nlines: 1 }); continue; }
      const t = clean(line); const lm = line.match(/^\*\*([^*]{1,60}?[:：]?)\*\*\s*/);
      const prev = out[out.length - 1];
      if (!lm && prev && prev.type === 'p' && !prev.head && !prev.list && !prev.label && /^\p{Ll}/u.test(t) && !/[:.]$/.test(prev.text)) { prev.text += ' ' + t; continue; }
      const b = { type: 'p', text: t, nlines: 1 };
      if (lm) { const lab = clean(lm[1]); b.label = Math.min(t.length, lab.length + (/[:：]$/.test(lab) ? 1 : 0)); }
      out.push(b);
    }
    for (const b of out) if (b.type === 'table') { const n = Math.max(...b.rows.map(r => r.length)); b.rows = b.rows.map(r => r.concat(new Array(n - r.length).fill(''))); }
    return out.filter(b => b.type !== 'gap');
  }
  /* the AI's reading teaches the on-device OCR: dictionary words + (after two sightings) word corrections */
  function teach(md, uncertain) {
    if (typeof Learn === 'undefined') return;
    const toks = (md.replace(/[|*#`_]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}.,'’\-\/]*/gu) || []).map(t => t.replace(/[.,]+$/, ''));
    Learn.learnWords(toks.map(t => ({ t, conf: 95 })));
    const uniq = [...new Set(toks)];
    let n = 0;
    for (const u of uncertain) {
      const o = u.orig.replace(/[^\p{L}\p{N}]+$/u, ''); if (o.length < 3 || uniq.includes(o)) continue;
      const max = o.length >= 8 ? 2 : 1;
      const near = uniq.filter(t => Math.abs(t.length - o.length) <= max && levD(o.toLowerCase(), t.toLowerCase(), max) <= max);
      if (near.length === 1 && near[0] !== o) { Learn.addCorrection(o, near[0], true); Learn.addPair(u.img, near[0], 'ai'); n++; }
    }
    if (n) note('aiTaught', n);
  }
  function levD(a, b, max) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (Math.min(...cur) > max) return max + 1; prev = cur; }
    return prev[b.length];
  }

  /* coloured ink (logos, stamps, signatures in blue pen) that is not readable text → picture */
  function findLogos(disp, H) {
    const P = probe(disp, 600); const s = P.s, W = P.w, Hh = P.h;
    const sc = scaled(disp, W, Hh); const d = ctx2(sc).getImageData(0, 0, W, Hh).data;
    const m = new Uint8Array(W * Hh);
    for (let i = 0, p = 0; i < W * Hh; i++, p += 4) { const mx = Math.max(d[p], d[p + 1], d[p + 2]), mn = Math.min(d[p], d[p + 1], d[p + 2]); if (mx < 235 && (mx - mn) > 55 && (mx - mn) / mx > 0.3) m[i] = 1; }
    const r = 5, dm = new Uint8Array(m.length);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) for (let yy = Math.max(0, y - r); yy <= Math.min(Hh - 1, y + r); yy++) dm.fill(1, yy * W + Math.max(0, x - r), yy * W + Math.min(W - 1, x + r) + 1);
    const lab = new Int32Array(dm.length); const out = []; let L = 0;
    const good = H.lines.filter(l => l.conf >= 80);
    for (let i = 0; i < dm.length; i++) if (dm[i] && !lab[i]) {
      L++; const st = [i]; lab[i] = L; let x0 = W, y0 = Hh, x1 = 0, y1 = 0, ink = 0;
      while (st.length) { const p = st.pop(); const px = p % W, py = (p / W) | 0; if (m[p]) ink++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= dm.length || lab[q] || !dm[q]) continue; if (Math.abs((q % W) - px) > 1) continue; lab[q] = L; st.push(q); } }
      const bw = x1 - x0, bh = y1 - y0; if (bw * bh < W * Hh * 0.002 || ink < 30 || bw < 12 || bh < 8) continue;
      const eM = W * 0.03; if (x0 <= eM || x1 >= W - eM || y0 <= eM || y1 >= Hh - eM) continue; // sticky notes / edges
      if (bw * bh > W * Hh * 0.35) continue; // coloured paper or big photo – handled elsewhere
      const box = { x0: x0 / s, y0: y0 / s, x1: x1 / s, y1: y1 / s };
      // coloured but well-read text (e.g. a red heading) stays text
      let tA = 0; for (const l of good) for (const w of l.words) { const ox = Math.min(box.x1, w.x1) - Math.max(box.x0, w.x0), oy = Math.min(box.y1, w.y1) - Math.max(box.y0, w.y0); if (ox > 0 && oy > 0) tA += ox * oy; }
      const logoZone = box.y0 < disp.height * 0.16 && (box.y1 - box.y0) > H.medH * 1.5;
      if (!logoZone && tA > (box.x1 - box.x0) * (box.y1 - box.y0) * 0.25) continue;
      const pad = 4 / s; out.push({ x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(disp.width, box.x1 + pad), y1: Math.min(disp.height, box.y1 + pad) });
    }
    return out;
  }

  /* remove table rules so the cell text can be read */
  function unrule(cv) {
    const W = cv.width, H = cv.height, x = ctx2(cv); const id = x.getImageData(0, 0, W, H); const d = id.data;
    const dark = i => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8 < 140;
    const rows = [], cols = [];
    for (let y = 0; y < H; y++) { let run = 0, best = 0; for (let xx = 0; xx < W; xx++) { if (dark((y * W + xx) * 4)) { run++; if (run > best) best = run; } else run = 0; } if (best > W * 0.5) rows.push(y); }
    for (let xx = 0; xx < W; xx++) { let run = 0, best = 0; for (let y = 0; y < H; y++) { if (dark((y * W + xx) * 4)) { run++; if (run > best) best = run; } else run = 0; } if (best > H * 0.5) cols.push(xx); }
    for (const y of rows) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
    for (const xx of cols) for (let y = 0; y < H; y++) { const i = (y * W + xx) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
    const o = cnv(W, H); ctx2(o).putImageData(id, 0, 0); return o;
  }
  function padTo(cv, aspect) {
    const a = cv.width / cv.height; if (Math.abs(a - aspect) < 0.01) return cv;
    const W = a > aspect ? cv.width : Math.round(cv.height * aspect), H = a > aspect ? Math.round(cv.width / aspect) : cv.height;
    const o = cnv(W, H); const x = ctx2(o); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(cv, Math.round((W - cv.width) / 2), Math.round((H - cv.height) / 2)); return o;
  }

  /* ================= full page pipeline for scanned / photo pages =================
     cv: colour canvas of the page; ptW/ptH: target page size in pt (null = derive from 150 dpi)
     returns array of page models (normally 1; 2 if split) */
  const tick = () => new Promise(r => setTimeout(r, 0));
  async function processScanned(cv, opts) {
    const langs = opts.langs; await tick();
    const tR = performance.now();
    const parts = repair(cv, { pageNo: opts.pageNo, photo: opts.photo, allowSplit: opts.allowSplit, targetW: opts.targetW, lowRes: opts.lowRes });
    T('repair', tR);
    if (parts.length > 1 && opts.ptW && opts.ptH) { opts = { ...opts }; const pw = opts.ptW, ph = opts.ptH; opts.ptW = Math.min(pw, ph) * 0.0 + (pw > ph ? ph * 0.707 : pw); opts.ptH = pw > ph ? ph : ph; }
    const out = [];
    for (const part of parts) {
      if (part.blank) { out.push({ kind: 'blank', n: opts.pageNo, display: part.display, items: [], lines: [], w: opts.ptW || 595, h: opts.ptH || 842 }); continue; }
      if (opts.ptH) { const pd = padTo(part.display, opts.ptW / opts.ptH); part.display = pd; part.ocrImg = pd; }
      await tick();
      const rd = await read(part, langs, { pageNo: opts.pageNo, wantPdf: opts.wantPdf, allowProbe: opts.allowProbe, photo: opts.photo });
      let disp = rd.display;
      let pW = opts.ptW, pH = opts.ptH;
      if (pH && (disp.width > disp.height) !== (pW > pH) && Math.abs(disp.width / disp.height - pW / pH) > 0.3) [pW, pH] = [pH, pW]; // page was turned 90°
      if (pH && Math.abs(disp.width / disp.height - pW / pH) > 0.02) {
        const before = disp; disp = padTo(disp, pW / pH);
        const dx = Math.round((disp.width - before.width) / 2), dy = Math.round((disp.height - before.height) / 2);
        rd.img = padTo(rd.img, pW / pH);
        for (const l of rd.H.lines) { l.bbox = { x0: l.bbox.x0 + dx, x1: l.bbox.x1 + dx, y0: l.bbox.y0 + dy, y1: l.bbox.y1 + dy }; for (const wd of l.words) { wd.x0 += dx; wd.x1 += dx; wd.y0 += dy; wd.y1 += dy; } }
      }
      const ptW = pW || 595.28, pxPerPt = disp.width / ptW, ptH = disp.height / pxPerPt;
      const items = toItems(rd.H, pxPerPt);
      const boxes = rd.H.lines.flatMap(l => l.words.map(w => ({ x0: w.x0, y0: l.bbox.y0, x1: w.x1, y1: l.bbox.y1 })));
      // logos: large coloured lettering near the top → keep as picture, not text
      const logoBoxes = findLogos(disp, rd.H);

      let regions = pictureRegions(disp, boxes.filter(bx => !logoBoxes.some(L => bx.x0 >= L.x0 && bx.x1 <= L.x1 && bx.y0 >= L.y0 && bx.y1 <= L.y1)));
      // second pass: ink the first reading skipped (boxed tables, framed text) – read it on its own with rules removed
      // join side-by-side pieces (table columns) into one area before re-reading
      regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i], b = regions[j]; if (!a || !b) continue;
        const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ov > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.6) { regions[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area }; regions[j] = null; j = i; }
      }
      regions = regions.filter(Boolean);
      if (regions.length && regions.length <= 12) {
        const keep = [];
        for (const r of regions) {
          if (r.area > 0.6) { keep.push(r); continue; }
          const pad = 8, x0 = Math.max(0, Math.round(r.x0 - pad)), y0 = Math.max(0, Math.round(r.y0 - pad)), w = Math.min(rd.img.width - x0, Math.round(r.x1 - r.x0 + 2 * pad)), h = Math.min(rd.img.height - y0, Math.round(r.y1 - r.y0 + 2 * pad));
          if (w < 30 || h < 20) { keep.push(r); continue; }
          const c = unrule(crop(rd.img, x0, y0, w, h));
          const H2 = harvest(await runOcr(c, langs, 6, false));
          if (H2.chars >= 6 && H2.meanConf >= 70 && H2.junkL <= H2.lines.length) {
            for (const l of H2.lines) { l.bbox = { x0: l.bbox.x0 + x0, x1: l.bbox.x1 + x0, y0: l.bbox.y0 + y0, y1: l.bbox.y1 + y0 }; for (const wd of l.words) { wd.x0 += x0; wd.x1 += x0; wd.y0 += y0; wd.y1 += y0; } rd.H.lines.push(l); }
            rd.H.chars += H2.chars; note('reread');
          } else keep.push(r);
        }
        if (keep.length !== regions.length) { regions = keep; items.length = 0; items.push(...toItems(rd.H, pxPerPt)); }
      }
      if (!opts.wantRegions) regions = [];
      if (opts.wantRegions) for (const L of logoBoxes) { regions = regions.filter(r => r.x1 < L.x0 || r.x0 > L.x1 || r.y1 < L.y0 || r.y0 > L.y1); regions.push({ ...L, area: (L.x1 - L.x0) * (L.y1 - L.y0) / (disp.width * disp.height), logo: true }); }
      const textArea = boxes.reduce((a, b) => a + (b.x1 - b.x0) * (b.y1 - b.y0), 0) / (disp.width * disp.height);
      const picArea = regions.filter(r => !r.logo).reduce((a, r) => a + r.area, 0);
      let kind = 'text';
      if (rd.H.chars < 60 && (part.ink || 0) > 0.003) kind = 'picture';
      else if ((part.ink || 0) > 0.06 && textArea < (part.ink || 0) * 0.25 && rd.H.chars < 400) kind = 'picture'; // ink is mostly not text (ECG, X-ray, photo)
      else if (picArea > 0.45 && textArea < picArea * 0.5) kind = 'picture';
      else if (rd.H.chars < 300 && picArea > 0.3) kind = 'picture';
      if (typeof window !== 'undefined' && window.__dbg) window.__dbg.push({ page: opts.pageNo, chars: rd.H.chars, conf: Math.round(rd.H.meanConf), raw: rd.H.rawConf, junkL: rd.H.junkL, textArea: +textArea.toFixed(3), picArea: +picArea.toFixed(3), regions: regions.map(r => [Math.round(r.x0), Math.round(r.y0), Math.round(r.x1), Math.round(r.y1), +r.area.toFixed(3)]), kind, ink: part.ink, blurry: part.blurry, angle: part.angle });
      if (kind === 'picture') { note('picture'); regions = []; }
      const images = regions.map(r => { const pad = 6; const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad), w = Math.min(disp.width - x0, r.x1 - r.x0 + 2 * pad), h = Math.min(disp.height - y0, r.y1 - r.y0 + 2 * pad); return { cv: crop(disp, x0, y0, w, h), x: x0 / pxPerPt, top: y0 / pxPerPt, w: w / pxPerPt, h: h / pxPerPt }; });
      // remove text items that sit inside picture regions (text inside logos/graphs)
      const inImg = it => images.some(im => it.x >= im.x - 2 && it.x + it.w <= im.x + im.w + 2 && it.top >= im.top - 2 && it.top + it.h <= im.top + im.h + 2);
      const inLogo = it => { const cx = (it.x + it.w / 2) * pxPerPt, cy = (it.top + it.h / 2) * pxPerPt; return logoBoxes.some(L => cx >= L.x0 && cx <= L.x1 && cy >= L.y0 && cy <= L.y1); };
      const items2 = kind === 'picture' ? [] : items.filter(it => !inImg(it) && !inLogo(it));
      if (images.length) note('images', images.length);
      // words the reader was unsure of → offered for review (with a small picture of the word)
      const uncertain = [];
      if (kind === 'text') for (const it of items2) {
        if (uncertain.length >= 40) break;
        if (it.conf >= 82 || it.conf < 40 || it.str.length < 2 || /^[\p{P}\p{S}]+$/u.test(it.str)) continue;
        const sw = it.src; if (!sw) continue;
        if (typeof Learn !== 'undefined' && Learn.fixWord(sw.t, 0).how === 'correction') continue; // already taught
        const pad = 6, cx = Math.max(0, sw.x0 - pad), cy = Math.max(0, sw.y0 - pad), cw = Math.min(rd.img.width - cx, sw.x1 - sw.x0 + 2 * pad), ch = Math.min(rd.img.height - cy, sw.y1 - sw.y0 + 2 * pad);
        if (cw < 6 || ch < 6) continue;
        const k = Math.min(1, 48 / ch); const c = scaled(crop(rd.img, cx, cy, cw, ch), cw * k, ch * k);
        uncertain.push({ item: it, orig: it.str, conf: Math.round(it.conf), img: c.toDataURL('image/jpeg', 0.8) });
      }
      for (const it of items2) delete it.src;
      if (typeof Learn !== 'undefined' && (R && R.flagged.has(opts.pageNo) || kind === 'picture' && rd.H.chars > 60))
        Learn.logProblem({ page: opts.pageNo, kind, conf: Math.round(rd.H.meanConf), chars: rd.H.chars, junkLines: rd.H.junkL, blurry: !!part.blurry, angle: part.angle || 0, ink: +(part.ink || 0).toFixed(3), textArea: +textArea.toFixed(3), picArea: +picArea.toFixed(3) });
      // laptop AI for hard pages (or all pages if chosen) – also teaches the on-device OCR
      let aiBlocks = null;
      if (kind === 'text' && opts.ai) {
        const hard = (R && R.flagged.has(opts.pageNo)) || rd.H.meanConf < 78 || rd.H.junkL > Math.max(3, rd.H.lines.length * 0.3);
        if (opts.ai.mode === 'all' || hard) {
          try {
            if (typeof prog === 'function') prog(`Page ${opts.pageNo}: reading with the laptop AI…`, null);
            const s = Math.min(1, 1600 / Math.max(disp.width, disp.height));
            const blob = await new Promise(r => scaled(disp, disp.width * s, disp.height * s).toBlob(r, 'image/jpeg', 0.9));
            const md = await opts.ai.vision(blob, (opts.langs || []).map(l => typeof langName === 'function' ? langName(l) : l).join(', '));
            if (md && md.replace(/\s/g, '').length > Math.min(40, rd.H.chars * 0.3)) {
              aiBlocks = mdToBlocks(md); note('ai');
              teach(md, uncertain);
              uncertain.length = 0;
            }
          } catch (e) { note('aiFail'); console.warn('laptop AI failed', e); }
        }
      }
      out.push({ sig: rd.sig, aiBlocks, uncertain, kind, n: opts.pageNo, w: ptW, h: ptH, display: disp, items: items2, images, ocr: true, conf: rd.H.meanConf, textPdf: rd.textPdf, ocrPx: { w: rd.img.width, h: rd.img.height } });
      note('ocr');
    }
    return out;
  }

  /* text PDF quality: is the embedded text garbage? */
  function garbled(items) {
    const s = items.map(i => i.str).join('');
    if (s.length < 20) return false;
    const bad = (s.match(/[-�\u0000-\u0008\u000E-\u001F]/g) || []).length;
    const letters = (s.match(/[\p{L}\p{N}]/gu) || []).length;
    if (bad > s.length * 0.08 || letters < s.replace(/\s/g, '').length * 0.45) return true;
    // Latin text with almost no vowels = wrong font encoding
    const latin = s.match(/[A-Za-z]/g) || [];
    if (latin.length > 80) { const v = (s.match(/[aeiouAEIOU]/g) || []).length; if (v < latin.length * 0.18) return true; }
    if (/\(cid:\d+\)/.test(s)) return true;
    return false;
  }

  /* ================= stage 5: layout ================= */
  function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
  /* two-column detection on items (pt). returns ordered line groups */
  function splitColumns(items, pageW) {
    if (items.length < 30) return null;
    const cover = new Float64Array(Math.ceil(pageW) + 1);
    for (const it of items) for (let x = Math.max(0, Math.floor(it.x)); x <= Math.min(pageW, Math.ceil(it.x + it.w)); x++) cover[x]++;
    let best = -1, bw = 0, run = 0, st = 0;
    for (let x = Math.round(pageW * 0.3); x < pageW * 0.7; x++) { if (cover[x] <= items.length * 0.01) { if (!run) st = x; run++; if (run > bw) { bw = run; best = st + run / 2; } } else run = 0; }
    if (bw < 8) return null;
    const left = items.filter(i => i.x + i.w <= best + 2), right = items.filter(i => i.x >= best - 2), cross = items.filter(i => i.x < best - 2 && i.x + i.w > best + 2);
    const avgLen = arr => arr.length ? arr.reduce((a, i) => a + i.w, 0) / arr.length : 0;
    const lineWidth = arr => { const L = buildLinesRaw(arr); return L.length ? L.reduce((a, l) => a + (l.right - l.x), 0) / L.length : 0; };
    if (left.length < 10 || right.length < 10) return null;
    if (lineWidth(left) < pageW * 0.22 || lineWidth(right) < pageW * 0.22) return null; // short cells → table, not columns
    void avgLen;
    // two-column mode only where both sides hold running text; tables/blocks above or below stay full width
    const longTop = arr => { const L = buildLinesRaw(arr).filter(l => l.right - l.x > pageW * 0.25); return L.length ? [Math.min(...L.map(l => l.top)), Math.max(...L.map(l => l.bottom))] : null; };
    const a = longTop(left), b = longTop(right); if (!a || !b) return null;
    const y0 = Math.max(a[0], b[0]) - 14, y1 = Math.min(a[1], b[1]) + 14;
    if (y1 - y0 < 60) return null;
    const inBand = i => i.top >= y0 && i.top + i.h <= y1;
    return { left: left.filter(inBand), right: right.filter(inBand), cross: [...cross, ...left.filter(i => !inBand(i)), ...right.filter(i => !inBand(i))], gutter: best };
  }
  function buildLinesRaw(items) {
    const its = items.filter(i => i.str.trim()).map(i => ({ ...i, cy: i.top + i.h / 2 })).sort((a, b) => a.cy - b.cy || a.x - b.x);
    const lines = [];
    for (const it of its) {
      let ln = null;
      for (let j = lines.length - 1; j >= 0 && j >= lines.length - 4; j--) { const L = lines[j]; if (Math.abs(L.cy - it.cy) < Math.min(L.size, it.size) * 0.55) { ln = L; break; } }
      if (!ln) { ln = { items: [], cy: it.cy, size: it.size }; lines.push(ln); }
      ln.items.push(it); ln.cy = ln.items.reduce((s, i) => s + i.cy, 0) / ln.items.length; ln.size = median(ln.items.map(i => i.size));
    }
    for (const L of lines) {
      L.items.sort((a, b) => a.x - b.x);
      L.top = Math.min(...L.items.map(i => i.top)); L.bottom = Math.max(...L.items.map(i => i.top + i.h));
      L.x = L.items[0].x; L.right = Math.max(...L.items.map(i => i.x + i.w));
      const cells = []; let cur = null;
      for (const it of L.items) {
        const gap = cur ? it.x - cur.x2 : Infinity; const big = Math.max(L.size * 1.6, 12);
        if (!cur || gap > big) { cur = { x: it.x, x2: it.x + it.w, text: it.str }; cells.push(cur); }
        else { const sp = gap > L.size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(it.str); cur.text += (sp ? ' ' : '') + it.str; cur.x2 = Math.max(cur.x2, it.x + it.w); }
      }
      for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?%)])/g, '$1').trim();
      L.cells = cells.filter(c => c.text);
      L.text = L.cells.map(c => c.text).join(L.cells.length > 1 ? '\t' : '');
      L.conf = L.items.some(i => i.conf != null) ? L.items.reduce((a, i) => a + (i.conf || 90), 0) / L.items.length : 100;
    }
    return lines.filter(L => L.cells.length).sort((a, b) => a.top - b.top);
  }
  function buildLines(items, pageW) {
    const cols = pageW ? splitColumns(items, pageW) : null;
    if (!cols) return buildLinesRaw(items);
    note('columns');
    const crossL = buildLinesRaw(cols.cross), leftL = buildLinesRaw(cols.left), rightL = buildLinesRaw(cols.right);
    // order: full-width lines split the page into bands; inside a band, left column then right column
    const out = []; const cuts = [...crossL.map(l => l.top), Infinity]; let prev = -Infinity;
    for (let i = 0; i < cuts.length; i++) {
      const band = l => l.top >= prev && l.top < cuts[i];
      out.push(...leftL.filter(band), ...rightL.filter(band));
      if (i < crossL.length) out.push(crossL[i]);
      prev = cuts[i];
    }
    return out;
  }

  /* repeated header/footer + page numbers across the document */
  const PAGE_NUM = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$|^[-–]\s*\d{1,4}\s*[-–]$|^\d{1,4}\s*\/\s*\d{1,4}$/i;
  const norm = t => t.toLowerCase().replace(/page\s*\d+\s*(of|\/)\s*\d+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  function headersFooters(pages) {
    const textPages = pages.filter(p => p.kind === 'text' && p.lines && p.lines.length);
    const cnt = {};
    for (const p of textPages) {
      const seen = new Set();
      for (const L of p.lines) { const zone = L.top < p.h * 0.07 ? 'H' : L.bottom > p.h * 0.93 ? 'F' : null; if (!zone) continue; const k = zone + norm(L.text); if (k.length < 5 || seen.has(k)) continue; seen.add(k); cnt[k] = (cnt[k] || 0) + 1; }
    }
    const need = Math.max(3, Math.ceil(textPages.length * 0.5));
    const rep = new Set(Object.keys(cnt).filter(k => cnt[k] >= need));
    let hf = 0, pn = 0; let headerText = null, footerText = null;
    for (const p of textPages) {
      let removed = false;
      p.lines = p.lines.filter(L => {
        const zone = L.top < p.h * 0.07 ? 'H' : L.bottom > p.h * 0.93 ? 'F' : null;
        if (zone && rep.has(zone + norm(L.text))) { if (zone === 'H' && !headerText) headerText = L.text.replace(/\t/g, '   '); if (zone === 'F' && !footerText) footerText = L.text.replace(/\t/g, '   '); removed = true; return false; }
        if (zone && PAGE_NUM.test(L.text.replace(/\t/g, ' ').trim())) { pn++; return false; }
        if (zone && L.cells.length > 1) { L.cells = L.cells.filter(c => !/^page\s*\d+\s*of\s*\d+$/i.test(c.text)); L.text = L.cells.map(c => c.text).join('\t'); if (!L.cells.length) return false; }
        return true;
      });
      if (removed) hf++;
    }
    if (hf) note('headerFooter', hf); if (pn) note('pageNums', pn);
    return { headerText, footerText };
  }

  /* horizontal ruling lines from the page image (pt units) */
  function rulings(display, pxPerPt) {
    if (!display) return [];
    const P = probe(display, 800); const s = P.s; const ys = [];
    for (let y = 0; y < P.h; y++) { let run = 0, best = 0, bx = 0; for (let x = 0; x < P.w; x++) { if (P.b[y * P.w + x]) { run++; if (run > best) { best = run; bx = x - run + 1; } } else run = 0; } if (best > P.w * 0.25) ys.push({ y: y / s / pxPerPt, x0: bx / s / pxPerPt, x1: (bx + best) / s / pxPerPt }); }
    const merged = []; for (const r of ys) { const l = merged[merged.length - 1]; if (l && r.y - l.y < 2) continue; merged.push(r); }
    return merged;
  }

  function columnsOf(lines) {
    const spans = []; for (const L of lines) if (L.cells.length > 1) for (const c of L.cells) spans.push([c.x, c.x2]);
    if (!spans.length) return []; spans.sort((a, b) => a[0] - b[0]);
    const cols = []; for (const s of spans) { const last = cols[cols.length - 1]; if (last && s[0] <= last[1] + 2) last[1] = Math.max(last[1], s[1]); else cols.push([s[0], s[1]]); }
    return cols;
  }
  function colIndex(cols, c) { let best = 0, bo = -Infinity; cols.forEach((k, i) => { const ov = Math.min(k[1], c.x2) - Math.max(k[0], c.x); const d = ov > 0 ? ov : -Math.min(Math.abs(c.x - k[0]), Math.abs(c.x - k[1])); if (d > bo) { bo = d; best = i; } }); return best; }
  function grid(lines) {
    const cols = columnsOf(lines);
    const rows = lines.map(L => { if (!cols.length) return [L.text.replace(/\t/g, ' ')]; const row = new Array(cols.length).fill(''); for (const c of L.cells) { const i = colIndex(cols, c); row[i] = row[i] ? row[i] + ' ' + c.text : c.text; } return row; });
    return { rows, cols };
  }
  /* decide whether a run of lines is a real table */
  function tableCheck(run, rules) {
    if (run.length < 2) return null;
    const { rows, cols } = grid(run);
    const nc = cols.length; if (nc < 2) return null;
    const fill = cols.map((_, k) => rows.filter(r => r[k]).length / rows.length);
    const ruled = rules.filter(r => r.y >= run[0].top - 6 && r.y <= run[run.length - 1].bottom + 6).length;
    const junkCol = cols.some((_, k) => rows.every(r => !r[k] || r[k].length <= 2));
    if (junkCol) return { fake: true };
    const multiRows = run.filter(l => l.cells.length >= 2).length;
    if (ruled >= Math.max(2, multiRows - 1) && multiRows >= 2 && fill.every(f => f >= 0.3) && (nc >= 3 || ruled >= multiRows)) return { rows, cols };
    if (nc >= 3 && multiRows >= 3 && fill.filter(f => f >= 0.5).length >= Math.min(3, nc)) return { rows, cols };
    return null; // 2 columns without rules → label/value lines, not a table
  }

  const LABEL = /^([\p{Lu}][\p{L}\p{N} .\/&()'’-]{1,38}?)\s*[:：]\s*/u;
  const NUM_ITEM = /^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+/i;
  const BULLET = /^([•·▪●◦○■□➢►✓✔*\-–—»«°]|[eo](?=\s+\p{Lu}))\s+/u;
  /* blocks for one page: p (paragraph), table, image */
  function layout(pm, ctx = {}) {
    const lines = pm.lines || [];
    const blocks = [];
    if (pm.kind === 'picture' || pm.kind === 'blank') return blocks;
    if (pm.aiBlocks) {
      const ims = (pm.images || []).map(im => ({ type: 'image', ...im }));
      return [...ims.filter(i => i.top < pm.h * 0.3), ...pm.aiBlocks.map(b => ({ ...b })), ...ims.filter(i => i.top >= pm.h * 0.3)];
    }
    const sizes = lines.flatMap(L => L.items.map(() => L.size));
    const body = median(sizes) || 11;
    const left = lines.length ? median(lines.map(L => L.x)) : 0;
    const rs = lines.map(L => L.right).sort((a, b) => a - b); const textRight = rs.length ? rs[Math.floor(rs.length * 0.9)] : pm.w;
    const rules = pm.rules || [];
    let i = 0;
    while (i < lines.length) {
      // table candidate
      let j = i;
      while (j < lines.length && (lines[j].cells.length >= 2 || (j > i && lines[j].cells.length === 1 && lines[j].top - lines[j - 1].bottom < lines[j].size * 1.6 && lines[j].text.length < 90 && !LABEL.test(lines[j].text)))) j++;
      while (j > i && lines[j - 1].cells.length < 2) {
        const Lc = lines[j - 1], Lp = lines[j - 2], nx = lines[j];
        const cont = Lp && Lc.top - Lp.bottom < Lc.size * 0.9 && Lc.size <= Lp.size * 1.05 && (!nx || nx.top - Lc.bottom > Lc.size * 1.1) && Lc.text.length < 70;
        if (cont && j - 1 > i && lines.slice(i, j - 1).some(l => l.cells.length >= 2)) break;
        j--;
      }
      if (j - i >= 2) {
        const tc = tableCheck(lines.slice(i, j), rules);
        if (tc && !tc.fake) {
          // fold wrapped single-cell continuation lines into the row above
          const rows = []; const { cols } = tc;
          for (const L of lines.slice(i, j)) {
            if (L.cells.length === 1 && rows.length) { const k = colIndex(cols, L.cells[0]); const r = rows[rows.length - 1]; r[k] = r[k] ? r[k] + ' ' + L.cells[0].text : L.cells[0].text; continue; }
            const row = new Array(cols.length).fill(''); for (const c of L.cells) { const k = colIndex(cols, c); row[k] = row[k] ? row[k] + ' ' + c.text : c.text; } rows.push(row);
          }
          blocks.push({ type: 'table', rows, top: lines[i].top, colX: cols.map(c => c[0]) }); note('tables'); i = j; continue;
        }
        if (tc && tc.fake) { note('fakeTables'); for (let k = i; k < j; k++) { const L = lines[k]; const cs = L.cells.filter(c => c.text.length > 2 || /\w{2}/.test(c.text)); if (cs.length) { L.cells = cs; L.text = cs.map(c => c.text).join('\t'); } } }
      }
      const L = lines[i];
      const prev = blocks[blocks.length - 1], prevLine = i > 0 ? lines[i - 1] : null;
      const text = L.cells.map(c => c.text).join(' ');
      const ratio = L.size / body;
      const caps = text.length > 3 && text.length < 70 && text === text.toUpperCase() && /\p{Lu}{3}/u.test(text);
      let head = 0;
      const headOk = text.length >= 3 && text.length <= 70 && L.conf >= 80 && !NUM_ITEM.test(text) && !BULLET.test(text) && L.cells.length === 1 && !/[,;]\s.*[,;]/.test(text);
      const hr = pm.ocr ? 1.5 : 1.3;
      if (headOk && ratio >= 1.9) head = 1; else if (headOk && ratio >= hr) head = 2;
      const isNum = NUM_ITEM.test(text), isBul = !isNum && BULLET.test(text);
      const multi = L.cells.length >= 2;
      const joinable = prev && prev.type === 'p' && prevLine && !prev.head && !head && !prev.multi && !multi && !isNum && !isBul &&
        (L.top - prevLine.bottom) < Math.max(L.size, prevLine.size) * 0.75 && Math.abs(ratio - prev.size / body) < 0.2 &&
        prevLine.right > textRight * 0.78 && !LABEL.test(text) && !/:$/.test(prev.text) &&
        Math.abs(L.x - prevLine.x) < body * 3;
      if (joinable) {
        prev.text = /[-‐]$/.test(prev.text) && /^\p{Ll}/u.test(text) ? prev.text.slice(0, -1) + text : prev.text + ' ' + text; prev.nlines++; prev.right = Math.max(prev.right, L.right);
      } else {
        const b = { type: 'p', text, size: L.size, head, caps, x: L.x, right: L.right, top: L.top, nlines: 1, multi, cells: multi ? L.cells.map(c => ({ x: c.x, text: c.text })) : null };
        if (isNum) { b.list = 'num'; note('lists'); }
        if (isBul) { b.list = 'bullet'; b.text = text.replace(BULLET, ''); note('lists'); }
        b.indent = Math.max(0, L.x - left);
        blocks.push(b);
      }
      i++;
    }
    for (const b of blocks) if (b.type === 'p') {
      const cx = (b.x + b.right) / 2;
      b.center = b.nlines === 1 && !b.multi && Math.abs(cx - pm.w / 2) < pm.w * 0.05 && (b.right - b.x) < pm.w * 0.6 && b.x > pm.w * 0.2;
      const m = !b.head && b.text.match(LABEL); if (m && m[0].length < b.text.length) b.label = m[0].length; else if (!b.head && /:$/.test(b.text) && b.text.length < 60) b.label = b.text.length;
    }
    // images in reading order
    for (const im of (pm.images || [])) blocks.push({ type: 'image', ...im });
    blocks.sort((a, b) => (a.top || 0) - (b.top || 0));
    return blocks;
  }

  /* ================= self-check: rebuilt text or faithful layout? =================
     Looks at what a rebuilt (flowing) page would lose and picks the mode per page. */
  function chooseMode(pm) {
    const disp = pm.display;
    if (!disp || pm.kind !== 'text') { pm.mode = 'flow'; return pm.mode; }
    const k = disp.width / pm.w; const L = pm.lines || []; const n = L.length;
    const multi = n ? L.filter(l => l.cells.length >= 2).length / n : 0;
    const rs = L.map(l => l.right).sort((a, b) => a - b), tr = rs.length ? rs[Math.floor(rs.length * 0.9)] : pm.w, tl = n ? median(L.map(l => l.x)) : 0;
    const longFrac = n ? L.filter(l => (l.right - l.x) > (tr - tl) * 0.55).length / n : 0;
    const toks = L.flatMap(l => l.items.map(i => i.str)); const numeric = toks.length ? toks.filter(t => /\d/.test(t)).length / toks.length : 0;
    // ink that a rebuilt page would drop (boxes, stamps, handwriting, logos not kept as pictures)
    const P = probe(disp, 600); const W = P.w, H = P.h, m = P.b.slice(), s = P.s;
    let total = 0; for (let i = 0; i < m.length; i++) total += m[i];
    for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x <= W; x++) { if (x < W && m[y * W + x]) run++; else { if (run > W * 0.15) for (let q = x - run; q < x; q++) m[y * W + q] = 0; run = 0; } } }
    const clear = (x0, y0, x1, y1, pad) => { const a = Math.max(0, Math.floor(x0 * s) - pad), b = Math.min(W - 1, Math.ceil(x1 * s) + pad), c = Math.max(0, Math.floor(y0 * s) - pad), d = Math.min(H - 1, Math.ceil(y1 * s) + pad); for (let y = c; y <= d; y++) m.fill(0, y * W + a, y * W + b + 1); };
    for (const it of pm.items || []) clear(it.x * k, it.top * k, (it.x + it.w) * k, (it.top + it.h) * k, 2);
    for (const im of pm.images || []) clear(im.x * k, im.top * k, (im.x + im.w) * k, (im.top + im.h) * k, 1);
    let left = 0; for (let i = 0; i < m.length; i++) left += m[i];
    const lost = total ? left / total : 0;
    const rules = (pm.rules || []).length;
    const why = [];
    if (rules >= 4) why.push('ruled boxes'); if (multi > 0.3) why.push('columns of values'); if (lost > 0.2) why.push('stamps/handwriting/marks');
    if (numeric > 0.3) why.push('mostly numbers'); if (n < 6) why.push('few lines'); if (longFrac < 0.35) why.push('short fields');
    if (!why.length) { const s2 = fitScale(layout(pm), pm, pm.w - 72, pm.h - 72); if (s2 < 0.8) why.push('too much text to reflow'); }
    pm.mode = why.length ? 'faithful' : 'flow'; pm.modeWhy = why;
    note(pm.mode === 'faithful' ? 'faithful' : 'flowPages');
    if (typeof Learn !== 'undefined' && pm.sig) Learn.rememberLayout(pm.sig, { mode: pm.mode });
    if (pm.mode === 'faithful') prepareFaithful(pm);
    return pm.mode;
  }
  /* background with the recognised text erased + the colour of each word */
  function prepareFaithful(pm) {
    const disp = pm.display; const scale = Math.min(1, 1800 / disp.width);
    const bg = scaled(disp, disp.width * scale, disp.height * scale); const x = ctx2(bg);
    const id = x.getImageData(0, 0, bg.width, bg.height); const d = id.data; const W = bg.width, H = bg.height;
    const k = bg.width / pm.w;
    const lum = i => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    for (const it of pm.items || []) {
      const x0 = Math.max(0, Math.floor(it.x * k) - 2), y0 = Math.max(0, Math.floor(it.top * k) - 2), x1 = Math.min(W - 1, Math.ceil((it.x + it.w) * k) + 2), y1 = Math.min(H - 1, Math.ceil((it.top + it.h) * k) + 2);
      if (x1 <= x0 || y1 <= y0) continue;
      // ring around the word = paper colour there
      const ring = [[], [], []]; const R = 4;
      for (let y = Math.max(0, y0 - R); y <= Math.min(H - 1, y1 + R); y++) for (let xx = Math.max(0, x0 - R); xx <= Math.min(W - 1, x1 + R); xx++) {
        if (y >= y0 && y <= y1 && xx >= x0 && xx <= x1) continue; const i = (y * W + xx) * 4; ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
      }
      const bgc = ring.map(a => { a.sort((p, q) => p - q); return a[Math.floor(a.length * 0.7)] || 255; });
      // ink colour inside the word
      let n = 0, sr = 0, sg = 0, sb = 0; const bl = bgc[0] * 0.3 + bgc[1] * 0.59 + bgc[2] * 0.11;
      for (let y = y0; y <= y1; y++) for (let xx = x0; xx <= x1; xx++) { const i = (y * W + xx) * 4; if (lum(i) < bl - 70) { n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; } }
      it.color = n > 4 ? [sr / n, sg / n, sb / n].map(v => Math.max(0, Math.min(255, Math.round(v * 0.8)))).map(v => v.toString(16).padStart(2, '0')).join('') : '1a1a1a';
      for (let y = y0; y <= y1; y++) for (let xx = x0; xx <= x1; xx++) { const i = (y * W + xx) * 4; d[i] = bgc[0]; d[i + 1] = bgc[1]; d[i + 2] = bgc[2]; }
    }
    x.putImageData(id, 0, 0);
    pm.bg = bg;
    // keep word colours on the line items too (lines are rebuilt from items)
    pm.lines = buildLines(pm.items, pm.w);
  }

  /* estimate if a page's content fits; returns a font scale (<=1) */
  function bodySize(pm) { const sz = (pm.lines || []).flatMap(L => L.items.map(() => L.size)); const m = median(sz) || 11; return Math.max(8, Math.min(13, Math.round(m * 2) / 2)); }
  function fitScale(blocks, pm, contentW, contentH) {
    const base = bodySize(pm);
    const est = s => {
      let h = 0;
      for (const b of blocks) {
        if (b.type === 'image') { const w = Math.min(contentW, b.w) * s; h += b.h * (w / b.w) + 4; continue; }
        if (b.type === 'table') { const tf = base * 0.92 * s; h += b.rows.reduce((a, r) => a + Math.max(1, ...r.map(c => Math.ceil(c.length * tf * 0.55 / Math.max(30, contentW / r.length - 8)))) * tf * 1.25 + 6, 0) + 8; continue; }
        const fs = (b.head === 1 ? base * 1.45 : b.head === 2 ? base * 1.18 : base) * s; const lines = Math.max(1, Math.ceil(b.text.length * fs * 0.52 / (contentW - (b.indent > 14 ? Math.min(b.indent, 200) : 0))));
        h += lines * fs * 1.25 + 5 * s + (b.head ? 6 * s : 0);
      }
      return h;
    };
    let s = 1; while (s > 0.55 && est(s) * 1.1 > contentH) s -= 0.03;
    if (s < 1) note('fit');
    return s;
  }

  return { chooseMode, prepareFaithful, POOL_N, mdToBlocks, bodySize, resetReport, reportLines, flaggedPages, note, flag, repair, read, processScanned, garbled, buildLines, layout, headersFooters, rulings, fitScale, grid, pictureRegions, toItems, setDocLangs: l => { docLangs = l; }, worker };
})();
