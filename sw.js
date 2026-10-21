const CACHE = 'plantoes-v1.20';
// Versionamento: v1.0, v1.01, v1.02 ... → grandes reformulações = v2.0, v3.0 ...
const ASSETS = ['./','./index.html','./css/app.css','./js/app.js','./js/sw-register.js',
  './fonts/inter.woff2','./fonts/geist.woff2',
  './manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png',
  './icons/maskable-192.png','./icons/maskable-512.png','./icons/badge-96.png','./icons/monochrome-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// tocar no aviso abre o app no próprio plantão (traz para frente se já estiver aberto)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const url = d.url || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { if (d.sid) c.postMessage({ tipo: 'abrir-plantao', sid: d.sid }); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

// pronto para push de servidor (Web Push) — usado quando houver backend de avisos
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Plantaê!', {
    body: d.body || '', tag: d.tag, icon: './icon-192.png', badge: './icons/badge-96.png', vibrate: [120, 60, 120], data: { url: d.url || './', sid: d.sid }
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Código (HTML, CSS, JS) pela rede primeiro: toda atualização chega sozinha.
// Ícones, fontes e manifest pelo cache primeiro, por velocidade. Offline cai no cache em ambos.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;

  const ehCodigo = req.mode === 'navigate' || req.destination === 'script' || req.destination === 'style'
    || (req.headers.get('accept') || '').includes('text/html');

  if (ehCodigo) {
    e.respondWith(
      fetch(req).then(resp => {
        const copia = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copia));
        return resp;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      const copia = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copia));
      return resp;
    }))
  );
});
