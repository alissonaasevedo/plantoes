const CACHE = 'plantoes-v1.28';
const ESTADO = 'plantoes-estado';                 // espelho da agenda de avisos (não é apagado nas atualizações)
// Versionamento: v1.0, v1.01, v1.02 ... → grandes reformulações = v2.0, v3.0 ...
const ASSETS = ['./','./index.html','./css/app.css','./js/app.js','./js/conta.js','./js/sw-register.js',
  './fonts/inter.woff2','./fonts/geist.woff2',
  './manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png',
  './icons/maskable-192.png','./icons/maskable-512.png','./icons/badge-96.png','./icons/monochrome-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // mesma renovação do segundo plano, sob demanda (diagnóstico e testes)
  if (e.data && e.data.type === 'renovar-avisos')
    e.waitUntil(renovarAvisos().catch(err => 'erro').then(r => e.source && e.source.postMessage({ tipo: 'renovacao', r })));
});

// tocar no aviso abre o app no próprio plantão; um botão do aviso (Como chegar, Anotar,
// Recebi) abre o endereço daquela ação. Com o app já aberto, só traz para frente e avisa.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const botao = e.action ? (d.acoes || []).find(a => a.acao === e.action) : null;
  const url = (botao && botao.url) || d.url || './';
  if (/^https:\/\//.test(url)) { e.waitUntil(self.clients.openWindow(url)); return; }   // rota no Google Maps
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.postMessage({ tipo: 'abrir-url', url }); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

// avisos enviados pelo servidor (Web Push): chegam com o app fechado
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  const acoes = Array.isArray(d.acoes) ? d.acoes.slice(0, 2) : [];
  e.waitUntil(self.registration.showNotification(d.title || 'Plantaê!', {
    body: d.body || '', tag: d.tag, icon: './icon-192.png', badge: './icons/badge-96.png', vibrate: [120, 60, 120],
    actions: acoes.map(a => ({ action: a.acao, title: a.titulo })),
    data: { url: d.url || './', sid: d.sid, acoes }
  }));
});

/* Renovação dos avisos em segundo plano (Periodic Background Sync, Chrome no Android com o
   app instalado): o app deixa no Cache Storage a agenda dos próximos 35 dias; aqui o SW
   reagenda no servidor a janela dos próximos 6,5 dias sem o app estar aberto.          */
const ESPELHO = new URL('./__estado/avisos.json', self.location.href).href;
const PUSH_HORIZONTE = 6.5 * 86400000, PUSH_RESYNC = 20 * 3600000;
function hashTxt(t){ let h = 2166136261; for(let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
async function renovarAvisos(){
  const cache = await caches.open(ESTADO);
  const r = await cache.match(ESPELHO); if (!r) return 'sem-espelho';
  const esp = await r.json();
  let sub = null;
  try { const s = await self.registration.pushManager.getSubscription(); if (s) sub = s.toJSON(); } catch (err) {}
  sub = sub || esp.sub;
  if (!sub || !sub.endpoint) return 'sem-assinatura';
  const agora = Date.now();
  const avisos = (esp.avisos || []).filter(a => a.at > agora + 20000 && a.at <= agora + PUSH_HORIZONTE).slice(0, 40);
  const hash = hashTxt(sub.endpoint + JSON.stringify(avisos.map(a => [a.at, a.tag, a.title, a.body])));
  const est = esp.estado || {};
  if (est.hash === hash && agora - (est.em || 0) < PUSH_RESYNC) return 'em-dia';
  const resp = await fetch('./api/agendar', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, cancelar: est.ids || [], avisos }) });
  if (!resp.ok) return 'falhou';
  const d = await resp.json();
  esp.estado = { hash, em: agora, ids: (d.ids || []).filter(Boolean), n: avisos.length };
  await cache.put(ESPELHO, new Response(JSON.stringify(esp), { headers: { 'content-type': 'application/json' } }));
  return 'renovado';
}
self.addEventListener('periodicsync', e => { if (e.tag === 'avisos') e.waitUntil(renovarAvisos().catch(() => {})); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== ESTADO).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Código (HTML, CSS, JS) pela rede primeiro: toda atualização chega sozinha. Com internet
// ruim (plantão, sinal fraco) espera no máximo REDE_MS e abre com a cópia guardada — a versão
// nova continua baixando em segundo plano e vale na próxima abertura.
// Ícones, fontes e manifest pelo cache primeiro, por velocidade. /api/ nunca passa pelo cache.
const REDE_MS = 3000;

function guardar(req, resp){
  if(!resp || !resp.ok || resp.type !== 'basic') return;     // não guarda erro (404/500) por cima da cópia boa
  const copia = resp.clone();
  caches.open(CACHE).then(c => c.put(req, copia));
}

function daCopia(req){
  return caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
}

function redePrimeiro(e){
  const req = e.request;
  const rede = fetch(req).then(resp => { guardar(req, resp); return resp; });
  e.waitUntil(rede.then(() => {}, () => {}));                // termina de baixar e guardar mesmo se a cópia já respondeu
  return new Promise(resolve => {
    let pronto = false;
    const responder = r => { if(!pronto && r){ pronto = true; resolve(r); return true; } return false; };
    const espera = setTimeout(() => daCopia(req).then(responder), REDE_MS);
    rede.then(resp => { clearTimeout(espera); responder(resp); })
      .catch(() => { clearTimeout(espera); daCopia(req).then(hit => { if(!responder(hit)) responder(Response.error()); }); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;             // respostas do servidor de avisos: sempre ao vivo

  const ehCodigo = req.mode === 'navigate' || req.destination === 'script' || req.destination === 'style'
    || (req.headers.get('accept') || '').includes('text/html');

  if (ehCodigo) { e.respondWith(redePrimeiro(e)); return; }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => { guardar(req, resp); return resp; }))
  );
});
