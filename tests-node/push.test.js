// Testes do servidor de avisos com dublês do QStash e do web-push.  node --test tests-node/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarAgendar, criarEnviar, validarAssinatura, limparAviso, configurado, MAX_AVISOS } from '../api/_lib.js';

const AGORA = Date.UTC(2026, 9, 20, 20, 0);
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BPx'.padEnd(87, 'a'), auth: 'aut'.padEnd(22, 'b') } };
const req = (corpo, headers = {}) => new Request('https://plantoes.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

function qstashFalso() {
  const q = { publicados: [], cancelados: [], n: 0 };
  q.publishJSON = async o => { q.publicados.push(o); return { messageId: 'msg_' + (++q.n) }; };
  q.messages = { delete: async id => { q.cancelados.push(id); if (id === 'falha') throw new Error('x'); } };
  return q;
}

test('configurado exige as cinco variáveis', () => {
  const env = { VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', QSTASH_TOKEN: 'c', QSTASH_CURRENT_SIGNING_KEY: 'd', QSTASH_NEXT_SIGNING_KEY: 'e' };
  assert.equal(configurado(env), true);
  assert.equal(configurado({ ...env, QSTASH_TOKEN: ' ' }), false);
});

test('aceita só serviços de push reais', () => {
  assert.ok(validarAssinatura(SUB));
  assert.ok(validarAssinatura({ ...SUB, endpoint: 'https://web.push.apple.com/QAbc' }));
  for (const e of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://googleapis.com.evil.io/x', 'lixo'])
    assert.throws(() => validarAssinatura({ ...SUB, endpoint: e }));
  assert.throws(() => validarAssinatura({ endpoint: SUB.endpoint, keys: {} }));
});

test('limparAviso corta textos, recusa datas fora da janela e URLs externas', () => {
  const a = limparAviso({ at: AGORA + 3600e3, title: 'x'.repeat(200), body: 'y', url: 'https://phishing.io' }, AGORA);
  assert.equal(a.n.title.length, 80);
  assert.equal(a.n.url, './');
  assert.equal(limparAviso({ at: AGORA + 8 * 86400e3 }, AGORA), null);
  assert.equal(limparAviso({ at: AGORA - 5 * 60e3 }, AGORA), null);
});

test('agendar cancela os anteriores e agenda cada aviso no horário', async () => {
  const q = qstashFalso();
  const agendar = criarAgendar({ qstash: q, destino: 'https://plantoes.test/api/enviar', agora: () => AGORA });
  const avisos = [
    { at: AGORA + 3600e3, tag: 'ini:S1:1', title: 'Plantão em 1 hora', body: 'UPA', url: './?action=plantao&id=S1', sid: 'S1' },
    { at: AGORA + 10e3, tag: 'teste', title: 'Teste', body: 'agora' },                 // < 30 s: imediato
    { at: AGORA + 9 * 86400e3, tag: 'longe', title: 'fora da janela' },              // > 7 dias: ignorado
  ];
  const r = await agendar(req({ sub: SUB, cancelar: ['msg_velho', 'falha'], avisos }));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(q.cancelados, ['msg_velho', 'falha']);           // falha ao cancelar não derruba
  assert.deepEqual(d.ids, ['msg_1', 'msg_2', null]);
  assert.equal(q.publicados[0].notBefore, Math.floor((AGORA + 3600e3) / 1000));
  assert.equal(q.publicados[0].url, 'https://plantoes.test/api/enviar');
  assert.equal(q.publicados[0].body.n.sid, 'S1');
  assert.equal('notBefore' in q.publicados[1], false);
});

test('agendar recusa entrada ruim', async () => {
  const agendar = criarAgendar({ qstash: qstashFalso(), destino: 'x', agora: () => AGORA });
  assert.equal((await agendar(req('{nao é json'))).status, 400);
  assert.equal((await agendar(req({ sub: { endpoint: 'https://evil.io/x', keys: SUB.keys }, avisos: [] }))).status, 400);
  const muitos = Array.from({ length: MAX_AVISOS + 1 }, (_, i) => ({ at: AGORA + 3600e3 + i }));
  assert.equal((await agendar(req({ sub: SUB, avisos: muitos }))).status, 400);
});

test('enviar exige assinatura do QStash e envia o push', async () => {
  const enviados = [];
  const receiver = { verify: async ({ signature, body }) => signature === 'ok' && body.includes('S1') };
  const webpush = { sendNotification: async (sub, payload, opts) => { enviados.push({ sub, payload: JSON.parse(payload), opts }); } };
  const enviar = criarEnviar({ receiver, webpush });
  const corpo = { sub: SUB, n: { title: 'Plantão em 1 hora', sid: 'S1', tag: 'ini:S1:1', url: './?action=plantao&id=S1' } };
  assert.equal((await enviar(req(corpo))).status, 401);                                       // sem assinatura
  assert.equal((await enviar(req(corpo, { 'upstash-signature': 'falsa' }))).status, 401);
  const r = await enviar(req(corpo, { 'upstash-signature': 'ok' }));
  assert.equal(r.status, 200);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].payload.sid, 'S1');
  assert.equal(enviados[0].opts.urgency, 'high');
});

test('enviar: inscrição expirada não gera nova tentativa; outras falhas sim', async () => {
  const receiver = { verify: async () => true };
  const corpo = { sub: SUB, n: { title: 't' } };
  const expirada = criarEnviar({ receiver, webpush: { sendNotification: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } } });
  assert.equal((await expirada(req(corpo, { 'upstash-signature': 's' }))).status, 200);
  const caiu = criarEnviar({ receiver, webpush: { sendNotification: async () => { const e = new Error('x'); e.statusCode = 500; throw e; } } });
  assert.equal((await caiu(req(corpo, { 'upstash-signature': 's' }))).status, 502);
});

test('rota /api/config real: desligada sem variáveis, ligada com elas', async () => {
  const { GET } = await import('../api/config.js?' + Date.now());
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY']) delete process.env[k];
  assert.deepEqual(await GET().json(), { ativo: false, vapidPublica: null });
  Object.assign(process.env, { VAPID_PUBLIC_KEY: 'PUB', VAPID_PRIVATE_KEY: 'p', QSTASH_TOKEN: 't', QSTASH_CURRENT_SIGNING_KEY: 'c', QSTASH_NEXT_SIGNING_KEY: 'n' });
  assert.deepEqual(await GET().json(), { ativo: true, vapidPublica: 'PUB' });
});

test('rotas reais carregam as bibliotecas sem erro', async () => {
  const ag = await import('../api/agendar.js');
  const en = await import('../api/enviar.js');
  assert.equal(typeof ag.POST, 'function');
  assert.equal(typeof en.POST, 'function');
});

test('verificador real do QStash: aceita assinatura legítima, recusa corpo adulterado', async () => {
  const { Receiver } = await import('@upstash/qstash');
  const { createHmac, createHash } = await import('node:crypto');
  const chave = 'sig_chave_de_teste';
  const b64u = b => Buffer.from(b).toString('base64url');
  const corpo = JSON.stringify({ sub: SUB, n: { title: 'Plantão em 1 hora' } });
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const carga = b64u(JSON.stringify({ iss: 'Upstash', sub: 'https://plantoes.test/api/enviar', exp: agora + 300, nbf: agora - 10, iat: agora,
    jti: 'x', body: createHash('sha256').update(corpo).digest('base64url') }));
  const assinatura = `${cab}.${carga}.${createHmac('sha256', chave).update(`${cab}.${carga}`).digest('base64url')}`;
  const enviados = [];
  const enviar = criarEnviar({ receiver: new Receiver({ currentSigningKey: chave, nextSigningKey: 'outra' }),
    webpush: { sendNotification: async () => { enviados.push(1); } } });
  assert.equal((await enviar(req(corpo, { 'upstash-signature': assinatura }))).status, 200);
  assert.equal((await enviar(req(corpo.replace('1 hora', '5 horas'), { 'upstash-signature': assinatura }))).status, 401);
  assert.equal(enviados.length, 1);
});
