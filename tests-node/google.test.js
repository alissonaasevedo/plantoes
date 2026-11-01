// Testes do login Google e dos botões das notificações.  node --test tests-node/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConectar, criarRenovar, criarSair, origemOk, emailDoIdToken, googleConfigurado, TOKEN_URL } from '../api/_google.js';
import { limparAviso, limparAcoes } from '../api/_lib.js';

const ENV = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'segredo' };
const H = { 'content-type': 'application/json', 'x-requested-with': 'XmlHttpRequest', origin: 'https://plantoes.test' };
const req = (corpo, headers = H) => new Request('https://plantoes.test/api/google/x', { method: 'POST', headers, body: JSON.stringify(corpo) });
const jwt = o => 'x.' + Buffer.from(JSON.stringify(o)).toString('base64url') + '.y';

function googleFalso(respostas) {
  const f = async (url, init) => {
    const campos = Object.fromEntries(new URLSearchParams(init.body));
    f.chamadas.push({ url, campos });
    const [status, corpo] = respostas.shift();
    return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  };
  f.chamadas = [];
  return f;
}

test('login só com cliente e segredo configurados', async () => {
  assert.equal(googleConfigurado(ENV), true);
  assert.equal(googleConfigurado({ GOOGLE_CLIENT_ID: 'x' }), false);
  const r = await criarConectar({ env: {}, fetcher: googleFalso([]) })(req({ code: 'c' }));
  assert.equal(r.status, 503);
});

test('recusa chamadas de outros sites', async () => {
  assert.equal(origemOk(req({}, { ...H, origin: 'https://evil.example' })), false);
  assert.equal(origemOk(req({}, { 'content-type': 'application/json', origin: 'https://plantoes.test' })), false);
  assert.equal(origemOk(req({})), true);
  const r = await criarConectar({ env: ENV, fetcher: googleFalso([]) })(req({ code: 'c' }, { ...H, origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
});

test('troca o código por tokens com o segredo, sem devolver o segredo', async () => {
  const g = googleFalso([[200, { access_token: 'at', expires_in: 3599, refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/drive.appdata', id_token: jwt({ email: 'dr@gmail.com' }) }]]);
  const r = await criarConectar({ env: ENV, fetcher: g })(req({ code: 'abc' }));
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([d.access_token, d.refresh_token, d.email, d.expires_in], ['at', 'rt', 'dr@gmail.com', 3599]);
  assert.ok(d.escopos.includes('https://www.googleapis.com/auth/drive.appdata'));
  assert.equal(g.chamadas[0].url, TOKEN_URL);
  assert.deepEqual([g.chamadas[0].campos.code, g.chamadas[0].campos.client_secret, g.chamadas[0].campos.redirect_uri], ['abc', 'segredo', 'postmessage']);
  assert.ok(!JSON.stringify(d).includes('segredo'));
});

test('tenta a origem do app quando o Google não aceita "postmessage"', async () => {
  const g = googleFalso([[400, { error: 'redirect_uri_mismatch' }], [200, { access_token: 'at', expires_in: 3600 }]]);
  const d = await (await criarConectar({ env: ENV, fetcher: g })(req({ code: 'abc' }))).json();
  assert.equal(g.chamadas[1].campos.redirect_uri, 'https://plantoes.test');
  assert.equal(d.refresh_token, null);
});

test('renovar: token novo ou 401 quando o acesso foi revogado', async () => {
  const ok = await criarRenovar({ env: ENV, fetcher: googleFalso([[200, { access_token: 'novo', expires_in: 3600 }]]) })(req({ refresh_token: 'rt' }));
  assert.equal((await ok.json()).access_token, 'novo');
  const rev = await criarRenovar({ env: ENV, fetcher: googleFalso([[400, { error: 'invalid_grant' }]]) })(req({ refresh_token: 'rt' }));
  assert.equal(rev.status, 401);
  assert.equal((await rev.json()).expirado, true);
  const fora = await criarRenovar({ env: ENV, fetcher: googleFalso([[503, {}]]) })(req({ refresh_token: 'rt' }));
  assert.equal(fora.status, 502);
});

test('sair revoga o token', async () => {
  const g = googleFalso([[200, {}]]);
  const d = await (await criarSair({ env: ENV, fetcher: g })(req({ token: 'rt' }))).json();
  assert.equal(d.ok, true);
  assert.equal(g.chamadas[0].campos.token, 'rt');
});

test('e-mail do id_token, tolerante a lixo', () => {
  assert.equal(emailDoIdToken(jwt({ email: 'a@b.com' })), 'a@b.com');
  assert.equal(emailDoIdToken('lixo'), '');
});

test('botões da notificação: só ações conhecidas e links seguros', () => {
  const ok = limparAcoes([{ acao: 'recebi', titulo: 'Recebi', url: './?action=recebi&ids=a,b' }, { acao: 'rota', titulo: 'Como chegar', url: 'https://www.google.com/maps/search/?api=1&query=UPA' }, { acao: 'ver', url: './' }]);
  assert.equal(ok.length, 2);
  assert.deepEqual(limparAcoes([{ acao: 'rota', url: 'https://evil.example/maps' }, { acao: 'apagar', url: './' }, { acao: 'ver', url: '//evil.example' }]), []);
  assert.deepEqual(limparAcoes([{ acao: 'ver', url: 'https://www.google.com/maps/x' }]), [], 'link externo só para a rota');
  const a = limparAviso({ at: 1000, tag: 'pag:x', title: 't', url: 'javascript:alert(1)', acoes: ok }, 1000);
  assert.equal(a.n.url, './');
  assert.equal(a.n.acoes.length, 2);
});
