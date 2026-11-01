// Service worker rodando num ambiente simulado: botões dos avisos e renovação em segundo plano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FONTE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGEM = 'https://plantoes.test';

function montar({ clientes = [], agendar } = {}) {
  const h = {}, abertas = [], mostradas = [], postados = [];
  const caixas = new Map();
  const caches = {
    async open(nome) {
      if (!caixas.has(nome)) caixas.set(nome, new Map());
      const m = caixas.get(nome);
      return { async match(u) { const v = m.get(String(u)); return v ? new Response(v) : undefined; },
               async put(u, r) { m.set(String(u), await r.text()); }, async addAll() {} };
    },
    async keys() { return [...caixas.keys()]; }, async delete(k) { return caixas.delete(k); }, async match() {},
  };
  const self = {
    location: new URL(ORIGEM + '/sw.js'),
    addEventListener: (t, fn) => { h[t] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (t, o) => mostradas.push([t, o]), pushManager: { getSubscription: async () => null } },
    clients: { matchAll: async () => clientes.map(c => ({ ...c, focus: async () => c, postMessage: m => postados.push(m) })), openWindow: async u => abertas.push(u), claim() {} },
  };
  const fetch = async (url, init) => {
    if (String(url).includes('/api/agendar')) return agendar(JSON.parse(init.body));
    throw new Error('rede não simulada: ' + url);
  };
  vm.runInNewContext(FONTE, { self, caches, fetch, URL, Response, location: self.location, console, Date, Math, JSON, Promise, setTimeout, clearTimeout });
  async function disparar(tipo, ev) {
    const esperas = [];
    h[tipo]({ ...ev, waitUntil: p => esperas.push(p) });
    await Promise.all(esperas);
  }
  return { h, abertas, mostradas, postados, caches, disparar };
}
const notif = (data, action = '') => ({ action, notification: { close() {}, data } });
const ACOES = [{ acao: 'recebi', titulo: 'Recebi', url: './?action=recebi&ids=A,B' }, { acao: 'rota', titulo: 'Como chegar', url: 'https://www.google.com/maps/search/?api=1&query=UPA' }];

test('botão Como chegar abre o Google Maps direto', async () => {
  const sw = montar();
  await sw.disparar('notificationclick', notif({ url: './?action=plantao&id=A', acoes: ACOES }, 'rota'));
  assert.deepEqual(sw.abertas, [ACOES[1].url]);
});

test('botão Recebi com o app aberto: traz para frente e manda a ação', async () => {
  const sw = montar({ clientes: [{ url: ORIGEM + '/index.html' }] });
  await sw.disparar('notificationclick', notif({ url: './?action=plantao&id=A', acoes: ACOES }, 'recebi'));
  assert.equal(JSON.stringify(sw.postados), JSON.stringify([{ tipo: 'abrir-url', url: './?action=recebi&ids=A,B' }]));
  assert.equal(sw.abertas.length, 0);
});

test('tocar no aviso (sem botão) com o app fechado abre o plantão', async () => {
  const sw = montar();
  await sw.disparar('notificationclick', notif({ url: './?action=plantao&id=A', acoes: ACOES }));
  assert.deepEqual(sw.abertas, ['./?action=plantao&id=A']);
});

test('aviso do servidor chega com os botões', async () => {
  const sw = montar();
  await sw.disparar('push', { data: { json: () => ({ title: 'Pagamento previsto hoje', body: 'x', tag: 'pag:1', url: './', acoes: ACOES }) } });
  const [titulo, o] = sw.mostradas[0];
  assert.equal(titulo, 'Pagamento previsto hoje');
  assert.deepEqual(o.actions.map(a => a.action), ['recebi', 'rota']);
  assert.equal(o.data.acoes.length, 2);
});

test('renovação em segundo plano: reagenda a janela, cancela os antigos e não repete', async () => {
  const pedidos = [];
  const sw = montar({ agendar: corpo => { pedidos.push(corpo); return new Response(JSON.stringify({ ids: corpo.avisos.map((_, i) => 'novo' + i) })); } });
  const agora = Date.now(), dia = 86400000;
  const avisos = [1, 3, 6, 10, 20].map(d => ({ at: agora + d * dia, tag: 'ini:X' + d + ':1', title: 't', body: 'b', url: './' }));
  const cx = await sw.caches.open('plantoes-estado');
  await cx.put(ORIGEM + '/__estado/avisos.json', new Response(JSON.stringify({
    sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }, avisos,
    estado: { hash: 'velho', em: agora - 2 * dia, ids: ['antigo1', 'antigo2'] } })));
  await sw.disparar('periodicsync', { tag: 'avisos' });
  assert.equal(pedidos.length, 1);
  assert.deepEqual(pedidos[0].cancelar, ['antigo1', 'antigo2']);
  assert.deepEqual(pedidos[0].avisos.map(a => a.tag), ['ini:X1:1', 'ini:X3:1', 'ini:X6:1'], 'só a janela de 6,5 dias');
  const esp = JSON.parse(await (await cx.match(ORIGEM + '/__estado/avisos.json')).text());
  assert.deepEqual(esp.estado.ids, ['novo0', 'novo1', 'novo2']);
  await sw.disparar('periodicsync', { tag: 'avisos' });
  assert.equal(pedidos.length, 1, 'nada mudou: não gasta agendamentos');
});

test('atualização do app não apaga o espelho dos avisos', async () => {
  const sw = montar();
  await sw.caches.open('plantoes-estado'); await sw.caches.open('plantoes-v-antigo');
  await sw.disparar('activate', {});
  assert.deepEqual(await sw.caches.keys(), ['plantoes-estado']);
});
