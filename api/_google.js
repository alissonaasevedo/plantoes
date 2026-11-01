// Login Google pelo "modelo de código" (Google Identity Services): o app recebe um código
// numa janelinha do Google e este servidor troca o código por tokens usando o segredo do
// cliente, que nunca vai para o celular. O token de renovação fica no aparelho do usuário;
// nada é guardado aqui. Escopos pedidos pelo app: agendas criadas pelo próprio app
// (calendar.app.created) e a pasta oculta do app no Drive (drive.appdata).
import { json } from './_lib.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export function googleConfigurado(env) {
  return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].every(k => typeof env[k] === 'string' && env[k].trim() !== '');
}

// proteção contra chamadas de outros sites: cabeçalho próprio (navegador não envia entre
// origens sem permissão) + Origin igual ao endereço do app quando presente
export function origemOk(request) {
  if ((request.headers.get('x-requested-with') || '').toLowerCase() !== 'xmlhttprequest') return false;
  const o = request.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

// e-mail da conta, lido do id_token que veio direto do Google pelo HTTPS desta troca
export function emailDoIdToken(t) {
  try {
    const p = String(t || '').split('.')[1];
    const dados = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof dados.email === 'string' ? dados.email.slice(0, 120) : '';
  } catch { return ''; }
}

async function lerCorpo(request) { try { return await request.json(); } catch { return null; } }
async function postForm(fetcher, url, campos) {
  const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(campos).toString() });
  let d = {}; try { d = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, d };
}

// POST /api/google/conectar { code } → { access_token, expires_in, refresh_token?, email, escopos }
export function criarConectar({ env, fetcher = fetch }) {
  return async function conectar(request) {
    if (!googleConfigurado(env)) return json({ erro: 'login Google não configurado' }, 503);
    if (!origemOk(request)) return json({ erro: 'origem não permitida' }, 403);
    const corpo = await lerCorpo(request);
    const code = corpo && typeof corpo.code === 'string' ? corpo.code.slice(0, 2048) : '';
    if (!code) return json({ erro: 'código ausente' }, 400);
    const base = { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'authorization_code' };
    // janela (popup) do GIS: o Google aceita "postmessage" ou a origem do app, conforme a época da doc
    let r = await postForm(fetcher, TOKEN_URL, { ...base, redirect_uri: 'postmessage' });
    if (!r.ok && r.d && r.d.error === 'redirect_uri_mismatch')
      r = await postForm(fetcher, TOKEN_URL, { ...base, redirect_uri: new URL(request.url).origin });
    if (!r.ok || !r.d.access_token) return json({ erro: 'o Google recusou o login', detalhe: String(r.d.error || r.status) }, 400);
    return json({
      access_token: r.d.access_token,
      expires_in: +r.d.expires_in || 3600,
      refresh_token: r.d.refresh_token || null,
      email: emailDoIdToken(r.d.id_token),
      escopos: String(r.d.scope || '').split(' ').filter(Boolean),
    });
  };
}

// POST /api/google/renovar { refresh_token } → { access_token, expires_in }   (401 = precisa conectar de novo)
export function criarRenovar({ env, fetcher = fetch }) {
  return async function renovar(request) {
    if (!googleConfigurado(env)) return json({ erro: 'login Google não configurado' }, 503);
    if (!origemOk(request)) return json({ erro: 'origem não permitida' }, 403);
    const corpo = await lerCorpo(request);
    const rt = corpo && typeof corpo.refresh_token === 'string' ? corpo.refresh_token.slice(0, 1024) : '';
    if (!rt) return json({ erro: 'token ausente' }, 400);
    const r = await postForm(fetcher, TOKEN_URL, { refresh_token: rt, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' });
    if (!r.ok || !r.d.access_token) {
      const expirado = r.d && (r.d.error === 'invalid_grant' || r.d.error === 'unauthorized_client');
      return json({ erro: expirado ? 'acesso revogado ou expirado' : 'falha ao renovar', expirado }, expirado ? 401 : 502);
    }
    return json({ access_token: r.d.access_token, expires_in: +r.d.expires_in || 3600 });
  };
}

// POST /api/google/sair { token } → revoga o acesso no Google
export function criarSair({ env, fetcher = fetch }) {
  return async function sair(request) {
    if (!origemOk(request)) return json({ erro: 'origem não permitida' }, 403);
    const corpo = await lerCorpo(request);
    const t = corpo && typeof corpo.token === 'string' ? corpo.token.slice(0, 2048) : '';
    if (!t) return json({ ok: true });
    const r = await postForm(fetcher, REVOKE_URL, { token: t });
    return json({ ok: r.ok || r.status === 400 });   // 400 = já estava revogado
  };
}
