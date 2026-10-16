const CACHE = 'plantoes-v1.16';
// Versionamento: v1.0, v1.01, v1.02 ... → grandes reformulações = v2.0, v3.0 ...
const ASSETS = ['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// tocar no aviso abre (ou traz para frente) o app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow(url);
    })
  );
});

// pronto para push de servidor (Web Push) — usado quando houver backend de avisos
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Plantaê!', {
    body: d.body || '', tag: d.tag, icon: './icon-192.png', badge: './icon-192.png', data: { url: d.url || './' }
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML pela rede primeiro: assim toda atualizacao chega sozinha, sem trocar este arquivo.
// Icones e manifest pelo cache primeiro, por velocidade. Offline cai no cache em ambos.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;

  const ehHtml = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (ehHtml) {
    e.respondWith(
      fetch(req).then(resp => {
        const copia = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copia));
        return resp;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
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
