/* DocConvert sharing between your devices.
   Drive: learning kept in the hidden app folder of YOUR Google Drive (scope drive.appdata – the app cannot see your other files).
   Helper: your laptop on your own private network (Tailscale) – shares learning and lends its AI and processing power. */
'use strict';
const Sync = (() => {
  const cfg = {
    get(k, d) { try { const v = localStorage.getItem('dc_sync_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dc_sync_' + k, JSON.stringify(v)); } catch (e) { } }
  };
  const FILE = 'docconvert-learning.json';

  /* ================= Google Drive ================= */
  const Drive = (() => {
    let token = null, expires = 0, tokenClient = null;
    try { const t = JSON.parse(sessionStorage.getItem('dc_gtoken') || 'null'); if (t && t.e > Date.now() + 60000) { token = t.t; expires = t.e; } } catch (e) { }
    const clientId = () => (cfg.get('clientId', '') || (window.DC_CONFIG && DC_CONFIG.googleClientId) || '').trim();
    const linked = () => cfg.get('driveLinked', false);
    const hasToken = () => token && Date.now() < expires - 60000;
    async function gis() {
      if (window.google && google.accounts && google.accounts.oauth2) return;
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => rej(new Error('Could not reach Google sign-in. Check the internet connection.')); document.head.appendChild(s); });
    }
    /* must be called from a tap (it may open Google's sign-in window) */
    async function signIn() {
      if (!clientId()) throw new Error('Add the Google Client ID first (see the setup guide).');
      await gis();
      return new Promise((res, rej) => {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId(), scope: 'https://www.googleapis.com/auth/drive.appdata',
          callback: r => {
            if (r.error) return rej(new Error('Google sign-in: ' + r.error));
            token = r.access_token; expires = Date.now() + (r.expires_in || 3600) * 1000;
            try { sessionStorage.setItem('dc_gtoken', JSON.stringify({ t: token, e: expires })); } catch (e) { }
            cfg.set('driveLinked', true); res(true);
          },
          error_callback: e => rej(new Error('Google sign-in was closed or blocked' + (e && e.type ? ' (' + e.type + ')' : '') + '.'))
        });
        tokenClient.requestAccessToken({ prompt: linked() ? '' : 'consent' });
      });
    }
    async function api(url, opt = {}) {
      const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = null; throw new Error('Google sign-in expired – tap Sync now.'); }
      if (!r.ok) throw new Error('Google Drive error ' + r.status + ': ' + (await r.text()).slice(0, 200));
      return r;
    }
    async function fileId() {
      const q = encodeURIComponent(`name='${FILE}'`);
      const r = await (await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`)).json();
      return r.files && r.files[0] ? r.files[0].id : null;
    }
    const backend = {
      async get() { const id = await fileId(); if (!id) return null; return (await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).text(); },
      async put(json) {
        const id = await fileId();
        if (id) return api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json });
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ name: FILE, parents: ['appDataFolder'] })], { type: 'application/json' }));
        fd.append('file', new Blob([json], { type: 'application/json' }));
        return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: fd });
      }
    };
    function signOut() { token = null; expires = 0; cfg.set('driveLinked', false); try { sessionStorage.removeItem('dc_gtoken'); } catch (e) { } }
    return { clientId, linked, hasToken, signIn, signOut, backend };
  })();

  /* ================= Laptop helper ================= */
  const Helper = (() => {
    const url = () => (cfg.get('helperUrl', '') || '').trim().replace(/\/+$/, '');
    const key = () => (cfg.get('helperKey', '') || '').trim();
    let alive = null, aliveAt = 0, info = null;
    async function call(path, opt = {}, timeout = 15000) {
      if (!url()) throw new Error('No laptop helper set.');
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url() + path, { ...opt, signal: ctl.signal, headers: { ...(opt.headers || {}), 'X-DocConvert-Key': key() } });
        if (r.status === 403) throw new Error('The laptop helper refused the key – copy it again from the helper window.');
        if (!r.ok) throw new Error('Laptop helper error ' + r.status + ': ' + (await r.text()).slice(0, 200));
        return r;
      } catch (e) { if (e.name === 'AbortError') throw new Error('The laptop helper did not answer in time.'); throw e; }
      finally { clearTimeout(tm); }
    }
    /* quick reachability check, cached for 1 minute */
    async function available(force) {
      if (!url()) return false;
      if (!force && alive !== null && Date.now() - aliveAt < 60000) return alive;
      try { info = await (await call('/ping', {}, 4000)).json(); alive = !!info.ok; }
      catch (e) { alive = false; info = { error: e.message }; }
      aliveAt = Date.now(); return alive;
    }
    const backend = {
      async get() { const r = await call('/learning'); const t = await r.text(); return t && t !== 'null' ? t : null; },
      async put(json) { return call('/learning', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json }, 60000); }
    };
    /* read one page image with the laptop's vision AI → markdown */
    async function vision(jpegBlob, hint) {
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(jpegBlob); });
      const r = await call('/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: b64, hint: hint || '' }) }, 300000);
      return (await r.json()).markdown || '';
    }
    const mode = () => cfg.get('aiMode', 'hard'); // 'off' | 'hard' | 'all'
    return { url, key, call, available, info: () => info, backend, vision, mode };
  })();

  /* ================= sync everything that is set up ================= */
  let busy = false;
  async function syncAll({ interactive = false } = {}) {
    if (busy) return []; busy = true; const done = [];
    try {
      if (Drive.clientId() && (Drive.hasToken() || (interactive && Drive.linked()))) {
        if (!Drive.hasToken()) await Drive.signIn();
        await Learn.syncWith(Drive.backend); done.push('Google Drive');
      }
      if (Helper.url() && await Helper.available()) { await Learn.syncWith(Helper.backend); done.push('laptop'); }
      if (done.length) cfg.set('lastSync', Date.now());
    } finally { busy = false; }
    return done;
  }
  return { cfg, Drive, Helper, syncAll, lastSync: () => cfg.get('lastSync', 0) };
})();
