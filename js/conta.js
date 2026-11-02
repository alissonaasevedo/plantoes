/* ================= Conta Google: Agenda + backup no Drive =================
   Login pelo modelo de código do Google (janela do Google → código → /api/google/conectar,
   que usa o segredo guardado na Vercel). O token de renovação fica só neste aparelho e
   renova o acesso sozinho, sem pedir login de novo.
   · Agenda: uma agenda própria "Plantaê!" na conta. Cada plantão vira um evento com
     identidade fixa (derivada do id do plantão) — sincronizar de novo só atualiza.
   · Drive: uma cópia por dia na pasta oculta do app (o usuário não vê no Drive e o app
     não enxerga nenhum outro arquivo). Guarda as últimas 30.
   Depende de app.js (S, store, render, toast, helpers de evento).                        */
const G_ESCOPOS = ['openid', 'email',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/drive.appdata'];
const G_ESC_AGENDA = G_ESCOPOS[2], G_ESC_DRIVE = G_ESCOPOS[3];
const G_CAL = 'https://www.googleapis.com/calendar/v3';
const G_DRIVE = 'https://www.googleapis.com/drive/v3', G_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const G_COPIAS = 30;
const G_TZ = (()=>{ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'; }catch(e){ return 'America/Sao_Paulo'; } })();

// estado no aparelho (fora do backup e do diagnóstico)
function gLer(k, padrao){ try{ return JSON.parse(lsGet(k) || 'null') || padrao; }catch(e){ return padrao; } }
function gGravar(k, v){ lsSet(k, v == null ? '' : JSON.stringify(v)); }
const gConta = () => gLer('plantoes:google', null);            // {refresh, email, escopos, agenda, drive, calId, expirado}
const gSalvarConta = c => gGravar('plantoes:google', c);
const gConectado = () => { const c = gConta(); return !!(c && !c.expirado && (c.refresh || c.sessao)); };
const gTemEscopo = esc => { const c = gConta(); return !!(c && (c.escopos || []).includes(esc)); };
const gAgendaLigada = () => gConectado() && gConta().agenda !== false && gTemEscopo(G_ESC_AGENDA);
const gDriveLigado = () => gConectado() && gConta().drive !== false && gTemEscopo(G_ESC_DRIVE);

let _gAcesso = gLer('plantoes:gtoken', null);                    // {t, exp}
let _gSyncRodando = false, _gBkRodando = false, _gSyncDeNovo = false;
let _gTimerAgenda = null, _gTimerDrive = null, _gGisPromessa = null;

/* ---------- acesso ---------- */
function gErro(msg, codigo){ const e = new Error(msg); e.codigo = codigo; return e; }
async function gPost(rota, corpo){
  const r = await fetch('./api/google/' + rota, { method:'POST',
    headers:{ 'content-type':'application/json', 'x-requested-with':'XmlHttpRequest' }, body: JSON.stringify(corpo) });
  let d = {}; try{ d = await r.json(); }catch(e){}
  return { ok: r.ok, status: r.status, d };
}
function gGuardarAcesso(t, expiraEm){
  _gAcesso = { t, exp: Date.now() + (Math.max(60, +expiraEm || 3600) - 60) * 1000 };
  gGravar('plantoes:gtoken', _gAcesso);
}
async function gToken(forcarRenovar){
  if(!forcarRenovar && _gAcesso && _gAcesso.t && _gAcesso.exp > Date.now()) return _gAcesso.t;
  const c = gConta();
  if(c && c.sessao && !c.refresh && !c.expirado){             // conta sem renovação automática: vale 1 h
    gSalvarConta({ ...c, expirado: true }); renderConta();
    throw gErro('O acesso à conta Google expirou — conecte de novo', 'reconectar');
  }
  if(!c || !c.refresh || c.expirado) throw gErro('Conecte a conta Google', 'reconectar');
  const r = await gPost('renovar', { refresh_token: c.refresh });
  if(r.status === 401){
    gSalvarConta({ ...c, refresh: null, expirado: true }); _gAcesso = null; gGravar('plantoes:gtoken', null);
    renderConta();
    throw gErro('O acesso à conta Google expirou — conecte de novo', 'reconectar');
  }
  if(!r.ok || !r.d.access_token) throw gErro('Não consegui falar com o Google agora', 'rede');
  gGuardarAcesso(r.d.access_token, r.d.expires_in);
  return _gAcesso.t;
}
// chamada às APIs do Google; renova uma vez se o token venceu no caminho e espera e tenta
// de novo quando o Google pede calma (muitos eventos de uma vez na primeira sincronização)
const dormir = ms => new Promise(ok => setTimeout(ok, ms));
async function gApi(metodo, url, { corpo, bruto, tipo } = {}, tentou){
  const t = await gToken(false);
  const h = { authorization: 'Bearer ' + t };
  let body;
  if(bruto !== undefined){ body = bruto; if(tipo) h['content-type'] = tipo; }
  else if(corpo !== undefined){ body = JSON.stringify(corpo); h['content-type'] = 'application/json'; }
  for(let i = 0; ; i++){
    const r = await fetch(url, { method: metodo, headers: h, body });
    if(r.status === 401 && !tentou){ await gToken(true); return gApi(metodo, url, { corpo, bruto, tipo }, true); }
    let calma = r.status === 429 || r.status >= 500;
    if(r.status === 403){ const txt = await r.clone().text().catch(() => ''); calma = /rateLimit|userRateLimit|quotaExceeded|usageLimits/i.test(txt); }
    if(!calma || i >= 4) return r;
    await dormir(800 * 2 ** i + Math.random() * 400);
  }
}
async function gJson(r){ try{ return await r.json(); }catch(e){ return {}; } }

/* ---------- login ---------- */
function gCarregarGIS(){
  if(window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if(_gGisPromessa) return _gGisPromessa;
  _gGisPromessa = new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => ok(); s.onerror = () => { _gGisPromessa = null; falha(gErro('Sem conexão com o Google', 'rede')); };
    document.head.appendChild(s);
  });
  return _gGisPromessa;
}
async function gConectar(){
  const cfg = await pushConfig();
  if(!cfg.google){ toast(cfg.offline ? 'Sem internet — tente de novo' : 'Login Google ainda não configurado no servidor'); return; }
  try{ await gCarregarGIS(); }catch(e){ toast(e.message); return; }
  const cliente = google.accounts.oauth2.initCodeClient({
    client_id: cfg.google, scope: G_ESCOPOS.join(' '), ux_mode: 'popup', select_account: true,
    callback: r => gConcluirLogin(r).catch(e => { registrarErro(e, 'google:login'); toast('Não consegui conectar: ' + e.message); renderConta(); }),
    error_callback: e => { if(e && e.type !== 'popup_closed') toast('Login cancelado'); renderConta(); },
  });
  cliente.requestCode();
}
async function gConcluirLogin(resp){
  if(!resp || !resp.code){ toast('Login cancelado'); return; }
  $('#g-status').textContent = 'Conectando…';
  const r = await gPost('conectar', { code: resp.code });
  if(!r.ok) throw gErro(r.d.erro || 'falha no login', 'login');
  const antes = gConta() || {};
  // sem token de renovação (a conta já tinha autorizado o app antes): revoga e pede de novo
  // uma vez — o Google só entrega o token de renovação numa autorização nova
  if(!r.d.refresh_token && !antes.semRenovacaoTentou){
    await gPost('sair', { token: r.d.access_token });
    gSalvarConta({ ...antes, semRenovacaoTentou: true });
    toast('Falta um passo: toque em Conectar mais uma vez', { label:'Conectar', fn: gConectar });
    renderConta(); return;
  }
  const mesmaConta = antes.email && antes.email === r.d.email;
  gSalvarConta({ refresh: r.d.refresh_token || null, email: r.d.email || '', escopos: r.d.escopos || [],
    agenda: antes.agenda !== false, drive: antes.drive !== false, calId: mesmaConta ? antes.calId : null,
    sessao: !r.d.refresh_token });
  if(!mesmaConta){ gGravar('plantoes:gcalMap', null); gGravar('plantoes:gcalSync', null); gGravar('plantoes:gdrive', null); }
  gGuardarAcesso(r.d.access_token, r.d.expires_in);
  haptic(12);
  const falta = [];
  if(!gTemEscopo(G_ESC_AGENDA)) falta.push('Agenda');
  if(!gTemEscopo(G_ESC_DRIVE)) falta.push('Drive');
  toast(falta.length ? `Conectado, mas sem permissão para ${falta.join(' e ')} — conecte de novo e marque as caixas` : 'Conta Google conectada');
  renderConta();
  // celular novo/vazio: oferece trazer o backup do Drive antes de sincronizar a agenda
  if(!S.shifts.length && gDriveLigado()){ const lista = await gListarBackups().catch(() => []); if(lista.length){ abrirRestaurarDrive(lista); return; } }
  gSincronizarTudo({ completo: true });
}
async function gDesconectar(){
  const c = gConta() || {};
  try{ if(c.refresh) await gPost('sair', { token: c.refresh }); }catch(e){}
  ['plantoes:google','plantoes:gtoken','plantoes:gcalMap','plantoes:gcalSync','plantoes:gdrive'].forEach(k => lsSet(k, ''));
  _gAcesso = null;
  toast('Conta Google desconectada — a agenda e os backups continuam na sua conta');
  renderConta();
}

/* ---------- Agenda ---------- */
const hexUtf8 = t => Array.from(new TextEncoder().encode(String(t)), b => b.toString(16).padStart(2,'0')).join('');
// ids aceitos pelo Google: letras a–v e dígitos (base32hex), 5 a 1024 caracteres
const gEvId = s => 'pl' + hexUtf8(s.id);
const gBlId = b => 'bl' + hexUtf8(b.id);
const dtLocal = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
const NOME_BLOQ = { ferias:'Férias', viagem:'Viagem', sobreaviso:'Sobreaviso', compromisso:'Compromisso', outro:'Bloqueado' };

function gCorpoPlantao(s){
  const { ini, f } = evJanela(s);
  return { summary: evTitulo(s), location: evLocal(s) || undefined,
    description: evDetalhe(s) + '\n\nSincronizado pelo Plantaê!',
    start:{ dateTime: dtLocal(ini), timeZone: G_TZ }, end:{ dateTime: dtLocal(f), timeZone: G_TZ },
    reminders:{ useDefault:false, overrides:[] },        // os avisos já vêm do app — sem notificação dobrada
    transparency:'opaque', status:'confirmed' };
}
function gCorpoBloqueio(b){
  const fimExc = new Date(parseDate(b.fim || b.ini).getTime() + 86400000);
  return { summary: NOME_BLOQ[b.motivo] || 'Bloqueado', description: (b.obs ? b.obs + '\n\n' : '') + 'Sincronizado pelo Plantaê!',
    start:{ date: b.ini }, end:{ date: iso(fimExc) }, reminders:{ useDefault:false, overrides:[] },
    transparency:'opaque', status:'confirmed' };
}
// o que deveria estar na agenda agora: id → {corpo, h}
function gDesejado(){
  const m = new Map();
  const por = (id, corpo) => {
    const h = hashTxt(JSON.stringify(corpo));
    m.set(id, { h, corpo: { ...corpo, id, extendedProperties:{ private:{ plantae:'1', h } } } });
  };
  S.shifts.filter(naAgenda).forEach(s => por(gEvId(s), gCorpoPlantao(s)));
  (S.bloqueios || []).filter(b => b && b.ini).forEach(b => por(gBlId(b), gCorpoBloqueio(b)));
  return m;
}
async function gCalendario(){
  const c = gConta();
  if(c.calId) return c.calId;
  const r = await gApi('POST', G_CAL + '/calendars', { corpo:{ summary:'Plantaê!', description:'Plantões, residência e bloqueios lançados no app Plantaê!', timeZone: G_TZ } });
  if(!r.ok) throw gErro('Não consegui criar a agenda Plantaê! (' + r.status + ')', 'agenda');
  const d = await gJson(r);
  gSalvarConta({ ...gConta(), calId: d.id });
  gGravar('plantoes:gcalMap', {});
  return d.id;
}
async function gListarRemotos(cal){
  const remotos = new Map(); let page = '';
  do{
    const u = new URL(G_CAL + '/calendars/' + encodeURIComponent(cal) + '/events');
    u.searchParams.set('maxResults', '2500'); u.searchParams.set('privateExtendedProperty', 'plantae=1');
    u.searchParams.set('fields', 'nextPageToken,items(id,status,extendedProperties)');
    if(page) u.searchParams.set('pageToken', page);
    const r = await gApi('GET', u.toString());
    if(r.status === 404) throw gErro('agenda removida', 'semAgenda');
    if(!r.ok) throw gErro('Não consegui ler a agenda (' + r.status + ')', 'agenda');
    const d = await gJson(r);
    (d.items || []).forEach(ev => { if(ev.status !== 'cancelled') remotos.set(ev.id, ((ev.extendedProperties||{}).private||{}).h || ''); });
    page = d.nextPageToken || '';
  } while(page);
  return remotos;
}
async function gGravarEvento(cal, id, corpo){
  const base = G_CAL + '/calendars/' + encodeURIComponent(cal) + '/events';
  // PUT atualiza (e reativa um evento apagado antes); 404 → ainda não existe → cria com o id fixo
  let r = await gApi('PUT', base + '/' + id, { corpo });
  if(r.status === 404 || r.status === 410){
    r = await gApi('POST', base, { corpo });
    if(r.status === 409) r = await gApi('PUT', base + '/' + id, { corpo });
    if(r.status === 404) throw gErro('agenda removida', 'semAgenda');
  }
  if(!r.ok) throw gErro('O Google recusou um evento (' + r.status + ')', 'agenda');
}
async function gApagarEvento(cal, id){
  const r = await gApi('DELETE', G_CAL + '/calendars/' + encodeURIComponent(cal) + '/events/' + id);
  if(!r.ok && r.status !== 404 && r.status !== 410) throw gErro('Não consegui apagar um evento (' + r.status + ')', 'agenda');
}
async function emParalelo(itens, n, fn){
  const fila = itens.slice(); let erro = null;
  await Promise.all(Array.from({ length: Math.min(n, fila.length) }, async () => {
    while(fila.length && !erro){ const x = fila.shift(); try{ await fn(x); }catch(e){ erro = e; } }
  }));
  if(erro) throw erro;
}
async function gSincronizarAgenda({ completo } = {}, tentativa = 0){
  if(!gAgendaLigada()) return;
  if(_gSyncRodando){ _gSyncDeNovo = true; return; }
  _gSyncRodando = true;
  try{
    const cal = await gCalendario();
    const desejado = gDesejado();
    let mapa = gLer('plantoes:gcalMap', {});
    const st = gLer('plantoes:gcalSync', {});
    // completo: confere com o que está de fato na agenda (celular novo, 1×/dia, botão Sincronizar)
    if(completo || !Object.keys(mapa).length || Date.now() - (st.completoEm || 0) > 86400000){
      const remotos = await gListarRemotos(cal);
      mapa = Object.fromEntries(remotos);
      st.completoEm = Date.now();
    }
    const gravar = [...desejado].filter(([id, x]) => mapa[id] !== x.h);
    const apagar = Object.keys(mapa).filter(id => !desejado.has(id));
    let feitos = 0;
    const progresso = () => { if(gravar.length + apagar.length > 6) $('#g-agenda-st') && ($('#g-agenda-st').textContent = `Agenda: enviando ${feitos} de ${gravar.length + apagar.length}…`); };
    await emParalelo(gravar, 3, async ([id, x]) => { await gGravarEvento(cal, id, x.corpo); mapa[id] = x.h; feitos++; gGravar('plantoes:gcalMap', mapa); progresso(); });
    await emParalelo(apagar, 3, async id => { await gApagarEvento(cal, id); delete mapa[id]; feitos++; gGravar('plantoes:gcalMap', mapa); progresso(); });
    gGravar('plantoes:gcalMap', mapa);
    gGravar('plantoes:gcalSync', { ...st, em: Date.now(), n: desejado.size, erro: '' });
    return { gravados: gravar.length, apagados: apagar.length };
  }catch(e){
    if(e.codigo === 'semAgenda' && tentativa === 0){
      // o usuário apagou a agenda Plantaê! no Google: recria e envia tudo de novo
      gSalvarConta({ ...gConta(), calId: null }); gGravar('plantoes:gcalMap', {});
      _gSyncRodando = false;
      return gSincronizarAgenda({ completo: true }, 1);
    }
    gGravar('plantoes:gcalSync', { ...gLer('plantoes:gcalSync', {}), erro: e.message, erroEm: Date.now() });
    if(e.codigo !== 'reconectar' && e.codigo !== 'rede') registrarErro(e, 'google:agenda');
    throw e;
  }finally{
    _gSyncRodando = false;
    renderConta();
    if(_gSyncDeNovo){ _gSyncDeNovo = false; setTimeout(() => gSincronizarAgenda().catch(() => {}), 500); }
  }
}

/* ---------- Drive ---------- */
async function gListarBackups(){
  const u = new URL(G_DRIVE + '/files');
  u.searchParams.set('spaces', 'appDataFolder'); u.searchParams.set('pageSize', '100');
  u.searchParams.set('orderBy', 'modifiedTime desc'); u.searchParams.set('q', "name contains 'plantae-' and trashed = false");
  u.searchParams.set('fields', 'files(id,name,modifiedTime,size)');
  const r = await gApi('GET', u.toString());
  if(!r.ok) throw gErro('Não consegui ler os backups do Drive (' + r.status + ')', 'drive');
  return ((await gJson(r)).files || []).filter(f => /^plantae-\d{4}-\d{2}-\d{2}\.json$/.test(f.name));
}
async function gBackupDrive({ forcar } = {}){
  if(!gDriveLigado() || _gBkRodando) return;
  if(!S.shifts.length && !(S.locais||[]).length) return;      // nunca sobrescreve uma cópia boa com dados vazios
  _gBkRodando = true;
  try{
    const txt = JSON.stringify(S);
    const h = hashTxt(txt), st = gLer('plantoes:gdrive', {});
    const nome = `plantae-${iso(new Date())}.json`;
    if(!forcar && st.h === h && st.nome === nome) return;
    let r;
    if(st.nome === nome && st.id){
      r = await gApi('PATCH', G_UPLOAD + '/files/' + st.id + '?uploadType=media', { bruto: txt, tipo: 'application/json' });
      if(r.status === 404) st.id = null;
    }
    if(!st.id || st.nome !== nome){
      const fronteira = 'plantae' + Date.now().toString(36);
      const meta = { name: nome, parents: ['appDataFolder'], mimeType: 'application/json' };
      const corpo = `--${fronteira}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
        + `--${fronteira}\r\nContent-Type: application/json\r\n\r\n${txt}\r\n--${fronteira}--`;
      r = await gApi('POST', G_UPLOAD + '/files?uploadType=multipart&fields=id', { bruto: corpo, tipo: 'multipart/related; boundary=' + fronteira });
    }
    if(!r.ok) throw gErro('O Drive recusou o backup (' + r.status + ')', 'drive');
    const d = await gJson(r);
    gGravar('plantoes:gdrive', { id: d.id || st.id, nome, h, em: Date.now(), erro: '' });
    lsSet('plantoes:lastBackup', iso(new Date()));
    // guarda as últimas G_COPIAS cópias diárias
    const lista = await gListarBackups().catch(() => []);
    for(const f of lista.slice(G_COPIAS)) await gApi('DELETE', G_DRIVE + '/files/' + f.id).catch(() => {});
  }catch(e){
    gGravar('plantoes:gdrive', { ...gLer('plantoes:gdrive', {}), erro: e.message, erroEm: Date.now() });
    if(e.codigo !== 'reconectar' && e.codigo !== 'rede') registrarErro(e, 'google:drive');
    throw e;
  }finally{
    _gBkRodando = false;
    renderConta(); if(typeof renderBackupInfo === 'function') renderBackupInfo();
  }
}
function abrirRestaurarDrive(lista){
  delete $('#sd-body').dataset.saude;
  $('#sd-title').textContent = 'Backups no Drive';
  const fmt = f => { const d = new Date(f.modifiedTime); return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  $('#sd-body').innerHTML = !lista.length ? '<p class="hint">Nenhum backup no Drive ainda.</p>'
    : `<p class="hint" style="margin-top:0">Restaurar substitui os dados deste aparelho pelos do backup escolhido. Uma cópia do que está aqui fica guardada antes.</p>`
      + lista.map((f, i) => `<div class="row g-bk"><div class="txt"><b>${fmt(f)}</b><small>${Math.max(1, Math.round((+f.size||0)/1024))} KB</small></div>
          <button class="btn sm" id="gbk-${i}" data-gbk="${esc(f.id)}">Restaurar</button></div>`).join('');
  $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
}
async function gRestaurar(id, botao){
  botao.disabled = true; botao.textContent = 'Baixando…';
  try{
    const r = await gApi('GET', G_DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media');
    if(!r.ok) throw gErro('Não consegui baixar o backup (' + r.status + ')', 'drive');
    const d = await r.json();
    closeSheets();
    if(await restaurarDados(d, 'Backup do Drive restaurado')) gSincronizarTudo({ completo: true });
  }catch(e){ toast(e.message || 'Backup inválido'); botao.disabled = false; botao.textContent = 'Restaurar'; }
}

/* ---------- gatilhos ---------- */
// confere no próprio Google quais permissões o token tem (a resposta do login às vezes
// vem sem a lista ou com o nome em outro formato) e guarda a lista certa
let _gEscoposConferidos = false;
async function gConferirEscopos(){
  if(!gConectado()) return;
  try{
    const t = await gToken(false);
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(t));
    if(!r.ok) return;
    const d = await gJson(r);
    const lista = String(d.scope || '').split(/\s+/).filter(Boolean);
    if(lista.length){ gSalvarConta({ ...gConta(), escopos: lista }); _gEscoposConferidos = true; }
  }catch(e){}
}
async function gSincronizarTudo({ completo } = {}){
  if(!gConectado()) return;
  if(!_gEscoposConferidos || !gTemEscopo(G_ESC_AGENDA) || !gTemEscopo(G_ESC_DRIVE)){ await gConferirEscopos(); renderConta(); }
  gSincronizarAgenda({ completo }).catch(() => {});
  gBackupDrive().catch(() => {});
}
// chamado por store.save: agenda logo; backup com folga (várias edições seguidas = 1 envio)
function aposSalvarConta(){
  if(!gConectado()) return;
  clearTimeout(_gTimerAgenda); _gTimerAgenda = setTimeout(() => gSincronizarAgenda().catch(() => {}), 4000);
  clearTimeout(_gTimerDrive); _gTimerDrive = setTimeout(() => gBackupDrive().catch(() => {}), 45000);
}
document.addEventListener('visibilitychange', () => {
  if(document.hidden && gConectado()){
    // saindo do app: manda o que estiver pendente agora
    if(_gTimerAgenda){ clearTimeout(_gTimerAgenda); _gTimerAgenda = null; gSincronizarAgenda().catch(() => {}); }
    if(_gTimerDrive){ clearTimeout(_gTimerDrive); _gTimerDrive = null; gBackupDrive().catch(() => {}); }
  }
});

/* ---------- tela ---------- */
function haQuanto(ms){
  const m = Math.round((Date.now() - ms) / 60000);
  if(m < 1) return 'agora'; if(m < 60) return `há ${m} min`;
  const h = Math.round(m / 60); if(h < 24) return `há ${h} h`;
  const d = new Date(ms); return `em ${pad2(d.getDate())}/${pad2(d.getMonth()+1)}`;
}
async function renderConta(){
  const st = $('#g-status'); if(!st) return;
  const c = gConta(), btn = $('#g-conectar'), op = $('#g-opcoes');
  const cfg = _pushCfg || await pushConfig().catch(() => ({}));
  if(!cfg.google && !gConectado()){
    st.textContent = cfg.offline ? 'Sem internet agora' : 'Ainda não configurado no servidor (veja o guia)';
    btn.classList.add('hidden'); op.classList.add('hidden'); return;
  }
  if(cfg.google && !gConectado()) gCarregarGIS().catch(() => {});   // pré-carrega: a janela do Google abre no toque
  btn.classList.toggle('hidden', gConectado());
  op.classList.toggle('hidden', !gConectado());
  if(c && c.expirado){ st.textContent = 'O acesso expirou — toque em Conectar'; st.style.color = 'var(--due)'; btn.textContent = 'Conectar'; return; }
  st.style.color = '';
  if(!gConectado()){ st.textContent = 'Agenda Plantaê! no Google e backup automático'; btn.textContent = 'Conectar'; return; }
  st.textContent = 'Conectado' + (c.email ? ' como ' + c.email : '') + (c.sessao ? ' · pedirá login de novo em 1 h' : '');
  $('#g-agenda').classList.toggle('on', c.agenda !== false);
  $('#g-drive').classList.toggle('on', c.drive !== false);
  const sa = gLer('plantoes:gcalSync', {}), sd = gLer('plantoes:gdrive', {});
  const linhaA = !gTemEscopo(G_ESC_AGENDA) ? 'Agenda: sem permissão — desconecte e conecte marcando a agenda'
    : c.agenda === false ? 'Agenda: desligada'
    : _gSyncRodando ? 'Agenda: sincronizando…'
    : sa.erro && (sa.erroEm||0) > (sa.em||0) ? 'Agenda: ' + sa.erro
    : sa.em ? `Agenda: ${sa.n} evento${sa.n===1?'':'s'} na agenda Plantaê! · ${haQuanto(sa.em)}` : 'Agenda: ainda não sincronizada';
  const linhaD = !gTemEscopo(G_ESC_DRIVE) ? 'Drive: sem permissão — desconecte e conecte marcando o Drive'
    : c.drive === false ? 'Drive: desligado'
    : _gBkRodando ? 'Drive: enviando backup…'
    : sd.erro && (sd.erroEm||0) > (sd.em||0) ? 'Drive: ' + sd.erro
    : sd.em ? `Drive: último backup ${haQuanto(sd.em)}` : 'Drive: nenhum backup ainda';
  $('#g-agenda-st').textContent = linhaA;
  $('#g-drive-st').textContent = linhaD;
}

document.addEventListener('click', async e => {
  if(e.target.closest('#g-conectar')){ gConectar(); return; }
  if(e.target.closest('#g-sair')){ twoStep(e.target.closest('#g-sair'), gDesconectar); return; }
  if(e.target.closest('#g-sync')){
    const b = e.target.closest('#g-sync'); b.disabled = true;
    try{
      await gConferirEscopos(); renderConta();
      if(!gTemEscopo(G_ESC_AGENDA) && !gTemEscopo(G_ESC_DRIVE)){ toast('O Google não deu permissão de Agenda nem de Drive — Desconectar e Conectar de novo marcando as caixas'); b.disabled = false; return; }
      const r = await gSincronizarAgenda({ completo: true });
      await gBackupDrive({ forcar: true }).catch(() => {});
      toast(r ? `Agenda em dia · ${r.gravados} enviado${r.gravados===1?'':'s'}, ${r.apagados} removido${r.apagados===1?'':'s'}` : 'Sincronizado');
    }catch(err){ toast(err.message); }
    b.disabled = false; return;
  }
  if(e.target.closest('#g-restaurar')){
    try{ abrirRestaurarDrive(await gListarBackups()); }catch(err){ toast(err.message); }
    return;
  }
  const bk = e.target.closest('[data-gbk]');
  if(bk){ twoStep(bk, () => gRestaurar(bk.dataset.gbk, bk)); return; }
  const tg = e.target.closest('#g-agenda, #g-drive');
  if(tg){   // a classe "on" já foi trocada pelo manipulador geral dos toggles
    const c = gConta(); if(!c) return;
    const on = tg.classList.contains('on');
    gSalvarConta({ ...c, [tg.id === 'g-agenda' ? 'agenda' : 'drive']: on });
    if(on) gSincronizarTudo({});
    renderConta();
  }
});

/* ================= Trava com digital / rosto =================
   Usa a verificação do próprio celular pela WebAuthn (a mesma das passkeys): o app
   cadastra uma credencial só deste aparelho e pede a verificação ao abrir ou voltar.
   É uma trava de privacidade — os dados continuam neste aparelho, sem criptografia.
   Saída de emergência: "Cadastrar de novo" também exige a trava de tela do celular.  */
const TRAVA_KEY = 'plantoes:trava';                     // {id (base64url), tempo (ms)}
let _travaSaiu = 0, _travaPedindo = false, _travaAbertaAoSair = false;
const travaCfg = () => gLer(TRAVA_KEY, null);
const travaSuportada = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
const b64urlDe = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const aleatorio = n => crypto.getRandomValues(new Uint8Array(n));

async function travaCadastrar(){
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Plantaê!', id: location.hostname },
    user: { id: aleatorio(16), name: 'plantae', displayName: 'Plantaê! (trava do app)' },
    challenge: aleatorio(32),
    pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
    authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'discouraged' },
    timeout: 60000, attestation: 'none',
  }});
  if(!cred) throw new Error('cadastro cancelado');
  return b64urlDe(cred.rawId);
}
async function travaVerificar(){
  const c = travaCfg(); if(!c) return true;
  const r = await navigator.credentials.get({ publicKey: {
    challenge: aleatorio(32), rpId: location.hostname, timeout: 60000, userVerification: 'required',
    allowCredentials: [{ type:'public-key', id: b64url(c.id) }],
  }});
  return !!r;
}
const estaTravado = () => document.documentElement.classList.contains('travado');
function travar(){
  if(!travaCfg()) return;
  document.documentElement.classList.add('travado');
  const m = $('#trava-msg'); if(m) m.textContent = 'Toque para desbloquear';
}
function destravar(){ document.documentElement.classList.remove('travado'); }
// auto = pedido feito sozinho ao abrir/voltar; se o navegador exigir um toque, só espera o botão
async function pedirDesbloqueio(auto){
  if(_travaPedindo) return; _travaPedindo = true;
  const msg = $('#trava-msg');
  try{
    if(await travaVerificar()){ destravar(); haptic(10); }
  }catch(e){
    if(auto && (!e || e.name === 'NotAllowedError' || e.name === 'SecurityError')){ msg.textContent = 'Toque em Desbloquear'; }
    else { msg.textContent = 'Não foi possível confirmar. Tente de novo.'; $('#trava-recad').hidden = false; }
  }finally{ _travaPedindo = false; }
}
async function recadastrarTrava(){
  try{
    const id = await travaCadastrar();                 // exige a trava de tela do celular
    gGravar(TRAVA_KEY, { ...travaCfg(), id });
    destravar(); toast('Trava cadastrada de novo');
  }catch(e){ $('#trava-msg').textContent = 'Cadastro cancelado — tente de novo.'; }
}
function renderTrava(){
  const t = $('#trava-on'); if(!t) return;
  const c = travaCfg();
  t.classList.toggle('on', !!c);
  $('#trava-tempo-wrap').classList.toggle('hidden', !c);
  if(c) $('#trava-tempo').value = String(c.tempo ?? 300000);
  $('#trava-hint').textContent = travaSuportada()
    ? 'Usa a trava do próprio celular (digital, rosto ou PIN). O celular pode mostrar a trava como uma "chave de acesso" do Plantaê! — é ela que guarda a verificação.'
    : 'Este navegador não oferece verificação por digital ou rosto.';
  t.classList.toggle('desab', !travaSuportada());
}
document.addEventListener('click', async e => {
  if(e.target.closest('#trava-btn')){ pedirDesbloqueio(false); return; }
  if(e.target.closest('#trava-recad')){ recadastrarTrava(); return; }
  const t = e.target.closest('#trava-on'); if(!t) return;
  if(!travaSuportada()){ t.classList.remove('on'); toast('Verificação por digital ou rosto não disponível aqui'); return; }
  if(t.classList.contains('on')){
    try{ const id = await travaCadastrar(); gGravar(TRAVA_KEY, { id, tempo: 300000 }); haptic(12); toast('Trava ligada'); }
    catch(err){ t.classList.remove('on'); toast('Trava não ligada — cadastro cancelado'); }
  } else {
    // desligar também pede a verificação: quem pegou o celular desbloqueado não desliga a trava
    t.classList.add('on');
    try{ if(await travaVerificar()){ gGravar(TRAVA_KEY, null); t.classList.remove('on'); toast('Trava desligada'); } }
    catch(err){ toast('Não confirmado — a trava continua ligada'); }
  }
  renderTrava();
});
document.addEventListener('change', e => {
  if(e.target.id !== 'trava-tempo') return;
  const c = travaCfg(); if(c) gGravar(TRAVA_KEY, { ...c, tempo: +e.target.value });
});
document.addEventListener('visibilitychange', () => {
  const c = travaCfg(); if(!c) return;
  if(document.hidden){
    if(_travaPedindo) return;                         // a própria janela de digital esconde o app
    _travaAbertaAoSair = !estaTravado();
    _travaSaiu = Date.now();
    document.documentElement.classList.add('travado');   // a miniatura dos apps recentes não mostra valores
  } else if(estaTravado() && !_travaPedindo){
    if(_travaAbertaAoSair && Date.now() - _travaSaiu < (c.tempo ?? 300000)) destravar();
    else { travar(); pedirDesbloqueio(true); }
    _travaAbertaAoSair = false;
  }
});

/* ---------- início ---------- */
(function iniciarConta(){
  if(travaCfg()){ travar(); setTimeout(() => pedirDesbloqueio(true), 350); }
  renderTrava();
  renderConta();
  // ao abrir: confere a agenda (completa 1×/dia) e faz backup se o último tem mais de 12 h
  setTimeout(() => {
    if(!gConectado()) return;
    gConferirEscopos().then(() => {
      renderConta();
      gSincronizarAgenda().catch(() => {});
      const sd = gLer('plantoes:gdrive', {});
      if(Date.now() - (sd.em || 0) > 12 * 3600000) gBackupDrive().catch(() => {});
    });
  }, 3000);
})();
