// Lógica do servidor de avisos, sem dependências externas (testável com dublês).
// Arquivos com "_" na frente não viram rota na Vercel.
//
// Fluxo: o app manda a lista dos próximos avisos → /api/agendar agenda cada um
// no QStash (entrega programada) → na hora, o QStash chama /api/enviar → que
// envia o Web Push ao celular. Nenhum dado fica guardado no servidor.

export const MAX_AVISOS = 40;                 // por sincronização
export const MAX_CANCELAR = 80;
export const HORIZONTE_MS = 7 * 86400000;     // atraso máximo do QStash no plano grátis
export const IMEDIATO_MS = 30000;             // abaixo disso, envia já (ex.: aviso de teste)

// só serviços de push reais (Google/Android, Apple, Mozilla, Microsoft)
const HOSTS_PUSH = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)mozaws\.net$/, /(^|\.)notify\.windows\.com$/];

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export function configurado(env) {
  return ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY']
    .every(k => typeof env[k] === 'string' && env[k].trim() !== '');
}

export function validarAssinatura(sub) {
  if (!sub || typeof sub !== 'object') throw new Error('assinatura ausente');
  let u;
  try { u = new URL(String(sub.endpoint || '')); } catch { throw new Error('endpoint inválido'); }
  if (u.protocol !== 'https:' || !HOSTS_PUSH.some(r => r.test(u.hostname))) throw new Error('serviço de push não reconhecido');
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) throw new Error('chaves inválidas');
  return { endpoint: u.toString(), keys: { p256dh: k.p256dh, auth: k.auth } };
}

const txt = (v, n) => String(v ?? '').slice(0, n);
export function limparAviso(a, agora) {
  const at = Number(a && a.at);
  if (!Number.isFinite(at) || at < agora - 60000 || at > agora + HORIZONTE_MS) return null;
  const url = txt(a.url, 300);
  return {
    at,
    n: {
      title: txt(a.title, 80) || 'Plantaê!',
      body: txt(a.body, 200),
      tag: txt(a.tag, 120),
      url: url.startsWith('./') || url.startsWith('/') ? url : './',
      sid: txt(a.sid, 60),
    },
  };
}

// POST /api/agendar  { sub, cancelar: [ids], avisos: [{at, title, body, tag, url, sid}] } → { ids }
export function criarAgendar({ qstash, destino, agora = () => Date.now() }) {
  return async function agendar(request) {
    let dados;
    try { dados = await request.json(); } catch { return json({ erro: 'JSON inválido' }, 400); }
    let sub;
    try { sub = validarAssinatura(dados.sub); } catch (e) { return json({ erro: e.message }, 400); }
    const cancelar = Array.isArray(dados.cancelar) ? dados.cancelar.filter(x => typeof x === 'string' && x.length < 120).slice(0, MAX_CANCELAR) : [];
    const avisos = Array.isArray(dados.avisos) ? dados.avisos : [];
    if (avisos.length > MAX_AVISOS) return json({ erro: `no máximo ${MAX_AVISOS} avisos por vez` }, 400);

    // cancela os agendamentos anteriores deste aparelho (o app guarda os ids)
    await Promise.all(cancelar.map(id => qstash.messages.delete(id).catch(() => null)));

    const t = agora();
    const ids = [];
    for (const bruto of avisos) {
      const a = limparAviso(bruto, t);
      if (!a) { ids.push(null); continue; }
      const opts = { url: destino, body: { sub, n: a.n }, retries: 2 };
      if (a.at - t > IMEDIATO_MS) opts.notBefore = Math.floor(a.at / 1000);
      try { const r = await qstash.publishJSON(opts); ids.push(r && r.messageId ? r.messageId : null); }
      catch (e) { ids.push(null); }
    }
    return json({ ids, agendados: ids.filter(Boolean).length, cancelados: cancelar.length });
  };
}

// POST /api/enviar  (chamado pelo QStash, com assinatura) → envia o Web Push
export function criarEnviar({ receiver, webpush }) {
  return async function enviar(request) {
    const corpo = await request.text();
    const assinatura = request.headers.get('upstash-signature') || '';
    let valido = false;
    try { valido = !!assinatura && await receiver.verify({ signature: assinatura, body: corpo }); } catch { valido = false; }
    if (!valido) return json({ erro: 'assinatura inválida' }, 401);
    let dados;
    try { dados = JSON.parse(corpo); } catch { return json({ erro: 'JSON inválido' }, 400); }
    let sub;
    try { sub = validarAssinatura(dados.sub); } catch (e) { return json({ erro: e.message }, 400); }
    try {
      await webpush.sendNotification(sub, JSON.stringify(dados.n || {}), { TTL: 3600, urgency: 'high' });
      return json({ ok: true });
    } catch (e) {
      // 404/410: o aparelho cancelou a inscrição — não adianta o QStash tentar de novo
      if (e && (e.statusCode === 404 || e.statusCode === 410)) return json({ ok: false, expirada: true });
      return json({ erro: 'falha ao enviar', status: e && e.statusCode }, 502);
    }
  };
}
