/* DocConvert offline cache. Language data is cached by the OCR engine itself. */
const CACHE = 'docconvert-v5';
const CORE = ['./', 'index.html', 'app.js', 'engine.js', 'learn.js', 'sync.js', 'config.js', 'langs.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/tessdata/')) return;
  const isCode = /\/(index\.html|app\.js|engine\.js|learn\.js|sync\.js|config\.js|langs\.js)?$/.test(u.pathname) || u.pathname.endsWith('/');
  if (isCode) { // network first for app code so updates arrive, cache as fallback offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  } else { // libraries: cache first
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); } return r; })));
  }
});
