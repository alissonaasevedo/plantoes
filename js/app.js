/* ================= armazenamento =================
   Dentro do Claude usa window.storage (sincroniza celular + PC pela conta).
   Fora dele, guarda no próprio navegador.                                  */
const KEY = 'plantoes:v2';
const KEY_OLD = 'plantoes:v1';
const hasCloud = typeof window.storage !== 'undefined' && !!window.storage;

async function lerNuvem(k){
  if(!hasCloud) return null;
  try{ const r = await window.storage.get(k); const d = r ? JSON.parse(r.value) : null;
       return (d && Array.isArray(d.shifts)) ? d : null; }catch(e){ return null; }
}
function lerLocal(k){
  try{ const v = localStorage.getItem(k); const d = v ? JSON.parse(v) : null;
       return (d && Array.isArray(d.shifts)) ? d : null; }catch(e){ return null; }
}

const store = {
  // procura em todas as origens: nuvem atual, nuvem antiga, navegador atual, navegador antigo
  async load(){
    return (await lerNuvem(KEY)) || (await lerNuvem(KEY_OLD)) || lerLocal(KEY) || lerLocal(KEY_OLD);
  },
  // grava nos dois lugares — se um falhar, o outro segura
  async save(data){
    if(data && !data.v) data.v = SCHEMA;          // carimba a versão do formato
    try{ registrarHistorico(data); }catch(e){ registrarErro(e, 'histórico'); }
    const txt = JSON.stringify(data);
    let ok = false;
    if(hasCloud){ try{ await window.storage.set(KEY, txt); ok = true; }catch(e){} }
    try{ localStorage.setItem(KEY, txt); ok = true; }catch(e){}
    if(!ok) toast('Não consegui salvar');
    else if(typeof aposSalvarConta === 'function') aposSalvarConta();   // Google Agenda/Drive (conta.js)
    return ok;
  }
};

/* ================= diagnóstico =================
   Guarda os erros que acontecem no aparelho (últimos 50) para você copiar e
   me enviar — hoje eu só vejo erros no meu ambiente de teste. Fica no topo
   do arquivo para capturar até erros durante a abertura do app.            */
const APP_VERSAO = '1.32', DIAG_KEY = 'plantoes:diag';
function registrarErro(err, onde){
  try{
    let lista = []; try{ lista = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); }catch(e){}
    const msg = String((err && (err.message || (err.reason && err.reason.message))) || err || 'erro desconhecido').slice(0, 300);
    const stack = String((err && err.stack) || '').split('\n').slice(0, 4).map(l=>l.trim()).join(' | ').slice(0, 600);
    const ult = lista[lista.length-1];
    if(ult && ult.msg === msg && ult.onde === (onde||'')){ ult.n = (ult.n||1) + 1; ult.em = new Date().toISOString(); }
    else lista.push({ em: new Date().toISOString(), v: APP_VERSAO, msg, onde: onde||'', stack, aba: (()=>{ try{ return view; }catch(e){ return ''; } })(), n: 1 });
    localStorage.setItem(DIAG_KEY, JSON.stringify(lista.slice(-50)));
  }catch(e){}
}
window.addEventListener('error', e => registrarErro(e.error || e.message, `${String(e.filename||'').split('/').pop()}:${e.lineno||0}`));
window.addEventListener('unhandledrejection', e => registrarErro(e.reason, 'promessa'));

const CORES = ['#FFC24D','#4ECFA0','#8B9DFF','#FF7A93','#5FC8EC','#C48BF5','#F79E5C','#93D95F'];

let S = { shifts: [], locais: [], bloqueios: [] };
let cursor = new Date();
let view = 'mes';
let filter = 'all';
let editing = null, editingLocal = null, valorTouched = false, vencTouched = false, corSel = CORES[0];
let liqTouched = false, conflitoOk = false;
let viewTipo = 'lista', diaAtual = new Date();

/* ================= utilidades ================= */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
// sistema do aparelho (textos e caminhos de configuração mudam entre iPhone e Android)
const SO = /Android/i.test(navigator.userAgent) ? 'android'
         : (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) ? 'ios' : 'outro';
// vibração: o iPhone ignora; no Android funciona — mínimo de 10ms para ser perceptível, com opção de desligar
const haptic = (ms=8) => { try{ if(localStorage.getItem('plantoes:vibrar') === '0') return; navigator.vibrate && navigator.vibrate(Math.max(10, ms)); }catch(e){} };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const brl = n => (n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
const WD = ['dom','seg','ter','qua','qui','sex','sáb'];
const MES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

const parseDate = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
const iso = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const hoje = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const sameMonth = (s,ref) => { const d = parseDate(s); return d.getMonth()===ref.getMonth() && d.getFullYear()===ref.getFullYear(); };
const ehResid   = s => s.categoria === 'residencia';
const ehBolsa   = s => s.categoria === 'bolsa';
const ehAmb     = s => s.categoria === 'ambulatorio';
const ehBloq    = s => s.categoria === 'bloqueio';
const counts  = sh => sh.tipo !== 'passei' && !ehResid(sh) && !ehBloq(sh); // entra no financeiro
const naAgenda = sh => sh.tipo !== 'passei' && !ehBolsa(sh);                // ocupa o seu tempo (inclui bloqueio)

// dias úteis: fim de semana rola para a frente (feriado não é considerado)
const ehUtil = d => d.getDay() !== 0 && d.getDay() !== 6;
function proximoUtil(d){ const x = new Date(d); while(!ehUtil(x)) x.setDate(x.getDate()+1); return x; }
function anteriorUtil(d){ const x = new Date(d); while(!ehUtil(x)) x.setDate(x.getDate()-1); return x; }
function nEsimoUtil(y, m, n){
  const d = new Date(y, m, 1); let c = 0;
  while(true){ if(ehUtil(d)){ c++; if(c === n) return new Date(d); } d.setDate(d.getDate()+1); }
}
const bru = s => +s.valor || 0;
const liq = s => (s.liquido !== undefined && s.liquido !== null && s.liquido !== '') ? (+s.liquido||0) : bru(s);
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const getLocal = id => S.locais.find(x=>x.id===id) || null;
const localName = id => (getLocal(id)||{}).nome || 'Sem local';
const localCor = id => (getLocal(id)||{}).cor || '#8B9DFF';

const PAGMES = ['no mesmo mês','no mês seguinte','dois meses depois'];

// data prevista de pagamento: override manual, senão a regra do local
function vencimento(s){
  if(s.venc) return s.venc;
  const l = getLocal(s.localId);
  const add = (l && typeof l.pagMes === 'number') ? l.pagMes : 1;
  const d = parseDate(s.data);
  const y = d.getFullYear(), m = d.getMonth() + add;
  const ultimo = new Date(y, m+1, 0).getDate();   // 31 vira 28/30 em meses curtos
  // sem dia certo: referência é o fim do mês previsto, para não acusar atraso cedo demais
  if(l && l.pagIncerto) return iso(anteriorUtil(new Date(y, m, ultimo)));
  const dia = (l && l.pagDia) || 10;
  return iso(proximoUtil(new Date(y, m, Math.min(dia, ultimo))));
}
// quando o dinheiro encosta na conta: real se já pago, previsto se não
const dataCaixa = s => (s.pago && s.pagoEm) ? s.pagoEm : vencimento(s);
// true quando a data é só uma referência de mês, não um dia combinado
const vencIncerto = s => !s.venc && !!(getLocal(s.localId)||{}).pagIncerto;

function fim(hora,dur){
  if(!hora) return '';
  const [h,m] = hora.split(':').map(Number);
  const t = (h + Number(dur)) % 24;
  return String(t).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function mapsUrl(l){
  if(!l) return null;
  const q = [l.endereco, l.cidade].filter(Boolean).join(', ') || [l.nome, l.cidade].filter(Boolean).join(', ');
  if(!l.endereco && !l.cidade) return null;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}
const ICON_SUN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFC24D" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2 12h2M20 12h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/></svg>';
const ICON_MOON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8B9DFF" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>';
const ICON_PIN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';
const ICON_CHEV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>';

const ICON_CAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

/* ================= calendário (Google / Apple) ================= */
const pad2 = n => String(n).padStart(2,'0');

function evJanela(s){
  const d = parseDate(s.data);
  const [h,mi] = (s.hora||'07:00').split(':').map(Number);
  const ini = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h||0, mi||0);
  const f = new Date(ini.getTime() + (Number(s.duracao)||12)*3600000);
  return { ini, f };
}
const stampLocal = d => `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
const stampUTC = d => d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');

// "Plantão noturno da residência" (ou diurno) — nome usado na agenda, nos avisos e na lista
const nomeResid = s => `Plantão ${s.turno === 'diurno' ? 'diurno' : 'noturno'} da residência`;
function evTitulo(s){ return (ehResid(s) ? nomeResid(s) + ' · ' : ehAmb(s) ? 'Consultório · ' : 'Plantão · ') + localName(s.localId); }
function evLocal(s){
  const l = getLocal(s.localId); if(!l) return '';
  return [l.endereco, l.cidade].filter(Boolean).join(', ') || [l.nome, l.cidade].filter(Boolean).join(', ');
}
function evDetalhe(s){
  const p = [`${s.duracao}h · ${s.turno}`];
  if(ehResid(s)) p.push('Obrigatório da residência, sem remuneração');
  else if(liq(s)) p.push(brl(liq(s)));
  if(s.tipo==='peguei') p.push('Peguei de '+(s.colega||'colega'));
  if(s.tipo==='passei') p.push('Passei para '+(s.colega||'colega'));
  if(s.obs) p.push(s.obs);
  return p.join(' — ');
}

function urlGoogle(s){
  const {ini,f} = evJanela(s);
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action','TEMPLATE');
  u.searchParams.set('text', evTitulo(s));
  u.searchParams.set('dates', stampUTC(ini)+'/'+stampUTC(f));
  u.searchParams.set('details', evDetalhe(s));
  u.searchParams.set('location', evLocal(s));
  return u.toString();
}

const icsEsc = t => String(t||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
function dobra(linha){
  let out = '', c = linha;
  while(c.length > 73){ out += c.slice(0,73)+'\r\n '; c = c.slice(73); }
  return out + c;
}
function vevento(s){
  const {ini,f} = evJanela(s);
  return [
    'BEGIN:VEVENT',
    'UID:'+s.id+'@plantoes.app',
    'DTSTAMP:'+stampUTC(new Date()),
    'DTSTART:'+stampLocal(ini),
    'DTEND:'+stampLocal(f),
    dobra('SUMMARY:'+icsEsc(evTitulo(s))),
    dobra('LOCATION:'+icsEsc(evLocal(s))),
    dobra('DESCRIPTION:'+icsEsc(evDetalhe(s))),
    'BEGIN:VALARM','TRIGGER:-PT1H','ACTION:DISPLAY','DESCRIPTION:Plantão em 1 hora','END:VALARM',
    // horário absoluto: mais compatível com o Calendário do iPhone do que RELATED=END
    'BEGIN:VALARM','TRIGGER;VALUE=DATE-TIME:'+stampUTC(new Date(f.getTime() - 30*60000)),'ACTION:DISPLAY','DESCRIPTION:Plantão termina em 30 min','END:VALARM',
    'END:VEVENT'
  ].join('\r\n');
}
function baixarIcs(lista, nome){
  if(!lista.length){ toast('Nada para exportar'); return; }
  const txt = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Plantoes//PT-BR//','CALSCALE:GREGORIAN','METHOD:PUBLISH',
               ...lista.map(vevento),'END:VCALENDAR'].join('\r\n');
  baixarBlob(new Blob([txt], {type:'text/calendar;charset=utf-8'}), nome);
  toast(lista.length>1 ? `${lista.length} eventos gerados` : 'Evento gerado');
}

let calAlvo = null;
function openCal(s){
  if(!s) return;
  calAlvo = s;
  const {ini,f} = evJanela(s);
  $('#c-info').innerHTML = `<div class="swatch" style="background:${localCor(s.localId)}"></div>
    <div class="txt"><b>${esc(localName(s.localId))}</b>
      <small>${WD[ini.getDay()]}, ${pad2(ini.getDate())}/${pad2(ini.getMonth()+1)} · ${pad2(ini.getHours())}:${pad2(ini.getMinutes())} → ${pad2(f.getHours())}:${pad2(f.getMinutes())}</small></div>`;
  $('#c-apple').textContent = SO === 'android' ? 'Calendário Samsung · arquivo .ics' : SO === 'ios' ? 'Calendário do iPhone · arquivo .ics' : 'Arquivo .ics (Outlook, Apple, Samsung)';
  $('#sheet3').classList.add('open'); $('#scrim').classList.add('open');
  lockScroll();
}

let toastT;
function toast(msg, acao){
  const t = $('#toast');
  t.textContent = '';
  const sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
  if(acao){
    const b = document.createElement('button');
    b.className = 'toast-act'; b.textContent = acao.label;
    b.onclick = ()=>{
      if(!t.classList.contains('on')) return;         // aviso já sumiu: nada de desfazer escondido
      clearTimeout(toastT); t.classList.remove('on'); t.classList.remove('has-act'); acao.fn();
    };
    t.appendChild(b);
  }
  t.classList.toggle('has-act', !!acao);
  t.classList.add('on');
  // mensagens longas (conflitos) ficam mais tempo; com ação, 5s para dar tempo de desfazer
  const dur = acao ? 5500 : Math.min(5000, Math.max(1900, msg.length * 55));
  clearTimeout(toastT); toastT = setTimeout(()=>{ t.classList.remove('on'); t.classList.remove('has-act'); }, dur);
}

// Exclusões são imediatas e reversíveis: guarda uma cópia antes de mudar e
// oferece "Desfazer" no aviso. Substitui o "toque de novo para confirmar".
async function comDesfazer(msg, mutar){
  const antes = JSON.stringify(S);
  mutar();
  await store.save(S); render();
  haptic(10);
  toast(msg, { label:'Desfazer', fn: async ()=>{
    // sheet aberto apontaria para objetos da versão antiga de S
    if(document.querySelector('.sheet.open')) closeSheets();
    S = normalize(JSON.parse(antes));
    _histRotulo = 'Desfez';
    _liveEstado = '';                 // força remontar o painel do plantão
    await store.save(S); render(); haptic(6); toast('Desfeito');
  }});
}


/* ── Celebração de pagamento ── */
function confettiPay(valor){
  const cvs = $('#pay-canvas');
  cvs.style.display = 'block';
  const ctx = cvs.getContext('2d');
  cvs.width  = window.innerWidth;
  cvs.height = window.innerHeight;
  const COR = ['#6366F1','#34D399','#FBBF24','#F472B6','#60A5FA','#A78BFA'];
  const N = 80;
  const parts = Array.from({length:N}, ()=>({
    x: Math.random()*cvs.width,
    y: cvs.height * (.2 + Math.random()*.3),
    r: 4 + Math.random()*5,
    c: COR[Math.floor(Math.random()*COR.length)],
    vx: (Math.random()-.5)*6,
    vy: -(6 + Math.random()*8),
    rot: Math.random()*360,
    drot: (Math.random()-.5)*12,
    alpha: 1,
    shape: Math.random()>.4 ? 'rect' : 'circle',
  }));
  let frame;
  const dur = 1800; const ini = performance.now();
  function step(now){
    const t = Math.min((now-ini)/dur, 1);
    ctx.clearRect(0,0,cvs.width,cvs.height);
    for(const p of parts){
      p.x  += p.vx;
      p.vy += .25;      // gravidade
      p.y  += p.vy;
      p.rot+= p.drot;
      p.alpha = Math.max(0, 1 - t*1.4);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI/180);
      ctx.fillStyle = p.c;
      if(p.shape==='circle'){ ctx.beginPath(); ctx.arc(0,0,p.r,0,Math.PI*2); ctx.fill(); }
      else { ctx.fillRect(-p.r, -p.r*.5, p.r*2, p.r); }
      ctx.restore();
    }
    if(t < 1) frame = requestAnimationFrame(step);
    else { cvs.style.display='none'; ctx.clearRect(0,0,cvs.width,cvs.height); }
  }
  frame = requestAnimationFrame(step);

  // flash verde no fundo
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;inset:0;background:rgba(52,211,153,.12);z-index:9998;pointer-events:none;animation:flashPay .45s ease forwards';
  document.body.appendChild(flash);
  setTimeout(()=>flash.remove(), 500);
}

// valor principal com cifrão menor ("R$" pequeno, número grande)
function heroSet(el, v){
  const m = /^R\$\s?(.*)$/.exec(v);
  if(m) el.innerHTML = '<span class="cifrao">R$</span>' + m[1]; else el.textContent = v;
}

/* ================= render ================= */
function render(){
  const titles = { mes: MES[cursor.getMonth()]+' '+cursor.getFullYear(), caixa:'Caixa · '+MES[cursor.getMonth()],
                   resumo:'Resumo', locais:'Locais', ajustes:'Ajustes' };
  $('#title').textContent = titles[view];
  const noMesAtual = sameMonth(iso(new Date()), cursor);
  document.querySelectorAll('.mn-hoje').forEach(b => b.classList.toggle('atual', noMesAtual));
  const ilMes=$('#il-mes'); if(ilMes) ilMes.textContent=MES[cursor.getMonth()]+' '+cursor.getFullYear();
  const ilCx=$('#il-caixa'); if(ilCx) ilCx.textContent='Caixa · '+MES[cursor.getMonth()];
  $('#mnav').classList.toggle('hidden', view !== 'mes' && view !== 'caixa');
  // só a aba visível é redesenhada (antes eram as 5, com gráficos, a cada toque);
  // trocar de aba chama render() de novo e desenha a nova
  ({ mes:renderMes, caixa:renderCaixa, resumo:renderResumo, locais:renderLocais, ajustes:renderAjustes })[view]();
  aplicarPaleta();
  renderLive();
  renderSaude();
  atualizaQuickBanner();
  agendarNotificacoes();
}

function mesData(){
  return S.shifts.filter(s=>sameMonth(s.data,cursor))
                 .sort((a,b)=>a.data.localeCompare(b.data) || (a.hora||'').localeCompare(b.hora||''));
}

function renderMes(){
  const list = mesData();
  const mine = list.filter(counts);
  const total = mine.reduce((a,s)=>a+liq(s),0);
  const bruto = mine.reduce((a,s)=>a+bru(s),0);
  const horas = mine.reduce((a,s)=>a+(+s.duracao||0),0);
  const hResid = list.filter(ehResid).reduce((a,s)=>a+(+s.duracao||0),0);

  // HERO: caixa do mês — o que entra na conta, não o que foi trabalhado
  const todosFinanc = S.shifts.filter(counts);
  const noMesCx = todosFinanc.filter(s=>{
    const d = parseDate(dataCaixa(s));
    return d.getMonth()===cursor.getMonth() && d.getFullYear()===cursor.getFullYear();
  }).sort((a,b)=>dataCaixa(a).localeCompare(dataCaixa(b)));
  const cxRec  = noMesCx.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0);
  const cxPrev = noMesCx.filter(s=>!s.pago).reduce((a,s)=>a+liq(s),0);
  const cxTot  = cxRec + cxPrev;

  // sparkline animada dos últimos 6 meses até o cursor
  (function(){
    // usa cursor como referência, não "hoje" — assim a curva muda ao navegar entre meses
    const sm=[];
    for(let i=5;i>=0;i--){
      const ref=new Date(cursor.getFullYear(),cursor.getMonth()-i,1);
      sm.push({y:ref.getFullYear(),m:ref.getMonth()});
    }
    const sv=sm.map(m=>S.shifts.filter(s=>counts(s)&&parseDate(dataCaixa(s)).getMonth()===m.m&&parseDate(dataCaixa(s)).getFullYear()===m.y).reduce((a,s)=>a+liq(s),0));
    const mx=Math.max(...sv,1); const W=64,H=20;
    const pts=sv.map((v,i)=>`${(i/(sv.length-1)*W).toFixed(1)},${(H-2-v/mx*(H-4)).toFixed(1)}`).join(' ');
    const lastY=(H-2-sv[sv.length-1]/mx*(H-4)).toFixed(1);
    const temDados=sv.some(v=>v>0);

    // calcular comprimento da polyline para a animação
    function polylineLen(pts){
      const pairs=pts.split(' ').map(p=>p.split(',').map(Number));
      let len=0;
      for(let i=1;i<pairs.length;i++){
        const dx=pairs[i][0]-pairs[i-1][0], dy=pairs[i][1]-pairs[i-1][1];
        len+=Math.sqrt(dx*dx+dy*dy);
      }
      return len;
    }

    const svg=temDados?`<svg id="spark-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
        style="vertical-align:middle;margin-left:7px;flex:none;overflow:visible">
      <defs>
        <linearGradient id="spark-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <polyline id="spark-line" points="${pts}"
        fill="none" stroke="url(#spark-fade)" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
      <circle id="spark-dot" cx="${W}" cy="${lastY}" r="0"
        fill="var(--accent)" opacity="0"/>
    </svg>`:'' ;

    const lbl=$('#h-lbl-caixa');
    lbl.style.display='flex'; lbl.style.alignItems='center';
    lbl.innerHTML='Entra em '+MES[cursor.getMonth()]+svg;

    if(!temDados) return;

    // animar a linha (stroke-dashoffset draw) + pulso no ponto final
    requestAnimationFrame(()=>{
      const line=document.getElementById('spark-line');
      const dot =document.getElementById('spark-dot');
      if(!line||!dot) return;

      const len=Math.ceil(polylineLen(pts));
      line.style.strokeDasharray=len;
      line.style.strokeDashoffset=len;

      const dur=520; const ini=performance.now();
      const ease=t=>t<.5?2*t*t:(4-2*t)*t-1;
      function step(now){
        const t=Math.min((now-ini)/dur,1);
        const prog=ease(t);
        line.style.strokeDashoffset=len*(1-prog);
        if(t>=1){
          // pulso no ponto final após a linha terminar
          dot.style.opacity='1';
          dot.setAttribute('r','2.5');
          let pr=2.5, growing=true;
          let pulsos=0;
          function pulsar(){
            if(pulsos>=2) return;
            const pDur=300; const pIni=performance.now();
            function pStep(now2){
              const pt=Math.min((now2-pIni)/pDur,1);
              const r=growing ? 2.5+1.5*Math.sin(pt*Math.PI) : 2.5;
              dot.setAttribute('r',r.toFixed(2));
              if(pt<1) requestAnimationFrame(pStep);
              else { pulsos++; if(pulsos<2) requestAnimationFrame(pulsar); }
            }
            requestAnimationFrame(pStep);
          }
          setTimeout(pulsar,80);
        } else requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  })();
  (function animarHero(alvo){
    const el=$('#h-total');
    // dataset.valor armazena SEMPRE como número puro (sem formatação BRL)
    const mesKey = cursor.getFullYear()+'-'+cursor.getMonth();
    if(el.dataset.mesKey !== mesKey){
      // mês mudou: zera visual imediatamente E reseta o ponto de partida
      el.dataset.mesKey = mesKey;
      el.dataset.valor = '0';
      el.dataset.real = brl(0);
      if(!saldoOculto) heroSet(el, brl(0));
    }
    // parseFloat direto — dataset.valor é número puro, sem separadores BRL
    const anterior = parseFloat(el.dataset.valor) || 0;
    if(anterior === alvo){ el.dataset.real=brl(alvo); if(!saldoOculto) heroSet(el, brl(alvo)); return; }
    el.dataset.valor = String(alvo);
    const dur=480,ini=performance.now();
    const ease=t=>t<.5?2*t*t:(4-2*t)*t-1;
    function step(now){
      const t=Math.min((now-ini)/dur,1);
      const v=brl(Math.round(anterior+(alvo-anterior)*ease(t)));
      if(!saldoOculto) heroSet(el, v); else el.dataset.real=v;
      if(t<1)requestAnimationFrame(step);
      else { el.dataset.real=brl(alvo); if(!saldoOculto) heroSet(el, brl(alvo)); }
    }
    requestAnimationFrame(step);
  })(cxTot);
  const partesSub = [];
  if(noMesCx.length) partesSub.push(`${noMesCx.length} entrada${noMesCx.length>1?'s':''}`);
  if(total) partesSub.push(`faturado ${brl(total)}`);
  if(hResid) partesSub.push(`+${hResid}h residência`);
  // carga vs média histórica (vai para a faixa de métricas)
  const todosPlantoes = S.shifts.filter(counts);
  const mesesComDados = [...new Set(todosPlantoes.map(s=>s.data.slice(0,7)))].length;
  const mediaHoras = mesesComDados > 1 ? Math.round(
    todosPlantoes.reduce((a,s)=>a+(+s.duracao||0),0) / mesesComDados
  ) : 0;
  const pctCarga = mediaHoras && horas ? Math.round(horas/mediaHoras*100) : 0;
  // comparativo com o mês anterior, numa linha própria e sem ambiguidade
  // (antes: "263% da média ↓ R$ 2.240 vs setembro" parecia dizer que a média caiu)
  const mesAnt = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1);
  const cxAnt = S.shifts.filter(counts).filter(s=>{
    const d=parseDate(dataCaixa(s));
    return d.getMonth()===mesAnt.getMonth() && d.getFullYear()===mesAnt.getFullYear();
  }).reduce((a,s)=>a+liq(s),0);
  const delta = cxTot - cxAnt;
  const compHtml = (cxAnt && delta) ? `<span class="hs-delta ${delta>0?'up':'down'}">${delta>0?'↑':'↓'} <span class="money-inline">${brl(Math.abs(delta))}</span> ${delta>0?'a mais':'a menos'} que ${MES[mesAnt.getMonth()]}</span>` : '';
  $('#h-sub').innerHTML = esc(partesSub.join(' · ') || 'Nenhum lançamento previsto') + compHtml;
  // ── Barra recebido × a receber (no card principal) ──
  (function(){
    const el = $('#h-progress-ring'); if(!el) return;
    const pct = cxTot ? Math.min(100, Math.round(cxRec/cxTot*100)) : 0;
    el.innerHTML = cxTot ? `<div class="hb" id="sc-recebido" role="button" aria-label="Ver entradas do mês">
        <div class="hb-bar"><i class="hb-ok" style="width:0%" data-w="${pct}"></i></div>
        <div class="hb-leg">
          <span><i class="d ok"></i><b class="money">${brl(cxRec)}</b> recebido</span>
          <span><i class="d am"></i><b class="money">${brl(cxPrev)}</b> a receber</span>
          <em>${pct}%</em>
        </div></div>` : '<div id="sc-recebido"></div>';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{ const b = el.querySelector('.hb-ok'); if(b) b.style.width = b.dataset.w + '%'; }));
  })();

  // ── Grade 2×2 de métricas ──
  (function(){
    // soPlantoes: apenas plantões reais (exclui ambulatório, bolsa, residência, bloqueio, passei)
    const soPlantoes = list.filter(s => counts(s) && !ehAmb(s) && !ehBolsa(s));
    const nPlantoes = soPlantoes.length;
    const nDiurnos  = soPlantoes.filter(s => (s.turno||'diurno') !== 'noturno').length;
    const nNoturnos = soPlantoes.filter(s => s.turno === 'noturno').length;
    const totPlantoes = soPlantoes.reduce((a,s)=>a+liq(s),0);
    const hPlantoes   = soPlantoes.reduce((a,s)=>a+(+s.duracao||0),0);
    const valHora = hPlantoes > 0 ? Math.round(totPlantoes / hPlantoes) : 0;
    const sgEl = $('#h-stat-grid');
    if(!sgEl) return;

    sgEl.innerHTML = `<div class="kpis">
      <button class="kpi" id="sc-plantoes"><b>${nPlantoes}</b><span>plantões</span><small>${nPlantoes ? nDiurnos+'d · '+nNoturnos+'n' : 'nenhum'}</small></button>
      <button class="kpi" id="sc-horas"><b>${hPlantoes}h</b><span>escaladas</span><small>${pctCarga && pctCarga!==100 ? pctCarga+'% da média' : (nPlantoes ? Math.round(hPlantoes/nPlantoes)+'h cada' : '—')}</small></button>
      <button class="kpi kpi-ok" id="sc-receb-kpi"><b class="money">${brl(cxRec)}</b><span>recebido</span><small>${cxTot ? Math.round(cxRec/cxTot*100)+'% do previsto' : '—'}</small></button>
      <button class="kpi" id="sc-ticket"><b class="money">${valHora ? brl(valHora) : '—'}</b><span>por hora</span><small>no mês</small></button>
    </div>`;

    // ── helpers para o sheet de detalhes ──
    function openDetail(title, html){
      delete $('#sd-body').dataset.saude;
      $('#sd-title').textContent = title;
      $('#sd-body').innerHTML = html;
      $('#sheet-detail').classList.add('open');
      $('#scrim').classList.add('open');
      lockScroll();
    }

    function rowPlantao(s){
      const d = parseDate(s.data);
      const diaSem = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][d.getDay()];
      const turnoIco = (s.turno==='noturno') ? '🌙' : '☀️';
      const loc = esc(localName(s.localId));
      const dur = s.duracao ? `${s.duracao}h` : '';
      const val = liq(s) ? `<span class="pill pago">${brl(liq(s))}</span>` : '';
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <div style="font-size:20px;line-height:1">${turnoIco}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${loc}</div>
          <div style="font-size:12px;color:var(--dim)">${diaSem} ${pad2(d.getDate())}/${pad2(d.getMonth()+1)} ${dur ? '· '+dur : ''}</div>
        </div>
        ${val}
      </div>`;
    }

    function rowCaixa(s){
      const d = parseDate(dataCaixa(s));
      const loc = esc(localName(s.localId));
      const pago = s.pago;
      const pill = pago
        ? `<span class="pill pago">${brl(liq(s))}</span>`
        : `<span class="pill pend">${brl(liq(s))}</span>`;
      const status = pago ? 'Recebido' : 'Pendente';
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${loc}</div>
          <div style="font-size:12px;color:var(--dim)">${status} · ${pad2(d.getDate())}/${pad2(d.getMonth()+1)}</div>
        </div>
        ${pill}
      </div>`;
    }

    // card: Plantões no mês
    $('#sc-plantoes').onclick = () => {
      const mes = MES[cursor.getMonth()]+' '+cursor.getFullYear();
      const rows = soPlantoes.length
        ? soPlantoes.map(rowPlantao).join('')
        : `<div style="text-align:center;padding:24px 0;color:var(--dim)">Nenhum plantão em ${mes}</div>`;
      openDetail(`Plantões · ${mes}`, rows);
    };

    // card: Horas escaladas (mesma lista, foco diferente)
    $('#sc-horas').onclick = () => {
      const mes = MES[cursor.getMonth()]+' '+cursor.getFullYear();
      const rows = soPlantoes.length
        ? soPlantoes.map(rowPlantao).join('')
        : `<div style="text-align:center;padding:24px 0;color:var(--dim)">Nenhum plantão em ${mes}</div>`;
      openDetail(`Horas · ${mes}`, rows);
    };

    // card: Recebido — todas as entradas de caixa do mês
    $('#sc-recebido').onclick = () => {
      const mes = MES[cursor.getMonth()]+' '+cursor.getFullYear();
      const rows = noMesCx.length
        ? noMesCx.map(rowCaixa).join('')
        : `<div style="text-align:center;padding:24px 0;color:var(--dim)">Nenhuma entrada em ${mes}</div>`;
      openDetail(`Recebido · ${mes}`, rows);
    };
    $('#sc-receb-kpi').onclick = $('#sc-recebido').onclick;

    // card: Valor da hora — lista de plantões com valor e duração
    $('#sc-ticket').onclick = () => {
      const mes = MES[cursor.getMonth()]+' '+cursor.getFullYear();
      const rows = soPlantoes.length
        ? soPlantoes.map(rowPlantao).join('')
        : `<div style="text-align:center;padding:24px 0;color:var(--dim)">Nenhum plantão em ${mes}</div>`;
      openDetail(`Valor da hora · ${mes}`, rows);
    };
  })();

  // tendência de 6 meses: agora só no Resumo (o mesmo dado aparecia duas vezes)
  { const sp = $('#h-sparkline-card'); if(sp) sp.innerHTML = ''; }

  // mini-gauge da meta no hero
  const metaV = S.metaMensal||0;
  const metaEl = $('#h-meta-hero');
  if(metaV && cxTot){
    const pctM = Math.min(100, Math.round(cxTot/metaV*100));
    const r=14, cx2=16, cy2=16, circ=2*Math.PI*r;
    const dash=circ*(pctM/100), gap=circ-dash;
    const corM = cxTot>=metaV?'var(--ok)':'var(--accent)';
    metaEl.innerHTML=`<div style="display:flex;align-items:center;gap:9px;padding:10px 0 4px">
      <svg width="32" height="32" viewBox="0 0 32 32" style="flex:none">
        <circle cx="${cx2}" cy="${cy2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
        <circle cx="${cx2}" cy="${cy2}" r="${r}" fill="none" stroke="${corM}" stroke-width="3"
          stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}" stroke-linecap="round"
          transform="rotate(-90 ${cx2} ${cy2})" style="transition:stroke-dasharray .6s ease"/>
      </svg>
      <div>
        <div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim-2)">Meta mensal</div>
        <div style="font-size:13px;font-weight:700;color:${corM}">${pctM}% · ${cxTot>=metaV?'<span style=color:var(--ok)>batida 🎉</span>':'faltam '+brl(metaV-cxTot)}</div>
      </div>
    </div>`;
  } else {
    metaEl.innerHTML='';
  }

  // badge sequência de metas 🔥
  (function(){
    const el = $('#h-sequencia');
    if(!el) return;
    const meta = S.metaMensal||0;
    if(!meta){ el.style.display='none'; return; }
    // percorrer meses retroativos (máx 24) contando sequência
    let seq = 0;
    const hoje2 = new Date();
    for(let i=1; i<=24; i++){
      const d = new Date(hoje2.getFullYear(), hoje2.getMonth()-i, 1);
      const mRec = S.shifts.filter(counts).filter(s=>{
        const cx = parseDate(dataCaixa(s));
        return cx.getMonth()===d.getMonth() && cx.getFullYear()===d.getFullYear() && s.pago;
      }).reduce((a,s)=>a+liq(s),0);
      if(mRec>=meta) seq++; else break;
    }
    if(seq>=2){
      el.style.display='inline-flex';
      el.innerHTML=`🔥 ${seq} meses na meta`;
    } else {
      el.style.display='none';
    }
  })();

  // ── Streak de pagamentos em dia ──
  (function(){
    const el = $('#h-streak');
    if(!el) return;
    // pega plantões pagos, ordenados pelo mais recente primeiro
    const pagos = S.shifts.filter(s => counts(s) && s.pago && vencimento(s))
      .sort((a,b) => dataCaixa(b).localeCompare(dataCaixa(a)));
    if(!pagos.length){ el.style.display='none'; return; }
    // conta sequência de pagamentos onde pago chegou dentro de 7 dias do vencimento
    let streak = 0;
    for(const s of pagos){
      const venc = parseDate(vencimento(s));
      const cx   = parseDate(dataCaixa(s));
      const diff = Math.round((cx - venc) / 86400000); // positivo = atraso
      if(diff <= 7){ streak++; } else { break; }
    }
    if(streak >= 3){
      el.style.display = 'inline-flex';
      el.innerHTML = `⚡ ${streak} pagos em dia`;
      el.title = `${streak} plantões consecutivos confirmados dentro do prazo`;
    } else {
      el.style.display = 'none';
    }
  })();

  // ── Badge mês pesado ──
  (function(){
    const el = $('#h-fadiga');
    if(!el) return;
    // limiar configurável: S.limiarHoras || 180h por mês
    const limiar = S.limiarHoras || 180;
    const horasTotais = list.reduce((a,s) => a + (+s.duracao||0), 0); // todas as horas do mês
    if(horasTotais >= limiar){
      el.style.display = 'inline-flex';
      el.innerHTML = `⚠️ ${horasTotais}h escaladas`;
      el.title = `Mês com carga acima de ${limiar}h`;
    } else {
      el.style.display = 'none';
    }
  })();

  // checklist compacto de pendências na tela principal
  const pendentes = noMesCx.filter(s=>!s.pago);
  if(pendentes.length > 0){
    const pct = cxTot ? Math.round(cxRec/cxTot*100) : 0;
    $('#h-checklist').innerHTML = `<div style="margin:16px 0 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:12.5px;color:var(--dim)">Confirmações pendentes · ${pct}% recebido</span>
        <span style="font-size:12.5px;font-weight:600;color:var(--dim)">${pendentes.length} de ${noMesCx.length}</span>
      </div>
      ${pendentes.slice(0,4).map(s=>{
        const d=parseDate(dataCaixa(s)); const inc=vencIncerto(s);
        return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer" data-cxpay="${s.id}">
          <div style="width:20px;height:20px;border-radius:6px;border:1.5px solid var(--line-2);background:var(--surface);flex:none;display:grid;place-items:center">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 4.5-5" stroke="var(--dim-2)" stroke-width="1.4" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(localName(s.localId))}</div>
            <div style="font-size:12px;color:var(--dim)">${inc?'previsto em '+MES[d.getMonth()]:pad2(d.getDate())+'/'+pad2(d.getMonth()+1)} · ${brl(liq(s))}</div>
          </div>
          <div class="tag-pend" style="font-size:11px;padding:3px 9px;border-radius:99px;background:rgba(200,56,79,.07);color:var(--due);border:1px solid rgba(200,56,79,.22);flex:none">Pendente</div>
        </div>`;
      }).join('')}
      ${pendentes.length>4?`<div style="text-align:center;padding:8px 0;font-size:12.5px;color:var(--dim)">+${pendentes.length-4} mais · ver na aba Caixa</div>`:''}
    </div>`;
  } else if(noMesCx.length > 0){
    $('#h-checklist').innerHTML = `<div style="text-align:center;padding:12px 0 20px;font-size:14px;color:var(--ok);font-weight:600">✓ Tudo recebido em ${MES[cursor.getMonth()]}</div>`;
  } else {
    $('#h-checklist').innerHTML = '';
  }
  const pago = mine.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0); // mantido para uso na lista

  // ─ banner próxima entrada financeira ─
  // Usa o vencimento real de cada lançamento pendente e soma só o que cai nessa
  // data. Antes somava todos os pendentes do local (ex.: bolsa inteira até 2028)
  // e a data vinha da regra genérica do local, não dos plantões.
  (function(){
    const el = $('#h-banner-prox');
    const t = iso(hoje());
    const pend = S.shifts.filter(s=>counts(s) && !s.pago && vencimento(s) >= t);
    if(!pend.length){ el.style.display = 'none'; return; }
    const prox = pend.map(vencimento).sort()[0];
    const doDia = pend.filter(s=>vencimento(s) === prox);
    const val = doDia.reduce((a,s)=>a+liq(s), 0);
    const dias = Math.round((parseDate(prox) - hoje())/86400000);
    const incerto = doDia.every(vencIncerto);
    const quando = incerto ? `Até o fim de ${MES[parseDate(prox).getMonth()]}`
                 : dias===0 ? 'Hoje' : dias===1 ? 'Amanhã' : `Em ${dias} dias`;
    const locais = [...new Set(doDia.map(s=>localName(s.localId)))];
    const de = locais.length === 1 ? ` · ${esc(locais[0])}` : ` · ${locais.length} fontes`;
    el.style.display = 'block';
    el.innerHTML = `${quando} · <span>${brl(val)}</span> a receber${de}`;
  })();

  renderNext();
  renderCal(list);
  renderDia();
  renderSemana();

  const shown = filter==='due' ? list.filter(s=>counts(s) && !s.pago) : list.filter(s => !ehBolsa(s));
  $('#list-count').textContent = filter==='due' ? 'Pendentes de pagamento' : 'Plantões do mês';

  const el = $('#shift-list');
  if(!shown.length){
    el.innerHTML = list.length
      ? `<div class="empty">${filter==='due' ? 'Tudo recebido neste mês.' : 'Nenhum plantão neste mês — só entradas fixas.'}</div>`
      : `<div class="empty">Mês em branco.<br>Toque em + ou em um dia do calendário para lançar.</div>`;
    return;
  }
  // anima a entrada só ao trocar de mês/filtro — não a cada toque em "Pago"
  const listKey = cursor.getFullYear()+'-'+cursor.getMonth()+'-'+filter;
  const animar = el.dataset.k !== listKey; el.dataset.k = listKey;
  // grupos por semana (domingo a sábado), com o resumo da semana no cabeçalho
  const semanas = new Map();
  shown.forEach(s => { const k = iso(domingoSemana(parseDate(s.data))); if(!semanas.has(k)) semanas.set(k, []); semanas.get(k).push(s); });
  const domHoje = iso(domingoSemana(hoje()));
  const domProx = (()=>{ const d = domingoSemana(hoje()); d.setDate(d.getDate()+7); return iso(d); })();
  let idx = 0;
  el.innerHTML = [...semanas].map(([k, itens]) => {
    const d0 = parseDate(k), d6 = new Date(d0); d6.setDate(d6.getDate()+6);
    const nome = k === domHoje ? 'Esta semana' : k === domProx ? 'Próxima semana'
      : `${pad2(d0.getDate())}/${pad2(d0.getMonth()+1)} – ${pad2(d6.getDate())}/${pad2(d6.getMonth()+1)}`;
    const pl = itens.filter(s => naAgenda(s) && !ehBolsa(s) && !ehBloq(s));
    const h = pl.reduce((a,s)=>a+(+s.duracao||0),0);
    const res = filter==='due'
      ? brl(itens.reduce((a,s)=>a+liq(s),0)) + ' a receber'
      : `${pl.length} ${pl.length===1?'plantão':'plantões'}${h ? ' · '+h+'h' : ''}`;
    let ant = '';
    const linhas = itens.map(s => { const r = linhaPlantao(s, { repete: s.data === ant, anim: animar, i: idx++ }); ant = s.data; return r; }).join('');
    return `<div class="list-sep"><span>${nome}</span><em>${res}</em></div>${linhas}`;
  }).join('');
}

// sigla do local para calendário, lista e semana: "UPA São Benedito" → "SB"
// (ou a sigla escolhida no cadastro do local). Dá para reconhecer o local sem depender da cor.
const PALAVRAS_GENERICAS = /^(upa|ubs|hospital|hosp\.?|cl[ií]nica|policl[ií]nica|unidade|centro|de|da|do|das|dos|e|em)$/i;
function siglaLocal(id){
  const l = getLocal(id);
  if(!l) return '?';
  if(l.sigla) return String(l.sigla).trim().slice(0,4).toUpperCase();
  const nome = String(l.nome||'').replace(/\(.*?\)/g,' ').trim();
  const pal = nome.split(/\s+/).filter(Boolean);
  const sig = pal.filter(p => !PALAVRAS_GENERICAS.test(p));
  if(sig.length >= 2) return (sig[0][0] + sig[1][0]).toUpperCase();
  if(sig.length === 1) return sig[0].slice(0,3).toUpperCase();
  return (pal[0]||'?').slice(0,3).toUpperCase();
}

// começa até 1h depois do fim de outro plantão: está emendado
function emendaComAnterior(s){
  if(!s.hora || ehBolsa(s) || ehBloq(s) || !naAgenda(s)) return false;
  const { ini } = evJanela(s);
  return S.shifts.some(o => o !== s && o.hora && naAgenda(o) && !ehBolsa(o) && !ehBloq(o) && (()=>{ const f = evJanela(o).f; return ini - f >= -EMENDA_MS && ini - f <= EMENDA_MS && evJanela(o).ini < ini; })());
}
// uma linha da agenda (lista do mês e painel do dia)
function linhaPlantao(s, o = {}){
  const d = parseDate(s.data), t = iso(hoje());
  const resid = ehResid(s), bolsa = ehBolsa(s), bloq = ehBloq(s), off = !counts(s) && !resid;   // residência não fica apagada
  const extra = s.tipo==='peguei' ? `peguei de ${s.colega||'colega'}` : s.tipo==='passei' ? `passei para ${s.colega||'colega'}`
    : resid ? 'sem remuneração' : bolsa ? (s.obs || 'entrada fixa') : '';
  const pill = (off || resid || bloq) ? '' : `<div class="pill ${s.pago?'pago':'pend'}" data-pay="${s.id}">${s.pago?'Pago':'Pendente'}</div>`;
  const dinheiro = (resid || bloq) ? '' : `<div class="money">${brl(liq(s))}</div>`;
  const ico = bolsa || bloq ? '' : (s.turno==='noturno' ? ICON_MOON : ICON_SUN);
  const notas = (s.notas||[]).length ? `<span class="note-ind" title="Anotações">📝${s.notas.length}</span>` : '';
  const data = o.semData ? '' : `<div class="daycol ${s.data===t?'is-today':''}">${o.repete ? '' : `<div class="d">${d.getDate()}</div><div class="w">${WD[d.getDay()]}</div>`}</div>`;
  return `<div class="shift lin ${o.anim?'animate-in':''} ${off?'off':''} ${resid?'resid':''} ${(!off&&s.urgente&&!bolsa)?'urgente':''}" data-id="${s.id}" data-date="${s.data}" style="--c:${localCor(s.localId)};${o.anim?`animation-delay:${Math.min(o.i||0,8)*30}ms`:''}">
      ${data}
      <div class="sig ${resid?'resid':''} ${bolsa?'bolsa':''}">${ico}<b>${esc(bolsa ? 'R$' : siglaLocal(s.localId))}</b></div>
      <div class="info">
        <div class="place"><span>${esc(localName(s.localId))}</span>${notas}</div>
        <div class="meta">${emendaComAnterior(s) ? '<b class="emd" title="Emenda com o plantão anterior">⛓</b> ' : ''}${metaLinha(s, '')}${extra ? ` · <em>${esc(extra)}</em>` : ''}${(!off&&s.urgente&&!bolsa&&!resid) ? ' · <b class="urg">⚠️ atenção</b>' : ''}</div>
      </div>
      <div class="right">${dinheiro}${pill}</div>
    </div>`;
}

function metaLinha(s, cid){
  if(ehBolsa(s)) return 'Entrada mensal fixa';
  if(ehAmb(s)){
    const p = [`${s.hora||'--:--'} · ${s.duracao}h`];
    if(s.nPart)  p.push(`${s.nPart} particular${s.nPart>1?'es':''}`);
    if(s.nPlano) p.push(`${s.nPlano} plano${s.nPlano>1?'s':''}`);
    if(s.nProc)  p.push(`${s.nProc} procedimento${s.nProc>1?'s':''}`);
    return p.join(' · ') + cid;
  }
  return `${s.hora||'--:--'} → ${fim(s.hora,s.duracao)} · ${s.duracao}h${cid}`;
}

/* ─── VISTA DE DIA ─── */
const WD_LONG = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];

function renderDia(){
  const d = diaAtual;
  const tStr = iso(d);
  const lista = S.shifts.filter(s => naAgenda(s) && s.data === tStr)
                        .sort((a,b)=>(a.hora||'00:00').localeCompare(b.hora||'00:00'));

  const box = $('#day-view');
  if(viewTipo !== 'dia'){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#shift-list').classList.add('hidden');
  $$('#filter button').forEach(b=>b.closest('.segs').classList.add('hidden'));

  const nomeDia = `${WD_LONG[d.getDay()]}, ${String(d.getDate()).padStart(2,'0')} de ${MES[d.getMonth()]} de ${d.getFullYear()}`;

  box.innerHTML = `
    <div class="day-header">
      <h2>${nomeDia}</h2>
      <button class="hoje-btn" id="btn-hoje">Hoje</button>
      <div class="day-nav">
        <button id="d-prev" aria-label="Dia anterior">‹</button>
        <button id="d-next" aria-label="Próximo dia">›</button>
      </div>
    </div>
    <div class="timeline" id="timeline">
    ${lista.length === 0
      ? `<div class="tl-empty">Nenhum compromisso neste dia.<br>Toque em + para lançar.</div>`
      : lista.map(s => {
          const resid = ehResid(s), bolsa = ehBolsa(s), amb = ehAmb(s), bloq = ehBloq(s);
          const cor = localCor(s.localId);
          const icone = s.turno==='noturno' ? ICON_MOON : ICON_SUN;
          const icos={'ferias':'🏖️','viagem':'✈️','sobreaviso':'📟','compromisso':'📌','outro':'📋'};
          const nomesBloq={ferias:'Férias',viagem:'Viagem',sobreaviso:'Sobreaviso',compromisso:'Compromisso',outro:'Bloqueio'};
          const nome = bloq
            ? `${icos[s.blTipo]||'📋'} ${nomesBloq[s.blTipo]||'Bloqueio'}`
            : esc(localName(s.localId));
          let meta = '';
          if(bolsa) meta = 'Entrada mensal fixa';
          else if(resid) meta = `${s.hora||'--:--'} → ${fim(s.hora,s.duracao)} · ${s.duracao}h · ${nomeResid(s)}`;
          else if(bloq){
            const dIni = parseDate(s.data);
            const iniStr = `${pad2(dIni.getDate())}/${pad2(dIni.getMonth()+1)}`;
            const fimStr = s.blFim && s.blFim!==s.data
              ? ` → ${pad2(parseDate(s.blFim).getDate())}/${pad2(parseDate(s.blFim).getMonth()+1)}`
              : '';
            meta = iniStr + fimStr;
          }
          else if(amb) meta = metaLinha(s,'');
          else meta = `${s.hora||'--:--'} → ${fim(s.hora,s.duracao)} · ${s.duracao}h · ${s.turno}`;

          const tags = [];
          if(s.urgente && !resid && !bolsa) tags.push(`<span class="chip-urg">⚠️ Atenção</span>`);
          if(resid) tags.push(`<span class="tag">Sem remuneração</span>`);
          if(s.tipo==='peguei') tags.push(`<span class="tag">Peguei de ${esc(s.colega||'colega')}</span>`);
          if(s.tipo==='passei') tags.push(`<span class="tag">Passei para ${esc(s.colega||'colega')}</span>`);
          if(s.obs) tags.push(`<span class="tag">${esc(s.obs.slice(0,48))}</span>`);
          if(!resid && !bolsa && !bloq){
            const v = liq(s);
            tags.push(`<span class="tag ${s.pago?'pill pago':'pill pend'}">${s.pago?'Pago · ':'Previsto · '}${brl(v)}</span>`);
          }

          return `<div class="tl-item" data-id="${s.id}">
            <div class="tl-hora">${bolsa?'':s.hora||'--:--'}</div>
            <div class="tl-card ${s.urgente&&!resid&&!bolsa&&!bloq?'urgente':''} ${resid?'resid':''} ${bloq?'bloqueio-card':''}" style="--c:${cor}" data-id="${s.id}">
              <div class="tc-nome">${icone}<span>${nome}</span></div>
              <div class="tc-meta">${meta}</div>
              ${tags.length ? `<div class="tc-tags">${tags.join('')}</div>` : ''}
            </div>
          </div>`;
        }).join('')
    }
    </div>`;

  // eventos de navegação
  $('#btn-hoje').onclick = ()=>{ diaAtual = new Date(); renderDia(); };
  $('#d-prev').onclick   = ()=>{ diaAtual.setDate(diaAtual.getDate()-1); renderDia(); };
  $('#d-next').onclick   = ()=>{ diaAtual.setDate(diaAtual.getDate()+1); renderDia(); };

  // clicar no card abre o sheet de edição
  $$('#timeline [data-id]').forEach(el=>{
    el.addEventListener('click', e=>{
      const id = el.closest('[data-id]').dataset.id;
      const s = S.shifts.find(x=>x.id===id);
      if(s) openSheet(s);
    });
  });
}

function renderNext(){
  // o plantão em andamento já aparece no painel do modo plantão; aqui vai o seguinte.
  // Janela real (data+hora+duração): um noturno de ontem ainda em curso não some.
  const agora = Date.now(), lim = iso(new Date(agora - 3*86400000));
  const atual = plantaoAtual(agora).ativo;
  const nx = S.shifts.filter(s=>naAgenda(s) && !ehBloq(s) && s !== atual && s.data >= lim && janelaDe(s).fim > agora)
                     .sort((a,b)=>janelaDe(a).ini - janelaDe(b).ini)[0];
  const box = $('#next-card');
  if(!nx){ box.innerHTML = ''; return; }
  const d = parseDate(nx.data);
  const dias = Math.round((d - hoje())/86400000);
  const l = getLocal(nx.localId), url = mapsUrl(l);

  // ── Countdown visual ──
  let badgeHtml = '', countdownHtml = '';
  if(dias === 0){
    // Hoje: calcular horas restantes
    const agora = new Date();
    const [hh, mm] = (nx.hora||'07:00').split(':').map(Number);
    const inicio = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
    const diffMs = inicio - agora;
    if(diffMs > 0){
      const diffH = Math.floor(diffMs/3600000);
      const diffM = Math.floor((diffMs%3600000)/60000);
      const tempoStr = diffH > 0 ? `em ${diffH}h${diffM>0?' '+diffM+'min':''}` : `em ${diffM}min`;
      badgeHtml = `<span style="background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:.04em">🔴 HOJE</span>`;
      countdownHtml = `<div style="font-size:13px;color:rgba(255,255,255,.9);margin-top:6px;font-weight:600">Começa ${tempoStr} · ${nx.hora}</div>`;
    } else {
      badgeHtml = `<span style="background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:.04em">🟢 EM ANDAMENTO</span>`;
      const diffFimMs = (inicio.getTime() + (nx.duracao||12)*3600000) - agora.getTime();
      if(diffFimMs > 0){
        const hFim = Math.floor(diffFimMs/3600000);
        countdownHtml = `<div style="font-size:13px;color:rgba(255,255,255,.9);margin-top:6px;font-weight:600">Faltam ~${hFim}h para o fim</div>`;
      }
    }
  } else if(dias === 1){
    badgeHtml = `<span style="background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:.04em">🟡 AMANHÃ</span>`;
    countdownHtml = `<div style="font-size:13px;color:rgba(255,255,255,.9);margin-top:6px;font-weight:600">Às ${nx.hora} · ${nx.duracao}h</div>`;
  } else if(dias <= 3){
    badgeHtml = `<span style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:700;letter-spacing:.04em">🟠 EM ${dias} DIAS</span>`;
  } else {
    badgeHtml = `<span style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);border-radius:99px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.03em">Em ${dias} dias</span>`;
  }

  box.innerHTML = `<div class="next" style="--nc:${localCor(nx.localId)}" data-id="${nx.id}">
    <div class="when" style="margin-bottom:8px">${badgeHtml}</div>
    <div class="pl">${esc(localName(nx.localId))}</div>
    <div class="dt">${nx.turno==='noturno'?ICON_MOON:ICON_SUN}
      ${WD[d.getDay()]}, ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ·
      ${nx.hora ? nx.hora+' → '+fim(nx.hora,nx.duracao)+' · ' : ''}${nx.duracao}h${l&&l.cidade?' · '+esc(l.cidade):''}</div>
    ${countdownHtml}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      ${url?`<button class="go" data-map="${encodeURIComponent(url)}">${ICON_PIN} Como chegar</button>`:''}
      <button class="go" data-cal="${nx.id}">${ICON_CAL} Agendar</button>
    </div>
  </div>`;
}

let selDia = null;   // dia escolhido no calendário (aaaa-mm-dd)
const NOME_BLOQ_CAL = { ferias:'Férias', viagem:'Viagem', sobreaviso:'Sobreaviso', compromisso:'Compromisso', outro:'Bloqueio' };
function itensDoDia(ds){
  return S.shifts.filter(s => s.data === ds && naAgenda(s) && !ehBolsa(s) && !ehBloq(s))
    .sort((a,b)=>(a.hora||'').localeCompare(b.hora||''));
}
const bloqueioDoDia = ds => S.bloqueios.find(b => b.ini && ds >= b.ini && ds <= (b.fim||b.ini));
function chipCal(s){
  return `<i class="ev ${ehResid(s)?'resid':''} ${s.turno==='noturno'?'noite':''}" style="--c:${localCor(s.localId)}">${s.turno==='noturno'?ICON_MOON:ICON_SUN}<b>${esc(siglaLocal(s.localId))}</b></i>`;
}
function renderCal(){
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y,m,1).getDay(), dim = new Date(y,m+1,0).getDate();
  const hj = iso(hoje());
  if(!selDia || !sameMonth(selDia, cursor)) selDia = sameMonth(hj, cursor) ? hj : null;
  let html = '', nPl = 0, nRes = 0, horas = 0;
  for(let i=0;i<first;i++) html += '<div class="void"></div>';
  for(let d=1; d<=dim; d++){
    const ds = iso(new Date(y,m,d)), its = itensDoDia(ds), bl = bloqueioDoDia(ds);
    its.forEach(s => { if(ehResid(s)) nRes++; else if(counts(s)) nPl++; horas += (+s.duracao||0); });
    const chips = its.length > 2 ? chipCal(its[0]) + `<i class="ev mais">+${its.length-1}</i>` : its.map(chipCal).join('');
    const blTag = bl && !its.length ? `<em class="bl-tag">${NOME_BLOQ_CAL[bl.motivo]||'Bloqueio'}</em>` : '';
    const rotulo = `${d} de ${MES[m]}` + (its.length ? ': ' + its.map(s => `${s.turno==='noturno'?'noturno':'diurno'} ${localName(s.localId)}`).join(', ') : '') + (bl ? ', bloqueado' : '');
    html += `<button data-day="${d}" class="cd ${its.length?'has':''} ${bl?'bl':''} ${ds===hj?'today':''} ${ds===selDia?'sel':''} ${ds<hj?'passou':''}" aria-label="${esc(rotulo)}">
      <span class="cd-n">${d}</span><span class="cd-ev">${chips}${blTag}</span></button>`;
  }
  $('#cal-grid').innerHTML = html;
  const partes = [];
  if(nPl) partes.push(`${nPl} ${nPl===1?'plantão':'plantões'}`);
  if(nRes) partes.push(`${nRes} da residência`);
  if(horas) partes.push(`${horas}h`);
  $('#ag-resumo').textContent = partes.join(' · ');
  renderAgDia();
}
function renderAgDia(){
  const box = $('#ag-dia'); if(!box) return;
  if(!selDia){ box.innerHTML = `<p class="ag-dica">Toque num dia para ver o que tem nele ou lançar um plantão.</p>`; return; }
  const d = parseDate(selDia), its = itensDoDia(selDia), bl = bloqueioDoDia(selDia);
  const nome = `${WD_LONG[d.getDay()]}, ${d.getDate()} de ${MES[d.getMonth()]}`;
  const blTxt = bl ? `${NOME_BLOQ_CAL[bl.motivo]||'Bloqueio'}${bl.fim && bl.fim !== bl.ini ? ` até ${pad2(parseDate(bl.fim).getDate())}/${pad2(parseDate(bl.fim).getMonth()+1)}` : ''}${bl.obs ? ' · '+esc(bl.obs) : ''}` : '';
  const dif = Math.round((d - hoje()) / 86400000);
  const quando = dif === 0 ? '<em>hoje</em>' : dif === 1 ? '<em>amanhã</em>' : dif === -1 ? '<em class="passou">ontem</em>'
    : dif > 1 && dif <= 60 ? `<em>em ${dif} dias</em>` : '';
  // lançar rápido: os modelos mais usados viram atalhos de um toque (abre já preenchido)
  const rapidos = !bl ? lancarRapido(selDia) : '';
  box.innerHTML = `<div class="ag-dia-h"><b>${nome.charAt(0).toUpperCase()+nome.slice(1)} ${quando}</b>
      <button class="btn sm" data-novo="${selDia}">+ Lançar</button></div>
    ${bl ? `<button class="ag-bl" data-bl="${bl.id}"><i class="lg-bl"></i>${blTxt}</button>` : ''}
    ${its.map(s => linhaPlantao(s, { semData: true })).join('') || (bl ? '' : '<p class="ag-vazio">Nenhum plantão neste dia.</p>')}
    ${its.length ? notasDescanso(its) : ''}
    ${rapidos}`;
}
/* Plantões emendados (um termina e outro começa em até 1h) e o descanso até o próximo:
   "⛓ 24h seguidas" e "descanso de 6h" — o que pesa no corpo, num relance. */
const EMENDA_MS = 3600000;
function plantoesPorHorario(){
  return S.shifts.filter(s => naAgenda(s) && !ehBolsa(s) && !ehBloq(s) && s.hora)
    .map(s => ({ s, ...evJanela(s) })).sort((a,b) => a.ini - b.ini);
}
function emendaDe(s){
  const todos = plantoesPorHorario();
  let ini0 = todos.find(x => x.s.id === s.id); if(!ini0) return null;
  // para trás: alguém que termina até 1h antes/depois do começo deste
  let a = ini0, guarda = 0;
  for(;;){ const p = todos.find(x => x.ini < a.ini && Math.abs(a.ini - x.f) <= EMENDA_MS); if(!p || ++guarda > 20) break; a = p; }
  // para frente: alguém que começa até 1h antes/depois do fim deste
  let b = a, n = 1; guarda = 0;
  for(;;){ const q = todos.find(x => x.ini > b.ini && Math.abs(x.ini - b.f) <= EMENDA_MS); if(!q || ++guarda > 20) break; b = q; n++; }
  const prox = todos.find(x => +x.ini > +b.f + EMENDA_MS) || null;
  return { ini: a.ini, f: b.f, n, prox, primeiro: a.s.id, ultimo: b.s.id };
}
function notasDescanso(its){
  const hh = d => `${WD[d.getDay()]} ${pad2(d.getHours())}h${d.getMinutes() ? pad2(d.getMinutes()) : ''}`;
  const vistas = new Set(), out = [];
  its.forEach(s => {
    const e = emendaDe(s); if(!e || vistas.has(e.primeiro)) return;
    vistas.add(e.primeiro);
    const horas = Math.round((e.f - e.ini) / 3600000);
    if(e.n > 1) out.push(`<div class="ag-nota emenda">⛓ <b>${horas}h seguidas</b> · ${e.n} plantões emendados, de ${hh(e.ini)} a ${hh(e.f)}</div>`);
    if(e.prox){
      const desc = Math.round((e.prox.ini - e.f) / 3600000);
      if(desc < 11) out.push(`<div class="ag-nota curto">⚠️ Só <b>${desc}h de descanso</b> até o próximo (${esc(siglaLocal(e.prox.s.localId))}, ${hh(e.prox.ini)})</div>`);
      else if(desc <= 72) out.push(`<div class="ag-nota">Descanso de ${desc}h até o próximo · ${hh(e.prox.ini)}</div>`);
    }
  });
  return out.join('');
}
function lancarRapido(ds){
  const ms = modelosFrequentes(4);
  const resLocal = S.locais.find(l => l.residencia);
  if(!ms.length && !resLocal) return '';
  const fimH = (h, dur) => pad2((+h.split(':')[0] + +dur) % 24);
  const chips = ms.map((m, i) => `<button class="rap" data-rap="${i}" style="--c:${localCor(m.localId)}">${m.turno==='noturno'?ICON_MOON:ICON_SUN}<b>${esc(siglaLocal(m.localId))}</b> ${m.hora.slice(0,2)}–${fimH(m.hora, m.duracao)}</button>`).join('')
    + (resLocal ? `<button class="rap resid" data-rap="res" style="--c:${resLocal.cor||'#7C8BA1'}">${ICON_MOON}<b>${esc(siglaLocal(resLocal.id))}</b> residência</button>` : '');
  return `<div class="ag-rap" data-dia="${ds}"><span>Lançar rápido</span><div>${chips}</div></div>`;
}
// tocar num dia (calendário, busca etc.): escolhe o dia e mostra o que tem nele
function irParaDia(ds){
  const d = parseDate(ds);
  if(!sameMonth(ds, cursor)) cursor = new Date(d.getFullYear(), d.getMonth(), 1);
  selDia = ds;
  if(viewTipo === 'semana'){ semanaAtual = new Date(d); }
  render();
  const ag = $('#ag-dia'); if(ag) ag.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function alternarPago(id){
  const s = S.shifts.find(x=>x.id===id);
  if(!s) return;
  s.pago = !s.pago;
  haptic(s.pago ? 12 : 6);
  s.pagoEm = s.pago ? (s.pagoEm || iso(new Date())) : '';
  await store.save(S); render();
  if(s.pago){ confettiPay(liq(s)); toast('💰 '+brl(liq(s))+' confirmado'); }
  else { toast('Desmarcado'); }
}
function abertas(){
  return S.shifts.filter(s=>(s.tipo==='peguei'||s.tipo==='passei') && s.contra==='devolver' && !s.quitado);
}

function renderCaixa(){
  const y = cursor.getFullYear(), m = cursor.getMonth(), t = iso(hoje());
  const todos = S.shifts.filter(counts);
  const soma = arr => arr.reduce((a,s)=>a+liq(s),0);

  const noMes = todos.filter(s=>{ const d = parseDate(dataCaixa(s)); return d.getMonth()===m && d.getFullYear()===y; })
                     .sort((a,b)=>dataCaixa(a).localeCompare(dataCaixa(b)));
  const rec = soma(noMes.filter(s=>s.pago));
  const prev = soma(noMes.filter(s=>!s.pago));
  const tot = rec + prev;

  $('#cx-lbl').textContent = 'Entra em ' + MES[m];
  $('#cx-total').textContent = brl(tot);
  $('#cx-sub').textContent = noMes.length
    ? `${noMes.length} entrada${noMes.length>1?'s':''} · ${noMes.filter(s=>s.pago).length} já confirmada${noMes.filter(s=>s.pago).length===1?'':'s'}`
    : 'Nada previsto para este mês';
  $('#cx-bar').style.width = (tot ? Math.min(100, rec/tot*100) : 0)+'%';
  $('#cx-rec').textContent = brl(rec);
  $('#cx-prev').textContent = brl(prev);

  // atrasados — vencimento já passou e ainda não caiu
  const atras = todos.filter(s=>!s.pago && vencimento(s) < t).sort((a,b)=>vencimento(a).localeCompare(vencimento(b)));
  $('#cx-atraso').innerHTML = atras.length ? `<div class="alert">
    <b>${brl(soma(atras))} em atraso</b>
    <small>${atras.length} ${atras.length>1?'plantões':'plantão'} com pagamento vencido</small>
    ${atras.map(s=>{
      const v = parseDate(vencimento(s));
      const dias = Math.round((hoje()-v)/86400000);
      return `<div class="row"><div class="swatch" style="background:${localCor(s.localId)}"></div>
        <div class="txt"><b>${esc(localName(s.localId))}</b>
          <small>${vencIncerto(s)
          ? `${MES[v.getMonth()]} fechou há ${dias} dia${dias>1?'s':''}`
          : `venceu ${pad2(v.getDate())}/${pad2(v.getMonth()+1)} · ${dias} dia${dias>1?'s':''} atrás`}</small></div>
        <div class="val">${brl(liq(s))}</div>
        <button class="btn sm" data-cxpay="${s.id}">Caiu</button></div>`;
    }).join('')}</div>` : '';

  // entradas do mês — timeline visual
  if(!noMes.length){
    $('#cx-list').innerHTML=`<div class="empty">Nenhuma entrada prevista para ${MES[m]}.</div>`;
  } else {
    const saldoCum = [];
    let acum=0;
    noMes.forEach(s=>{ acum+=s.pago?liq(s):0; saldoCum.push(acum); });
    const maxSaldo=Math.max(...noMes.map((_,i)=>saldoCum[i]||0),tot,1);
    $('#cx-list').innerHTML=`<div class="tl-cx">
      ${noMes.map((s,i)=>{
        const d=parseDate(dataCaixa(s)), t0=parseDate(s.data);
        const dataStr=(!s.pago&&vencIncerto(s))?`previsto em ${MES[d.getMonth()]}`:pad2(d.getDate())+'/'+pad2(d.getMonth()+1);
        const pct=Math.round(saldoCum[i]/maxSaldo*100);
        return `<div class="tl-cx-item ${s.pago?'tl-cx-pago':''}" data-cxopen="${s.id}">
          <div class="tl-cx-line">
            <div class="tl-cx-dot" style="background:${s.pago?'var(--ok)':'var(--line-2)'}; border-color:${localCor(s.localId)}"></div>
            <div class="tl-cx-vline ${i===noMes.length-1?'hidden':''}"></div>
          </div>
          <div class="tl-cx-inner">
            <div class="tl-cx-body">
              <div class="tl-cx-top">
                <div class="txt"><b>${esc(localName(s.localId))}</b><small>${dataStr} · lançamento ${pad2(t0.getDate())}/${pad2(t0.getMonth()+1)}</small></div>
                <div style="text-align:right">
                  <div class="val">${brl(liq(s))}</div>
                  <div class="pill ${s.pago?'pago':'pend'}" data-cxpay="${s.id}">${s.pago?'Caiu':'Previsto'}</div>
                </div>
              </div>
              ${s.pago?`<div class="tl-cx-bar"><i style="width:${pct}%"></i><span>${brl(saldoCum[i])} acumulado</span></div>`:''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // projeção dos 3 meses seguintes
  const fut = [];
  for(let i=1;i<=3;i++){
    const ref = new Date(y, m+i, 1);
    const v = soma(todos.filter(s=>{ const d = parseDate(dataCaixa(s));
      return d.getMonth()===ref.getMonth() && d.getFullYear()===ref.getFullYear(); }));
    fut.push({ ref, v });
  }
  $('#cx-fut').innerHTML = fut.map(f=>`<div class="row" data-goto="${f.ref.getFullYear()}-${f.ref.getMonth()}">
    <div class="txt"><b style="text-transform:capitalize">${MES[f.ref.getMonth()]} ${f.ref.getFullYear()}</b>
      <small>${f.v ? 'previsto' : 'sem lançamentos'}</small></div>
    <div class="val" style="color:${f.v?'var(--ink)':'var(--dim-2)'}">${brl(f.v)}</div></div>`).join('');

  // ── Simulador de renda anual ──
  (function(){
    const el = $('#cx-projecao-anual');
    if(!el) return;
    // média dos últimos 3 meses de caixa completos (excluindo mês atual)
    const meses3 = [];
    for(let i=1; i<=3; i++){
      const ref = new Date(y, m-i, 1);
      const v = soma(todos.filter(s=>{
        const d = parseDate(dataCaixa(s));
        return d.getMonth()===ref.getMonth() && d.getFullYear()===ref.getFullYear();
      }));
      meses3.push(v);
    }
    const media3 = meses3.reduce((a,v)=>a+v,0) / 3;
    if(!media3){ el.innerHTML=''; return; }
    const metaAnual = S.metaAnual || 0;
    const projecao12 = Math.round(media3 * 12);
    const progAnual = metaAnual ? Math.min(100, Math.round(projecao12/metaAnual*100)) : 0;
    const corProj = metaAnual
      ? (projecao12 >= metaAnual ? 'var(--ok)' : 'var(--accent)')
      : 'var(--accent)';

    el.innerHTML = `<div style="background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px 16px;margin:8px 0 0;box-shadow:var(--sh)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <div style="font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)">Projeção anual</div>
          <div style="font-size:22px;font-weight:800;color:${corProj};margin-top:2px;font-variant-numeric:tabular-nums">${brl(projecao12)}</div>
          <div style="font-size:11.5px;color:var(--dim);margin-top:2px">média ${brl(Math.round(media3))}/mês · últimos 3 meses</div>
        </div>
        <button id="cx-meta-anual-btn" style="font-size:11px;font-weight:700;padding:5px 11px;border-radius:99px;border:1.5px solid var(--line-2);background:none;color:var(--dim);cursor:pointer;white-space:nowrap;margin-top:4px">
          ${metaAnual ? brl(metaAnual) : '+ meta anual'}
        </button>
      </div>
      ${metaAnual ? `
      <div style="margin-bottom:8px">
        <div class="gauge" style="height:6px;background:var(--line)"><i class="p" style="width:${progAnual}%;background:${corProj};transition:width .6s cubic-bezier(.4,0,.2,1)"></i></div>
        <div style="display:flex;justify-content:space-between;margin-top:5px">
          <span style="font-size:11px;color:var(--dim)">${progAnual}% da meta</span>
          <span style="font-size:11px;color:${projecao12>=metaAnual?'var(--ok)':'var(--dim)'}">
            ${projecao12>=metaAnual ? 'Meta atingida 🎉' : 'Faltam ' + brl(metaAnual-projecao12)}
          </span>
        </div>
      </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px">
        <div style="background:var(--bg);border-radius:10px;padding:9px 12px;text-align:center">
          <div style="font-size:10px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em">Se aumentar 10%</div>
          <div style="font-size:14px;font-weight:800;color:var(--ok);margin-top:3px;font-variant-numeric:tabular-nums">${brl(Math.round(media3*1.1*12))}</div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:9px 12px;text-align:center">
          <div style="font-size:10px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em">Melhor mês × 12</div>
          <div style="font-size:14px;font-weight:800;color:var(--accent);margin-top:3px;font-variant-numeric:tabular-nums">${brl(Math.max(...meses3,tot)*12)}</div>
        </div>
      </div>
    </div>`;

    // input de meta anual via popover inline
    document.getElementById('cx-meta-anual-btn')?.addEventListener('click', ()=>{
      formSheet({ titulo:'Meta de renda anual', campos:[{ id:'v', label:'Valor (R$)', tipo:'number', valor:S.metaAnual||'', ph:'250000' }],
        remover: S.metaAnual ? 'Remover meta' : null }).then(r=>{
        if(!r) return;
        const v = r === 'remover' ? 0 : (parseFloat(r.v) || 0);
        S.metaAnual = v || undefined;
        store.save(S).then(()=>{ haptic(10); renderCaixa(); toast(v ? 'Meta anual salva' : 'Meta removida'); });
      });
    });
  })();

  // ── Feature 5: "Quanto falta para X" ──
  (function(){
    const el = $('#cx-objetivo');
    if(!el) return;
    const obj = S.metaObjetivo; // {nome, valor} ou undefined
    // calcular acumulado dos últimos 3 meses completos (média mensal)
    const meses3 = [];
    for(let i=1; i<=3; i++){
      const ref = new Date(y, m-i, 1);
      const v2 = todos.filter(s=>{
        const d = parseDate(dataCaixa(s));
        return d.getMonth()===ref.getMonth() && d.getFullYear()===ref.getFullYear();
      }).reduce((a,s)=>a+liq(s),0);
      meses3.push(v2);
    }
    const media3 = meses3.filter(v2=>v2>0);
    const mediaMensal = media3.length ? Math.round(media3.reduce((a,v2)=>a+v2,0)/media3.length) : 0;

    if(!obj){
      el.innerHTML = `
        <div style="background:var(--card,var(--bg-2,rgba(0,0,0,.04)));border:1.5px dashed var(--line-2);border-radius:14px;padding:16px;margin-top:8px;text-align:center">
          <div style="font-size:13px;color:var(--dim);margin-bottom:10px">Defina um objetivo financeiro e veja quanto falta para alcançá-lo</div>
          <button id="cx-obj-add" style="font-size:12px;font-weight:700;padding:6px 16px;border-radius:99px;border:1.5px solid var(--accent);background:none;color:var(--accent);cursor:pointer">+ Definir objetivo</button>
        </div>`;
      document.getElementById('cx-obj-add')?.addEventListener('click', ()=>{
        formSheet({ titulo:'Novo objetivo', campos:[
            { id:'nome', label:'Nome', tipo:'text', ph:'Viagem, reserva, equipamento…' },
            { id:'valor', label:'Valor alvo (R$)', tipo:'number', ph:'20000' } ] }).then(r=>{
          if(!r) return;
          const valor = parseFloat(r.valor) || 0;
          if(!r.nome.trim() || !valor){ toast('Preencha nome e valor'); return; }
          S.metaObjetivo = { nome: r.nome.trim(), valor };
          store.save(S).then(()=>{ haptic(10); renderCaixa(); toast('Objetivo salvo'); });
        });
      });
      return;
    }

    const pct = mediaMensal ? Math.min(100, Math.round((mediaMensal / obj.valor) * 100)) : 0;
    const mesesNecessarios = mediaMensal ? Math.ceil(obj.valor / mediaMensal) : null;
    const corBar = pct >= 100 ? 'var(--ok)' : 'var(--accent)';

    el.innerHTML = `
      <div style="background:var(--card,var(--bg-2,rgba(0,0,0,.04)));border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Objetivo</div>
            <div style="font-size:15px;font-weight:800;color:var(--fg)">${esc(obj.nome)}</div>
            <div style="font-size:13px;color:var(--dim);margin-top:2px">${brl(obj.valor)}</div>
          </div>
          <button id="cx-obj-edit" style="font-size:11px;padding:4px 10px;border-radius:99px;border:1px solid var(--line-2);background:none;color:var(--dim);cursor:pointer">✏️ editar</button>
        </div>
        <div style="margin-bottom:6px">
          <div class="gauge" style="height:8px;background:var(--line);border-radius:99px"><i class="p" style="width:${pct}%;background:${corBar};border-radius:99px;transition:width .6s cubic-bezier(.4,0,.2,1)"></i></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--dim)">
          ${mediaMensal ? `<span>Economizando <b style="color:var(--fg)">${brl(mediaMensal)}/mês</b></span>` : '<span>Sem dados de caixa ainda</span>'}
          <span style="color:${corBar};font-weight:700">${mesesNecessarios ? `${mesesNecessarios} mês${mesesNecessarios!==1?'es':''}` : '—'}</span>
        </div>
        ${!mediaMensal ? '' : `<div style="font-size:11px;color:var(--dim);margin-top:6px;text-align:right">
          baseado na média dos últimos meses
        </div>`}
      </div>`;

    document.getElementById('cx-obj-edit')?.addEventListener('click', ()=>{
      formSheet({ titulo:'Editar objetivo', campos:[
          { id:'nome', label:'Nome', tipo:'text', valor:obj.nome },
          { id:'valor', label:'Valor alvo (R$)', tipo:'number', valor:obj.valor } ], remover:'Remover objetivo' }).then(r=>{
        if(!r) return;
        if(r === 'remover'){ comDesfazer('Objetivo removido', ()=>{ S.metaObjetivo = undefined; }); return; }
        const valor = parseFloat(r.valor) || 0;
        if(!r.nome.trim() || !valor){ toast('Preencha nome e valor'); return; }
        S.metaObjetivo = { nome: r.nome.trim(), valor };
        store.save(S).then(()=>{ haptic(10); renderCaixa(); toast('Objetivo atualizado'); });
      });
    });
  })();
}

/* ================= RESUMO: números, gráficos e tabela =================
   Uma fonte só para todos os números (Resumo, "Seu ano em números" e a imagem do ano):
   · plantões = trabalho remunerado (plantão e consultório), por data do plantão;
   · entradas fixas = bolsa da residência, auxílios — dinheiro que não é plantão;
   · residência = horas obrigatórias, sem valor.                                      */
const MES_CURTO = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const ehPlantaoPago = s => counts(s) && !ehBolsa(s);
const ehEntradaFixa = s => counts(s) && ehBolsa(s);

function agregar(itens){
  const pl = itens.filter(ehPlantaoPago), fx = itens.filter(ehEntradaFixa), rs = itens.filter(ehResid);
  const soma = (a, f) => a.reduce((t, s) => t + f(s), 0);
  const r = {
    pl, fx,
    n: pl.length, h: soma(pl, s => +s.duracao || 0),
    fatPl: soma(pl, liq), recPl: soma(pl.filter(s => s.pago), liq),
    fatFx: soma(fx, liq), recFx: soma(fx.filter(s => s.pago), liq),
    bruto: soma(pl, bru), hRes: soma(rs, s => +s.duracao || 0), nRes: rs.length,
    noites: pl.filter(s => s.turno === 'noturno' && !ehAmb(s)).length,
  };
  r.fat = r.fatPl + r.fatFx; r.rec = r.recPl + r.recFx; r.pend = r.fat - r.rec;
  r.vph = r.h ? r.fatPl / r.h : 0; r.media = r.n ? r.fatPl / r.n : 0;
  return r;
}
// período do Resumo → intervalo de datas e meses dos gráficos
function periodoResumo(p){
  const hj = hoje(), y = hj.getFullYear(), m = hj.getMonth();
  const mesesAte = (y2, m2, n) => Array.from({length:n}, (_,i) => { const d = new Date(y2, m2 - n + 1 + i, 1); return { y:d.getFullYear(), m:d.getMonth() }; });
  if(p === 'mes') return { nome:'Este mês', ini: iso(new Date(y,m,1)), fim: iso(new Date(y,m+1,0)), meses: mesesAte(y, m, 6), titMeses:'Últimos 6 meses' };
  if(p === '3m')  return { nome:'Últimos 3 meses', ini: iso(new Date(y,m-2,1)), fim: iso(new Date(y,m+1,0)), meses: mesesAte(y, m, 6), titMeses:'Últimos 6 meses' };
  if(p === 'ano') return { nome:'Este ano', ini: `${y}-01-01`, fim: `${y}-12-31`, meses: mesesAte(y, 11, 12), titMeses:`Mês a mês · ${y}`, ano: y };
  return { nome:'Todo o período', ini: '0000-01-01', fim: '9999-12-31', meses: mesesAte(y, m, 12), titMeses:'Últimos 12 meses' };
}
const doPeriodo = (ini, fim) => S.shifts.filter(s => s.data >= ini && s.data <= fim);
const doMes = (y, m) => { const k = `${y}-${pad2(m+1)}`; return S.shifts.filter(s => s.data.startsWith(k)); };
const kBRL = v => v >= 1000 ? (v/1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',') + 'k' : String(Math.round(v));
function abrirDetalhe(titulo, html){
  delete $('#sd-body').dataset.saude;
  $('#sd-title').textContent = titulo; $('#sd-body').innerHTML = html;
  $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
}

function renderResumo(){
  const periodo = document.querySelector('#res-periodo .on')?.dataset.rp || 'mes';
  const P = periodoResumo(periodo), A = agregar(doPeriodo(P.ini, P.fim));
  // ── topo ──
  $('#res-lbl').textContent = 'Resumo · ' + P.nome;
  $('#res-total').textContent = brl(A.fat);
  $('#res-div').innerHTML = A.fatFx
    ? `<span><i class="cx-pl"></i>Plantões <b>${brl(A.fatPl)}</b></span><span><i class="cx-fx"></i>Entradas fixas <b>${brl(A.fatFx)}</b></span>`
    : '';
  $('#res-sub').textContent = `${A.n} ${A.n===1?'plantão':'plantões'} · ${A.h}h` + (A.hRes ? ` · +${A.hRes}h de residência` : '')
    + (A.bruto - A.fatPl > 0.5 ? ` · ${brl(A.bruto - A.fatPl)} retidos na fonte` : '');
  $('#res-bar').style.width = (A.fat ? Math.min(100, A.rec/A.fat*100) : 0) + '%';
  $('#res-rec').textContent = brl(A.rec);
  $('#res-pend').textContent = brl(A.pend);
  $('#res-kpis').innerHTML = `
    <div class="kpi"><b>${A.n}</b><span>plantões</span><small>${A.noites} noturno${A.noites===1?'':'s'}</small></div>
    <div class="kpi"><b>${A.h}h</b><span>trabalhadas</span><small>${A.h ? '≈ ' + (A.h/24).toFixed(1).replace('.', ',') + ' dias' : '—'}</small></div>
    <div class="kpi"><b class="money">${A.vph ? brl(A.vph) : '—'}</b><span>por hora</span><small>média dos plantões</small></div>
    <div class="kpi"><b class="money">${A.media ? brl(A.media) : '—'}</b><span>por plantão</span><small>média líquida</small></div>`;
  renderProjecaoAno(periodo);
  $('#res-meses-tit').textContent = P.titMeses;
  graficoMeses(P.meses);
  graficoHoras(P.meses);
  mapaCalor(P.ano || hoje().getFullYear());
  graficoLocais(A);
  graficoTurnos(A);
  graficoSemana(A);
  tabelaMeses(P.meses);
  cartaoTrocas(doPeriodo(P.ini, P.fim));
}

/* projeção do ano: o já lançado + o ritmo até hoje, com o acumulado mês a mês */
function renderProjecaoAno(periodo){
  const box = $('#res-proj');
  if(periodo !== 'ano'){ box.innerHTML = ''; return; }
  const hj = hoje(), y = hj.getFullYear(), hjI = iso(hj);
  const ano = S.shifts.filter(s => s.data.startsWith(String(y)) && counts(s));
  const ate = ano.filter(s => s.data <= hjI);
  const lancado = ano.reduce((a,s)=>a+liq(s),0), real = ate.reduce((a,s)=>a+liq(s),0);
  const diasPassados = Math.max(1, Math.round((hj - new Date(y,0,1)) / 86400000) + 1);
  const diasAno = (new Date(y+1,0,1) - new Date(y,0,1)) / 86400000;
  const ritmo = real / diasPassados * diasAno;
  const proj = Math.max(lancado, ritmo);
  const antes = S.shifts.filter(s => s.data.startsWith(String(y-1)) && counts(s)).reduce((a,s)=>a+liq(s),0);
  // acumulado por mês (lançado) e reta da projeção do mês atual até dezembro
  let acc = 0; const pts = MES_CURTO.map((_, m) => { acc += doMes(y, m).filter(counts).reduce((a,s)=>a+liq(s),0); return acc; });
  const W = 320, H = 120, L = 6, R = 6, T = 10, B = 18, gW = W-L-R, gH = H-T-B, max = Math.max(proj, acc, 1);
  const X = i => L + gW * i / 11, Y = v => T + gH * (1 - v / max);
  const mHoje = hj.getMonth();
  const real_ = pts.slice(0, mHoje + 1).map((v,i) => `${X(i)},${Y(v)}`).join(' ');
  const fut = pts.slice(mHoje).map((v,i) => `${X(mHoje+i)},${Y(v)}`).join(' ');
  const projL = `${X(mHoje)},${Y(pts[mHoje])} ${X(11)},${Y(proj)}`;
  box.innerHTML = `<div class="proj-card">
    <div class="proj-txt"><span>No ritmo atual, ${y} fecha em</span><b class="money">${brl(proj)}</b>
      <small>${brl(lancado)} já lançados${lancado > real ? ` (${brl(lancado-real)} agendados)` : ''}${antes ? ` · ${proj >= antes ? '+' : ''}${Math.round((proj/antes-1)*100)}% vs ${y-1}` : ''}</small></div>
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Acumulado do ano e projeção">
      ${[0.5,1].map(f => `<line x1="${L}" x2="${W-R}" y1="${Y(max*f)}" y2="${Y(max*f)}" stroke="var(--line)"/><text x="${W-R}" y="${Y(max*f)-3}" text-anchor="end" font-size="9" fill="var(--dim)">${kBRL(max*f)}</text>`).join('')}
      <polyline points="${projL}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 4" opacity=".7"/>
      <polyline points="${fut}" fill="none" stroke="var(--accent)" stroke-width="2" opacity=".35"/>
      <polyline points="${real_}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${X(mHoje)}" cy="${Y(pts[mHoje])}" r="3.5" fill="var(--accent)"/>
      ${MES_CURTO.map((m,i) => `<text x="${X(i)}" y="${H-4}" text-anchor="middle" font-size="9" fill="${i===mHoje?'var(--ink)':'var(--dim)'}">${m[0].toUpperCase()}</text>`).join('')}
    </svg>
    <div class="chart-leg"><span><i class="lg-linha"></i>acumulado</span><span><i class="lg-traco"></i>projeção</span></div>
  </div>`;
}

/* barras mês a mês, empilhadas por local (plantões) + entradas fixas, com o recebido marcado */
let _mesSel = null;
function graficoMeses(meses){
  const dados = meses.map(({y,m}) => {
    const A = agregar(doMes(y,m)), porLoc = {};
    A.pl.forEach(s => { porLoc[s.localId] = (porLoc[s.localId]||0) + liq(s); });
    return { y, m, A, porLoc };
  });
  const locs = [...new Set(dados.flatMap(d => Object.keys(d.porLoc)))]
    .sort((a,b) => dados.reduce((t,d)=>t+(d.porLoc[b]||0),0) - dados.reduce((t,d)=>t+(d.porLoc[a]||0),0));
  const max = Math.max(...dados.map(d => d.A.fat), 1);
  const n = dados.length, W = 340, H = 170, L = 30, R = 4, T = 14, B = 20, gW = W-L-R, gH = H-T-B;
  const bw = Math.min(30, gW/n*0.62), X = i => L + gW*(i+.5)/n, Y = v => T + gH*(1 - v/max);
  const hjK = `${hoje().getFullYear()}-${hoje().getMonth()}`;
  if(_mesSel && !dados.some(d => `${d.y}-${d.m}` === _mesSel)) _mesSel = null;
  let svg = [0.5, 1].map(f => `<line x1="${L}" x2="${W-R}" y1="${Y(max*f)}" y2="${Y(max*f)}" stroke="var(--line)"/><text x="${L-4}" y="${Y(max*f)+3}" text-anchor="end" font-size="9" fill="var(--dim)">${kBRL(max*f)}</text>`).join('');
  dados.forEach((d, i) => {
    let base = 0;
    const k = `${d.y}-${d.m}`, sel = _mesSel === k;
    locs.forEach(lid => { const v = d.porLoc[lid]||0; if(!v) return;
      svg += `<rect x="${X(i)-bw/2}" y="${Y(base+v)}" width="${bw}" height="${gH*v/max}" fill="${localCor(lid)}" opacity="${_mesSel && !sel ? .35 : .9}"/>`; base += v; });
    if(d.A.fatFx) svg += `<rect x="${X(i)-bw/2}" y="${Y(base+d.A.fatFx)}" width="${bw}" height="${gH*d.A.fatFx/max}" fill="url(#hach)" stroke="var(--dim-2)" stroke-width=".6" opacity="${_mesSel && !sel ? .35 : 1}"/>`;
    if(d.A.rec) svg += `<line x1="${X(i)-bw/2-3}" x2="${X(i)+bw/2+3}" y1="${Y(d.A.rec)}" y2="${Y(d.A.rec)}" stroke="var(--ink)" stroke-width="2"/>`;
    svg += `<text x="${X(i)}" y="${H-6}" text-anchor="middle" font-size="9.5" font-weight="${k===hjK?700:400}" fill="${k===hjK?'var(--ink)':'var(--dim)'}">${MES_CURTO[d.m]}</text>`;
    svg += `<rect x="${X(i)-gW/n/2}" y="${T}" width="${gW/n}" height="${gH+B}" fill="transparent" data-mes="${k}" style="cursor:pointer"/>`;
  });
  const leg = locs.slice(0, 6).map(l => `<span><i style="background:${localCor(l)}"></i>${esc(siglaLocal(l))}</span>`).join('')
    + (dados.some(d => d.A.fatFx) ? '<span><i class="lg-fx"></i>fixas</span>' : '') + '<span><i class="lg-rec"></i>recebido</span>';
  const s = _mesSel && dados.find(d => `${d.y}-${d.m}` === _mesSel);
  $('#res-meses').innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Faturado por mês">
      <defs><pattern id="hach" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--surface-2)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--dim-2)" stroke-width="2"/></pattern></defs>${svg}</svg>
    <div class="chart-leg">${leg}</div>
    ${s ? `<div class="mes-info"><b>${MES[s.m].charAt(0).toUpperCase()+MES[s.m].slice(1)} de ${s.y}</b>
      <div><span>Faturado</span><b>${brl(s.A.fat)}</b></div><div><span>Recebido</span><b>${brl(s.A.rec)}</b></div>
      <div><span>Plantões</span><b>${s.A.n} · ${s.A.h}h</b></div><div><span>Por hora</span><b>${s.A.vph ? brl(s.A.vph) : '—'}</b></div>
      ${Object.entries(s.porLoc).sort((a,b)=>b[1]-a[1]).map(([l,v]) => `<div class="full"><span><i style="background:${localCor(l)}"></i>${esc(nomeCurto(l))}</span><b>${brl(v)}</b></div>`).join('')}
      ${s.A.fatFx ? `<div class="full"><span><i class="lg-fx"></i>Entradas fixas</span><b>${brl(s.A.fatFx)}</b></div>` : ''}</div>`
      : '<p class="chart-dica">Toque num mês para ver os números.</p>'}`;
}

/* horas por mês (barras) e valor da hora (linha) */
function graficoHoras(meses){
  const d = meses.map(({y,m}) => { const A = agregar(doMes(y,m)); return { m, h: A.h, hRes: A.hRes, vph: A.vph }; });
  const maxH = Math.max(...d.map(x => x.h + x.hRes), 1), maxV = Math.max(...d.map(x => x.vph), 1);
  const n = d.length, W = 340, H = 150, L = 26, R = 30, T = 14, B = 20, gW = W-L-R, gH = H-T-B;
  const bw = Math.min(26, gW/n*.55), X = i => L + gW*(i+.5)/n, YH = v => T + gH*(1-v/maxH), YV = v => T + gH*(1-v/maxV);
  const iMax = d.reduce((b, x, i) => x.h > d[b].h ? i : b, 0);
  let svg = `<line x1="${L}" x2="${W-R}" y1="${YH(maxH)}" y2="${YH(maxH)}" stroke="var(--line)"/><text x="${L-4}" y="${YH(maxH)+3}" text-anchor="end" font-size="9" fill="var(--dim)">${maxH}h</text>
    <text x="${W-R+4}" y="${YV(maxV)+3}" font-size="9" fill="var(--accent)">${kBRL(maxV)}/h</text>`;
  d.forEach((x, i) => {
    svg += `<rect x="${X(i)-bw/2}" y="${YH(x.h)}" width="${bw}" height="${gH*x.h/maxH}" rx="3" fill="var(--dim-2)" opacity=".55"/>`;
    if(x.hRes) svg += `<rect x="${X(i)-bw/2}" y="${YH(x.h+x.hRes)}" width="${bw}" height="${gH*x.hRes/maxH}" rx="3" fill="none" stroke="var(--dim)" stroke-dasharray="3 2"/>`;
    if(x.h && i === iMax) svg += `<text x="${X(i)}" y="${YH(x.h)-4}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--ink)">${x.h}h</text>`;
    svg += `<text x="${X(i)}" y="${H-6}" text-anchor="middle" font-size="9.5" fill="var(--dim)">${MES_CURTO[x.m]}</text>`;
  });
  const pts = d.map((x,i) => x.vph ? [X(i), YV(x.vph), x.vph] : null).filter(Boolean);
  if(pts.length > 1) svg += `<polyline points="${pts.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
  pts.forEach(p => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`; });
  $('#res-horas').innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Horas e valor da hora por mês">${svg}</svg>
    <div class="chart-leg"><span><i style="background:var(--dim-2);opacity:.6"></i>horas de plantão</span>${d.some(x=>x.hRes)?'<span><i class="lg-res"></i>residência</span>':''}<span><i class="lg-ponto"></i>R$ por hora</span></div>`;
}

/* mapa de calor do ano: um quadradinho por dia, mais forte com mais horas */
function mapaCalor(y){
  const horas = {};
  S.shifts.filter(s => s.data.startsWith(String(y)) && naAgenda(s) && !ehBolsa(s) && !ehBloq(s))
    .forEach(s => { horas[s.data] = (horas[s.data]||0) + (+s.duracao||0); });
  const nivel = h => !h ? 0 : h <= 6 ? 1 : h <= 12 ? 2 : h <= 24 ? 3 : 4;
  const L = 26, c = 8.6, g = 1.4, W = L + 31*(c+g), H = 12*(c+g) + 12;
  const hjI = iso(hoje()), bls = S.bloqueios || [];
  let svg = '', dias = 0, total = 0, maxDia = ['', 0];
  for(let m = 0; m < 12; m++){
    svg += `<text x="0" y="${m*(c+g)+c-0.6}" font-size="7.5" fill="var(--dim)">${MES_CURTO[m]}</text>`;
    const nd = new Date(y, m+1, 0).getDate();
    for(let d = 1; d <= nd; d++){
      const k = `${y}-${pad2(m+1)}-${pad2(d)}`, h = horas[k] || 0, dt = new Date(y, m, d);
      if(h){ dias++; total += h; if(h > maxDia[1]) maxDia = [k, h]; }
      const fds = dt.getDay() === 0 || dt.getDay() === 6, bl = !h && bls.some(b => b.ini && k >= b.ini && k <= (b.fim||b.ini));
      svg += `<rect x="${L+(d-1)*(c+g)}" y="${m*(c+g)}" width="${c}" height="${c}" rx="1.6" class="hm n${nivel(h)}${fds&&!h?' fds':''}${bl?' bl':''}${k===hjI?' hoje':''}" data-hm="${k}"><title>${pad2(d)}/${pad2(m+1)}: ${h ? h+'h' : 'livre'}</title></rect>`;
    }
  }
  [1, 10, 20, 31].forEach(d => { svg += `<text x="${L+(d-1)*(c+g)+c/2}" y="${H-1}" text-anchor="middle" font-size="7" fill="var(--dim)">${d}</text>`; });
  $('#res-calor-tit').textContent = `Mapa de ${y}`;
  const md = maxDia[0] ? parseDate(maxDia[0]) : null;
  $('#res-calor').innerHTML = `<svg class="hm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Horas por dia em ${y}">${svg}</svg>
    <div class="hm-rod"><span>${dias} dias com plantão · ${total}h${md ? ` · mais longo: ${pad2(md.getDate())}/${pad2(md.getMonth()+1)} (${maxDia[1]}h)` : ''}</span>
      <span class="hm-leg">menos <i class="hm n0"></i><i class="hm n1"></i><i class="hm n2"></i><i class="hm n3"></i><i class="hm n4"></i> mais</span></div>`;
}

/* por local: participação (barra 100%) + tabela com plantões, horas, valor e R$/h */
function graficoLocais(A){
  const porLoc = {};
  A.pl.forEach(s => { const k = s.localId||'_'; const x = porLoc[k] = porLoc[k] || { n:0, h:0, fat:0, rec:0 }; x.n++; x.h += +s.duracao||0; x.fat += liq(s); x.rec += s.pago ? liq(s) : 0; });
  const lista = Object.entries(porLoc).map(([lid,x]) => ({ lid, ...x, vph: x.h ? x.fat/x.h : 0 })).sort((a,b) => b.fat - a.fat);
  if(!lista.length){ $('#res-locais').innerHTML = '<div class="empty">Nenhum plantão no período.</div>'; return; }
  const melhor = lista.filter(x => x.vph).sort((a,b) => b.vph - a.vph)[0];
  $('#res-locais').innerHTML = `<div class="barra100">${lista.map(x => `<i style="width:${(x.fat/A.fatPl*100).toFixed(2)}%;background:${localCor(x.lid)}" title="${esc(localName(x.lid))}"></i>`).join('')}</div>
    <div class="tab-wrap mini"><table class="tab">
      <thead><tr><th>Local</th><th>Faturado</th><th>R$/h</th></tr></thead>
      <tbody>${lista.map(x => `<tr><td><div class="lc"><span class="sg" style="--c:${localCor(x.lid)}">${esc(siglaLocal(x.lid))}</span><span class="lc-nome">${esc(nomeCurto(x.lid))}<small>${x.n} ${x.n === 1 ? 'plantão' : 'plantões'} · ${x.h}h</small></span></div></td>
        <td>${brl(x.fat)}<small>${Math.round(x.fat/A.fatPl*100)}%</small></td>
        <td${melhor && melhor.lid === x.lid && lista.length > 1 ? ' class="top"' : ''}>${x.vph ? Math.round(x.vph) : '—'}${melhor && melhor.lid === x.lid && lista.length > 1 ? '<small>melhor</small>' : ''}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

/* diurno × noturno */
function graficoTurnos(A){
  const t = { diurno:{ n:0, h:0, fat:0 }, noturno:{ n:0, h:0, fat:0 } };
  A.pl.filter(s => !ehAmb(s)).forEach(s => { const x = t[s.turno === 'noturno' ? 'noturno' : 'diurno']; x.n++; x.h += +s.duracao||0; x.fat += liq(s); });
  const tot = t.diurno.fat + t.noturno.fat;
  if(!tot){ $('#res-turnos').innerHTML = '<div class="empty">Sem plantões no período.</div>'; return; }
  const lin = (k, ico, nome) => { const x = t[k]; return `<div class="tn-l"><span class="tn-ico">${ico}</span><b>${nome}</b>
      <span>${x.n} · ${x.h}h</span><span class="money">${brl(x.fat)}</span><span class="tn-vph">${x.h ? brl(x.fat/x.h)+'/h' : '—'}</span></div>`; };
  $('#res-turnos').innerHTML = `<div class="barra100 alta"><i class="tn-d" style="width:${t.diurno.fat/tot*100}%"><b>${Math.round(t.diurno.fat/tot*100)}%</b></i><i class="tn-n" style="width:${t.noturno.fat/tot*100}%"><b>${Math.round(t.noturno.fat/tot*100)}%</b></i></div>
    ${lin('diurno', ICON_SUN, 'Diurno')}${lin('noturno', ICON_MOON, 'Noturno')}`;
}

/* dia da semana: quantos plantões começam em cada dia e quanto rende a hora */
function graficoSemana(A){
  const d = Array.from({length:7}, () => ({ n:0, h:0, fat:0 }));
  A.pl.forEach(s => { const x = d[parseDate(s.data).getDay()]; x.n++; x.h += +s.duracao||0; x.fat += liq(s); });
  const max = Math.max(...d.map(x => x.n), 1);
  if(!A.pl.length){ $('#res-semana').innerHTML = '<div class="empty">Sem plantões no período.</div>'; return; }
  const melhor = d.map((x,i) => ({ i, vph: x.h ? x.fat/x.h : 0 })).sort((a,b) => b.vph - a.vph)[0];
  const mais = d.map((x,i) => ({ i, n: x.n })).sort((a,b) => b.n - a.n)[0];
  $('#res-semana').innerHTML = `<div class="sem-bars">${d.map((x,i) => `<div class="sb-c"><em>${x.n||''}</em><i style="height:${x.n/max*100}%" class="${i===mais.i?'top':''}"></i><span>${WD[i]}</span></div>`).join('')}</div>
    <p class="chart-dica">Você mais trabalha às <b>${WD_LONG[mais.i]}s</b>${melhor.vph ? ` · a hora rende mais às <b>${WD_LONG[melhor.i]}s</b> (${brl(melhor.vph)}/h)` : ''}.</p>`;
}

/* tabela mês a mês (ordenável) + exportar planilha */
let _tabOrd = { col: 'mes', desc: false };
function linhasTabela(meses){
  return meses.map(({y,m}) => { const A = agregar(doMes(y,m)); return { y, m, mes: y*12+m, n: A.n, h: A.h, fat: A.fat, rec: A.rec, pend: A.pend, vph: A.vph, fatFx: A.fatFx }; });
}
function tabelaMeses(meses){
  const rows = linhasTabela(meses).sort((a,b) => (a[_tabOrd.col] - b[_tabOrd.col]) * (_tabOrd.desc ? -1 : 1));
  const tot = rows.reduce((t,r) => ({ n:t.n+r.n, h:t.h+r.h, fat:t.fat+r.fat, rec:t.rec+r.rec, pend:t.pend+r.pend, fatPl:t.fatPl+(r.fat-r.fatFx) }), { n:0, h:0, fat:0, rec:0, pend:0, fatPl:0 });
  const col = (k, t) => `<th data-ord="${k}" class="${_tabOrd.col===k?'ord'+(_tabOrd.desc?' desc':''):''}">${t}</th>`;
  const mx = Math.max(...rows.map(r => r.fat), 1);
  $('#res-tabela').innerHTML = `<table class="tab">
    <thead><tr>${col('mes','Mês')}${col('n','Plant.')}${col('h','Horas')}${col('fat','Faturado')}${col('rec','Recebido')}${col('pend','A receber')}${col('vph','R$/h')}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.y===hoje().getFullYear() && r.m===hoje().getMonth()?'atual':''}"><td>${MES_CURTO[r.m]}/${String(r.y).slice(2)}</td><td>${r.n||'—'}</td><td>${r.h ? r.h+'h' : '—'}</td>
      <td class="bar" style="--p:${(r.fat/mx*100).toFixed(1)}%">${r.fat ? brl(r.fat) : '—'}</td><td>${r.rec ? brl(r.rec) : '—'}</td><td>${r.pend ? brl(r.pend) : '—'}</td><td>${r.vph ? brl(r.vph) : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${tot.n}</td><td>${tot.h}h</td><td>${brl(tot.fat)}</td><td>${brl(tot.rec)}</td><td>${brl(tot.pend)}</td><td>${tot.h ? brl(tot.fatPl/tot.h) : '—'}</td></tr></tfoot>
  </table>`;
  $('#res-tabela').dataset.meses = JSON.stringify(meses);
}
async function exportarPlanilha(){
  const meses = JSON.parse($('#res-tabela').dataset.meses || '[]');
  const num = v => (Math.round(v*100)/100).toFixed(2).replace('.', ',');
  const lin = [['Mês','Plantões','Horas','Plantões (R$)','Entradas fixas (R$)','Faturado (R$)','Recebido (R$)','A receber (R$)','R$ por hora']];
  linhasTabela(meses).forEach(r => lin.push([`${MES_CURTO[r.m]}/${r.y}`, r.n, r.h, num(r.fat - r.fatFx), num(r.fatFx), num(r.fat), num(r.rec), num(r.pend), num(r.vph)]));
  lin.push([], ['Lançamentos do período']);
  lin.push(['Data','Local','Categoria','Turno','Início','Horas','Valor líquido (R$)','Pago','Pago em']);
  const ini = `${meses[0].y}-${pad2(meses[0].m+1)}-01`, ult = meses[meses.length-1], fim = iso(new Date(ult.y, ult.m+1, 0));
  doPeriodo(ini, fim).filter(s => counts(s) || ehResid(s)).sort((a,b) => (a.data+(a.hora||'')).localeCompare(b.data+(b.hora||''))).forEach(s => {
    const d = parseDate(s.data);
    lin.push([`${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`, localName(s.localId), ehBolsa(s) ? 'Entrada fixa' : ehResid(s) ? 'Residência' : ehAmb(s) ? 'Consultório' : 'Plantão',
      ehBolsa(s) ? '' : s.turno, s.hora||'', +s.duracao||0, num(ehResid(s) ? 0 : liq(s)), s.pago ? 'sim' : 'não', s.pagoEm||'']);
  });
  const csv = '﻿' + lin.map(l => l.map(c => /[;"\n]/.test(String(c)) ? '"' + String(c).replace(/"/g,'""') + '"' : c).join(';')).join('\r\n');
  const nome = `plantae-${meses[0].y}-${pad2(meses[0].m+1)}_a_${ult.y}-${pad2(ult.m+1)}.csv`;
  const arq = new File([csv], nome, { type: 'text/csv' });
  if(navigator.canShare && navigator.canShare({ files:[arq] })){
    try{ await navigator.share({ files:[arq], title:'Plantaê! — planilha' }); return; }catch(e){ if(e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(arq); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Planilha salva · abre no Excel, Planilhas Google e Numbers');
}

/* plantões de colegas: um cartão com o saldo; a lista completa abre num toque */
function cartaoTrocas(itens){
  const pegos = itens.filter(s => counts(s) && s.tipo === 'peguei'), passados = itens.filter(s => s.tipo === 'passei');
  if(!pegos.length && !passados.length){ $('#res-trocas').innerHTML = ''; return; }
  const v = pegos.reduce((a,s)=>a+liq(s),0), saldo = pegos.length - passados.length;
  $('#res-trocas').innerHTML = `<button class="trocas-card" id="res-trocas-btn">
    <span class="tc-ico">⇄</span><span class="tc-txt"><b>Plantões de colegas</b><small>${pegos.length} pego${pegos.length===1?'':'s'} · ${passados.length} passado${passados.length===1?'':'s'} · saldo ${saldo>0?'+':''}${saldo}</small></span>
    <span class="money">${brl(v)}</span>${ICON_CHEV}</button>`;
  $('#res-trocas-btn').onclick = () => {
    const linha = s => { const d = parseDate(s.data); return `<div class="row"><div class="txt"><b>${esc(localName(s.localId))}</b><small>${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()} · ${s.tipo==='peguei'?'de':'para'} ${esc(s.colega||'colega')}</small></div><div class="val">${s.tipo==='peguei' ? brl(liq(s)) : '—'}</div></div>`; };
    const ord = a => a.slice().sort((x,y) => y.data.localeCompare(x.data));
    abrirDetalhe('Plantões de colegas', (pegos.length ? `<div class="sec" style="margin-top:0"><h2>Peguei (${pegos.length})</h2></div>${ord(pegos).map(linha).join('')}` : '')
      + (passados.length ? `<div class="sec"><h2>Passei (${passados.length})</h2></div>${ord(passados).map(linha).join('')}` : ''));
  };
}

$('#res-meses').addEventListener('click', e => {
  const r = e.target.closest('[data-mes]'); if(!r) return;
  _mesSel = _mesSel === r.dataset.mes ? null : r.dataset.mes; haptic(5);
  const periodo = document.querySelector('#res-periodo .on')?.dataset.rp || 'mes';
  graficoMeses(periodoResumo(periodo).meses);
});
$('#res-tabela').addEventListener('click', e => {
  const th = e.target.closest('[data-ord]'); if(!th) return;
  const c = th.dataset.ord; _tabOrd = { col: c, desc: _tabOrd.col === c ? !_tabOrd.desc : c !== 'mes' };
  tabelaMeses(JSON.parse($('#res-tabela').dataset.meses)); haptic(5);
});
$('#res-calor').addEventListener('click', e => {
  const r = e.target.closest('[data-hm]'); if(!r) return;
  const k = r.dataset.hm, its = S.shifts.filter(s => s.data === k && naAgenda(s) && !ehBolsa(s) && !ehBloq(s));
  const d = parseDate(k);
  toast(`${pad2(d.getDate())}/${pad2(d.getMonth()+1)}: ` + (its.length ? its.map(s => `${siglaLocal(s.localId)} ${s.duracao}h`).join(' + ') : 'livre'));
});
$('#res-csv').onclick = exportarPlanilha;

function renderLocais(){
  $('#loc-list').innerHTML = S.locais.length ? S.locais.map(l=>{
    const url = mapsUrl(l);
    const regra = l.pagIncerto
      ? `paga ${PAGMES[typeof l.pagMes==='number'?l.pagMes:1]}, dia a confirmar`
      : `paga dia ${l.pagDia||10} ${PAGMES[typeof l.pagMes==='number'?l.pagMes:1]}`;
    // só mostra valores preenchidos (consultório e renda fixa não têm valor de plantão)
    const sub = l.residencia ? [l.cidade, 'Residência · sem remuneração'].filter(Boolean).join(' · ')
      : [l.cidade, l.vDia ? `dia ${brl(l.vDia)}/12h` : '', l.vNoite ? `noite ${brl(l.vNoite)}/12h` : '', regra].filter(Boolean).join(' · ');
    return `<div class="row" data-loc="${l.id}">
      <div class="swatch" style="background:${l.cor}"></div>
      <div class="txt"><b>${esc(l.nome)}</b><small>${esc(sub)}</small></div>
      ${url?`<button class="iconbtn" data-map="${encodeURIComponent(url)}" aria-label="Abrir no mapa">${ICON_PIN}</button>`:''}
      <span class="iconbtn" style="background:none">${ICON_CHEV}</span></div>`;
  }).join('') : `<div class="empty">Nenhum local ainda.<br>Toque em + para cadastrar o primeiro hospital.</div>`;
}

function renderAjustes(){
  renderChangelog();
  chartPanel();
  histLocal();
  renderConferencia();
  renderMeta();
  renderProjecao();
  renderAvisosUI();
  renderPaletas();
  renderInstalar();
  renderTax();
  renderBackupInfo();
  renderHistorico();
  renderDiagnostico();
}

function renderBackupInfo(){
  let ultimo = null; try{ ultimo = localStorage.getItem('plantoes:lastBackup'); }catch(e){}
  const diasBk = ultimo ? Math.round((hoje() - parseDate(ultimo))/86400000) : null;
  const bkTxt = diasBk === null ? ' · nenhum backup baixado ainda'
              : diasBk === 0 ? ' · backup feito hoje'
              : ` · último backup há ${diasBk} dia${diasBk>1?'s':''}`;
  const si = $('#sync-info');
  si.textContent = (hasCloud
    ? 'Sincronizados na sua conta — abrem iguais no celular e no PC'
    : 'Guardados neste aparelho') + (hasCloud ? '' : bkTxt);
  si.style.color = (!hasCloud && (diasBk === null || diasBk > 30)) ? 'var(--due)' : '';
}

/* ================= referência tributária (IRPF 2026) ================= */
const IRPF = { isento: 5000, redutorAte: 7350 };
const CHANGELOG = [
  { v:'1.32', d:'Nov 2026', items:[
    { t:'new', txt:'Resumo com gráficos: mês a mês por local (toque no mês para ver os números), horas × valor da hora, mapa do ano e projeção de quanto o ano fecha' },
    { t:'new', txt:'Tabela mês a mês que ordena por qualquer coluna, com total — e “Exportar planilha” (abre no Excel, Planilhas Google e Numbers)' },
    { t:'new', txt:'Imagem do ano nova: post 4:5 ou stories 9:16, com gráfico dos meses, mapa dos dias, top 3 locais e comparação com o ano anterior' },
    { t:'new', txt:'Modo discreto na imagem do ano: mostra horas e plantões, sem nenhum valor em R$' },
    { t:'imp', txt:'Os números batem em todo lugar: plantões e entradas fixas (bolsa) aparecem separados; a residência conta só horas' },
    { t:'imp', txt:'Por local, diurno × noturno e dia da semana mostram onde e quando a hora rende mais' },
    { t:'imp', txt:'Plantões de colegas viraram um cartão com o saldo; a lista completa abre num toque' },
  ]},
  { v:'1.31', d:'Nov 2026', items:[
    { t:'new', txt:'Calendário mostra o plantão dentro do dia: sigla do local, ☀/☾, residência tracejada e bloqueio hachurado' },
    { t:'new', txt:'Tocar num dia mostra o que tem nele logo abaixo, com + Lançar' },
    { t:'imp', txt:'Lista compacta, uma linha por plantão, agrupada por semana com plantões e horas' },
    { t:'imp', txt:'Semana em linha do tempo de 0h a 24h — o noturno aparece atravessando a meia-noite' },
    { t:'imp', txt:'Métricas de volta em quadrado 2×2: plantões, horas, recebido e valor da hora' },
    { t:'new', txt:'Sigla do local (automática ou escolhida em Locais), para reconhecer sem depender da cor' },
    { t:'new', txt:'Plantões emendados: o dia mostra "40h seguidas" e avisa quando sobra pouco descanso até o próximo' },
    { t:'new', txt:'Lançar rápido no dia escolhido: seus plantões mais comuns viram atalhos de um toque' },
    { t:'imp', txt:'Deslize o dedo no calendário para trocar o mês, e na semana para trocar a semana; linha do "agora" na semana' },
  ]},
  { v:'1.30', d:'Nov 2026', items:[
    { t:'fix', txt:'Tocar no + depois de excluir algo desfazia a exclusão: o botão Desfazer ficava sobre o +, mesmo depois de o aviso sumir' },
  ]},
  { v:'1.29', d:'Nov 2026', items:[
    { t:'imp', txt:'Residência aparece como "Plantão noturno da residência" (ou diurno) na agenda, nos avisos e na lista' },
    { t:'new', txt:'Local da residência: marque em Locais e tudo lançado nele entra sem remuneração, sem campos de pagamento' },
  ]},
  { v:'1.28', d:'Nov 2026', items:[
    { t:'new', txt:'Plantão da residência no botão +: noturno obrigatório, sem remuneração, já com 19h, 12h e o Felício Rocho' },
    { t:'imp', txt:'Residência com turno, duração e trocas editáveis; entra na agenda, nos avisos e no Google Agenda, fora das contas' },
    { t:'fix', txt:'Lançar pelo botão + e fechar a tela voltava uma página a mais — no app instalado, podia sair do app' },
  ]},
  { v:'1.27', d:'Nov 2026', items:[
    { t:'new', txt:'Tema Automático, Claro ou Escuro em Ajustes → Aparência (Automático acompanha o celular)' },
  ]},
  { v:'1.26', d:'Nov 2026', items:[
    { t:'fix', txt:'Conta Google: o app dizia "sem permissão" mesmo com Agenda e Drive autorizados — agora confere direto no Google' },
  ]},
  { v:'1.25', d:'Nov 2026', items:[
    { t:'new', txt:'Paleta Daltonismo: azul para recebido e laranja para a receber, com símbolos ✓ e ○ — sem depender de verde e vermelho' },
  ]},
  { v:'1.24', d:'Nov 2026', items:[
    { t:'fix', txt:'Avisos rápidos (embaixo da tela) ilegíveis no tema escuro: agora sempre escuros com texto branco' },
  ]},
  { v:'1.23', d:'Nov 2026', items:[
    { t:'new', txt:'Google Agenda: os plantões numa agenda Plantaê! que aparece no Calendário Samsung — editar ou excluir atualiza, sem duplicar' },
    { t:'new', txt:'Backup automático no Google Drive (pasta oculta do app, últimas 30 cópias) e restaurar pelo Drive no celular novo' },
    { t:'new', txt:'Avisos com botões no Android: Recebi no dia do pagamento, Anotar perto do fim, Como chegar 1h antes' },
    { t:'new', txt:'Trava com digital ou rosto ao abrir o app' },
    { t:'imp', txt:'Os avisos são renovados em segundo plano, sem precisar abrir o app toda semana' },
  ]},
  { v:'1.22', d:'Nov 2026', items:[
    { t:'fix', txt:'Android: a faixa do gesto embaixo da tela não fica mais branca com o app escuro e no modo plantão' },
    { t:'fix', txt:'Avisos pelo servidor: o app podia guardar a configuração antiga do servidor e nunca ativar' },
    { t:'imp', txt:'Abre mais rápido: sem espera fixa na tela de abertura; com internet ruim, abre com a cópia do aparelho em até 3 s' },
    { t:'imp', txt:'Botão "Hoje" no lugar do ◦ na troca de mês; textos secundários mais legíveis no tema claro' },
  ]},
  { v:'1.21', d:'Out 2026', items:[
    { t:'new', txt:'Avisos pelo servidor: chegam mesmo com o app fechado (quando o servidor de avisos está configurado)' },
    { t:'imp', txt:'Ajustes → Avisos mostra como os avisos estão sendo entregues; o aviso de teste passa pelo servidor' },
    { t:'imp', txt:'Sem servidor ou sem internet, o app volta sozinho para os avisos com o app aberto' },
  ]},
  { v:'1.20', d:'Out 2026', items:[
    { t:'new', txt:'Pronto para Android (Galaxy): gesto Voltar fecha o que está aberto em vez de sair do app' },
    { t:'new', txt:'Ícone adaptativo do Android, ícone branco na barra de notificações e tela de instalação com capturas' },
    { t:'new', txt:'Enviar backup pelo WhatsApp/e-mail/Drive e guia para trocar de celular' },
    { t:'new', txt:'Botão Instalar app (Chrome), vibração ao tocar com opção de desligar, atalho Buscar no ícone' },
    { t:'imp', txt:'Teclado não cobre mais os campos; tocar no aviso abre o próprio plantão; botão + se recolhe ao rolar' },
    { t:'fix', txt:'Restaurar backup aceitava só um tipo de arquivo — backups vindos do WhatsApp/Drive apareciam desabilitados' },
  ]},
  { v:'1.19', d:'Out 2026', items:[
    { t:'new', txt:'Histórico de alterações: últimas 50 ações com Desfazer (Ajustes)' },
    { t:'new', txt:'Diagnóstico: o app registra erros do aparelho e gera um relatório para copiar ou compartilhar' },
    { t:'imp', txt:'Dados com número de versão e migrações passo a passo, com cópia de segurança antes de migrar' },
    { t:'imp', txt:'43 testes automáticos rodam a cada mudança publicada' },
  ]},
  { v:'1.18', d:'Out 2026', items:[
    { t:'new', txt:'Paletas: Clássico, Dia e Noite, Cirúrgico e Fintech (Ajustes → Aparência)' },
    { t:'new', txt:'Tela inicial nova: card principal com barra recebido × a receber, métricas compactas e faixa da semana' },
    { t:'new', txt:'Busca em todos os lançamentos (lupa no topo)' },
    { t:'new', txt:'Escala fixa: toda semana, a cada 2 semanas, todo mês no mesmo dia da semana (ex.: 2º sábado) ou no mesmo dia, até uma data' },
    { t:'new', txt:'Boas-vindas para quem abre o app pela primeira vez' },
    { t:'imp', txt:'Ícones desenhados na barra, números em Geist, fontes embutidas (abre offline), transição do card para a edição' },
    { t:'imp', txt:'Mais rápido: só a aba visível é redesenhada; código separado em arquivos' },
    { t:'imp', txt:'Meta anual e objetivo com formulário próprio (sem janela do navegador)' },
    { t:'fix', txt:'Cache offline era apagado a cada abertura por um script antigo' },
    { t:'fix', txt:'"Compartilhar meu ano" e "Seu ano em números" disparavam duas vezes' },
    { t:'fix', txt:'Valores com centavos na meta/objetivo viravam números enormes (1.500,50 → 150.050)' },
    { t:'fix', txt:'Layout de duas colunas no computador nunca aparecia' },
    { t:'fix', txt:'Caixa: nome e data grudados na linha do tempo; distribuição por local somava bruto' },
  ]},
  { v:'1.17', d:'Out 2026', items:[
    { t:'new', txt:'Seus frequentes: o app detecta os plantões que você repete e lança com um toque (no + e no topo do novo plantão)' },
    { t:'new', txt:'Saúde dos dados: avisa duplicados, conflitos de horário, lançamentos sem valor ou sem local e atrasos longos' },
    { t:'imp', txt:'Excluir agora é imediato, com Desfazer por 5 segundos (plantão, local, bloqueio e anotações)' },
  ]},
  { v:'1.16', d:'Out 2026', items:[
    { t:'new', txt:'Avisos 1h antes de começar e 30 min antes de terminar cada plantão (véspera às 20h opcional)' },
    { t:'new', txt:'Eventos exportados para o calendário levam os dois alarmes' },
    { t:'new', txt:'Ajustes → Avisos: estado, próximo aviso agendado e botão de teste' },
    { t:'fix', txt:'Avisos agora disparam pelo service worker — o método antigo não funcionava em app instalado' },
    { t:'fix', txt:'Card de tendência encostado na grade de métricas' },
    { t:'fix', txt:'Banner de próxima entrada somava todos os pendentes do local (ex.: bolsa até 2028); agora mostra só o que cai na data' },
  ]},
  { v:'1.15', d:'Out 2026', items:[
    { t:'new', txt:'Modo plantão: durante o plantão a tela inicial vira um painel com anel de horas, tempo restante e quanto já rendeu' },
    { t:'new', txt:'Tema preto (OLED) automático enquanto o painel está aberto; minimizar devolve o tema normal' },
    { t:'new', txt:'Anotações rápidas com horário durante o plantão, visíveis também na edição' },
    { t:'new', txt:'Card de plantão concluído com a previsão de quando o pagamento cai' },
    { t:'fix', txt:'Próximo plantão enxerga noturnos que começaram no dia anterior' },
  ]},
  { v:'1.14', d:'Out 2026', items:[
    { t:'fix', txt:'Confirmar recebimento pelo checklist da tela inicial voltava a "previsto"' },
    { t:'fix', txt:'Metas e valores de consultório se perdiam ao reabrir o app' },
    { t:'fix', txt:'Restaurar backup agora inclui bloqueios e metas' },
    { t:'imp', txt:'CSV no padrão do Excel brasileiro; aviso ao lançar em dia bloqueado' },
  ]},
  { v:'1.9', d:'Set 2026', items:[
    { t:'new', txt:'Redesign visual completo: paleta bege/verde-azulado/âmbar, tipografia Archivo 800, novo sistema de design' },
    { t:'new', txt:'Meta mensal com gauge circular e acompanhamento de progresso' },
    { t:'new', txt:'Registro rápido: banner de lançamento na tela inicial para o dia atual' },
    { t:'new', txt:'Conferência de 14 dias: grade com dias com e sem lançamentos' },
    { t:'new', txt:'Indicador de carga horária vs média histórica no hero' },
    { t:'new', txt:'Projeção de renda dos próximos 3 meses baseada no histórico real' },
    { t:'imp', txt:'Comparativo com mês anterior direto no hero (↑ ↓ vs mês passado)' },
  ]},
  { v:'1.8', d:'Set 2026', items:[
    { t:'new', txt:'Gráfico de barras + linha de 6 meses (faturado × recebido) em Ajustes' },
    { t:'new', txt:'Vista de Semana com grade visual e lançamento por clique' },
    { t:'new', txt:'Histórico por local: total, % recebido e prazo médio de pagamento' },
    { t:'new', txt:'Exportação CSV (ano ou completo) para contador ou Excel' },
  ]},
  { v:'1.7', d:'Set 2026', items:[
    { t:'imp', txt:'Tela principal mostra o que entra na conta este mês, não o faturado' },
    { t:'new', txt:'Checklist de confirmações pendentes na abertura do app' },
    { t:'new', txt:'Histórico de versões em Ajustes → Versões' },
    { t:'new', txt:'Bloqueio de agenda: férias, viagem, sobreaviso, compromisso' },
    { t:'new', txt:'Vista de dia com timeline vertical e navegação por data' },
    { t:'new', txt:'Marcação ⚠️ Atenção / Urgência por plantão' },
  ]},
  { v:'1.6', d:'Set 2026', items:[
    { t:'new', txt:'Vista de dia com timeline vertical' },
    { t:'new', txt:'Bloqueio de agenda: férias, viagem, sobreaviso, compromisso' },
    { t:'new', txt:'Marcação ⚠️ Atenção / Urgência por plantão' },
    { t:'imp', txt:'Cache v6 — ícone da Árvore de Andry aplicado corretamente' },
  ]},
  { v:'1.5', d:'Set 2026', items:[
    { t:'new', txt:'Categoria Ambulatório: contagem de consultas particulares, planos e procedimentos' },
    { t:'new', txt:'Renda fixa da residência: geração automática até fev/2028 no 2º dia útil' },
    { t:'fix', txt:'Pagamento dia 28 rola para o próximo dia útil (ex.: fev/2027 → 01/03)' },
  ]},
  { v:'1.4', d:'Set 2026', items:[
    { t:'new', txt:'Categoria Residência: agenda bloqueada, fora do financeiro, pontinho vazado no calendário' },
    { t:'new', txt:'Repetição por dias da semana (terça e sexta por N semanas)' },
    { t:'new', txt:'Conflito de horário com aviso antes de salvar' },
    { t:'new', txt:'Bruto × líquido + retenção na fonte por local' },
    { t:'new', txt:'Painel de referência tributária IRPF 2026 em Ajustes' },
    { t:'new', txt:'Locais sem dia de pagamento definido — referência no fim do mês' },
  ]},
  { v:'1.3', d:'Set 2026', items:[
    { t:'new', txt:'Aba Caixa: fluxo de entrada por data de pagamento, não de competência' },
    { t:'new', txt:'Bloco de atrasos com alerta quando o mês previsto fechou' },
    { t:'new', txt:'Regra de pagamento por local: dia fixo ou mês sem dia definido' },
    { t:'new', txt:'Exportação para Google Agenda e .ics (iPhone)' },
    { t:'new', txt:'Botão "Procurar lançamentos perdidos" em Ajustes' },
  ]},
  { v:'1.2', d:'Set 2026', items:[
    { t:'new', txt:'Localização dos hospitais: cidade, endereço e atalho para o app de mapas' },
    { t:'new', txt:'Cor de identificação por hospital' },
    { t:'new', txt:'Card do próximo plantão com botão "Como chegar"' },
    { t:'new', txt:'Filtro "A receber" na lista do mês' },
    { t:'imp', txt:'Menu lateral em telas largas + layout em duas colunas' },
    { t:'imp', txt:'Tema claro com fundo cinza-azulado' },
  ]},
  { v:'1.1', d:'Set 2026', items:[
    { t:'new', txt:'Valor baseado em 12h × duração: 24h = dobro automático' },
    { t:'new', txt:'Mini-calendário com pontinho por plantão' },
    { t:'new', txt:'Aba Locais com gerenciamento de hospitais e clínicas' },
    { t:'new', txt:'Aba Trocas com saldo por colega' },
    { t:'new', txt:'Backup .json + restauração' },
  ]},
  { v:'1.0', d:'Set 2026', items:[
    { t:'new', txt:'Lançamento inicial: plantões com data, local, turno, duração, valor e pagamento' },
    { t:'new', txt:'Resumo mensal com gauge de recebido × a receber' },
    { t:'new', txt:'PWA instalável com ícone na tela inicial' },
    { t:'new', txt:'Publicado em plantoes-asevedo.vercel.app com atualização automática via GitHub' },
  ]},
];

/* ─── GRADE SEMANAL ─── */
let semanaAtual = new Date();
// domingo da semana atual
function domingoSemana(d){ const x=new Date(d); x.setDate(x.getDate()-x.getDay()); x.setHours(0,0,0,0); return x; }

/* Semana em linha do tempo: uma linha por dia, régua de 0 a 24h e uma barra por plantão,
   com sigla e horário. O noturno aparece atravessando a meia-noite (continua no dia seguinte). */
function renderSemana(){
  const box = $('#week-view');
  if(viewTipo !== 'semana'){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#shift-list').classList.add('hidden');
  $('#day-view').classList.add('hidden');
  $$('#filter button').forEach(b=>b.closest('.segs').classList.add('hidden'));

  const dom = domingoSemana(semanaAtual);
  const dias = Array.from({length:7}, (_,i)=>{ const d = new Date(dom); d.setDate(d.getDate()+i); return d; });
  const hj = iso(hoje()), DIA = 86400000;
  const titulo = `${pad2(dias[0].getDate())}/${pad2(dias[0].getMonth()+1)} – ${pad2(dias[6].getDate())}/${pad2(dias[6].getMonth()+1)}`;
  // inclui o dia anterior à semana: um noturno de sábado continua no domingo
  const desde = new Date(dom); desde.setDate(desde.getDate()-1);
  const fonte = S.shifts.filter(s => naAgenda(s) && !ehBolsa(s) && !ehBloq(s) && s.data >= iso(desde) && s.data <= iso(dias[6]));
  let nPl = 0, horas = 0;
  fonte.forEach(s => { if(s.data >= iso(dom)){ nPl++; horas += (+s.duracao||0); } });
  const hh = d => pad2(d.getHours()) + (d.getMinutes() ? ':'+pad2(d.getMinutes()) : 'h');

  const linhas = dias.map(d => {
    const ds = iso(d), d0 = d.getTime(), d1 = d0 + DIA, bl = bloqueioDoDia(ds);
    const barras = fonte.map(s => {
      const { ini, f } = evJanela(s);
      const a = Math.max(ini.getTime(), d0), b = Math.min(f.getTime(), d1);
      if(b <= a) return '';
      const left = (a - d0) / DIA * 100, larg = (b - a) / DIA * 100;
      const cont = ini.getTime() < d0, segue = f.getTime() > d1;
      const rot = larg >= 34 ? ` ${cont ? '…' : hh(ini)}–${segue ? '…' : hh(f)}` : '';
      return `<button class="tl-bar ${ehResid(s)?'resid':''} ${cont?'cont':''} ${segue?'segue':''}" data-id="${s.id}" style="--c:${localCor(s.localId)};left:${left}%;width:${larg}%"
        aria-label="${esc(localName(s.localId))}, ${hh(ini)} a ${hh(f)}">${s.turno==='noturno'?ICON_MOON:ICON_SUN}<b>${esc(siglaLocal(s.localId))}</b>${rot}</button>`;
    }).join('');
    const agora = ds === hj ? `<i class="tl-agora" style="left:${((Date.now() - d0) / DIA * 100).toFixed(2)}%" title="Agora"></i>` : '';
    return `<div class="tl-row ${ds===hj?'hoje':''}">
      <div class="tl-d"><span>${WD[d.getDay()]}</span><b>${d.getDate()}</b></div>
      <div class="tl-track ${bl?'bl':''}" data-dia="${ds}">${bl && !barras ? `<em>${NOME_BLOQ_CAL[bl.motivo]||'Bloqueio'}</em>` : ''}${barras}${agora}</div>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="tl-nav">
      <button class="wk-arrow" data-sem="-7" aria-label="Semana anterior">‹</button>
      <b>${titulo}</b>
      <button class="wk-arrow" data-sem="7" aria-label="Próxima semana">›</button>
      <button class="tl-hoje" data-sem="0">Hoje</button>
    </div>
    <div class="tl">
      <div class="tl-axis"><span style="left:0">0h</span><span style="left:25%">6h</span><span style="left:50%">12h</span><span style="left:75%">18h</span><span style="left:100%">24h</span></div>
      ${linhas}
    </div>
    <p class="tl-tot">${nPl ? `${nPl} ${nPl===1?'plantão':'plantões'} · ${horas}h na semana` : 'Semana livre'} · toque num dia vazio para lançar</p>`;
}
$('#week-view').addEventListener('click', e => {
  const sem = e.target.closest('[data-sem]');
  if(sem){ const n = +sem.dataset.sem; if(n) semanaAtual.setDate(semanaAtual.getDate()+n); else semanaAtual = new Date(); renderSemana(); haptic(5); return; }
  const bar = e.target.closest('.tl-bar');
  if(bar){ openSheet(S.shifts.find(x => x.id === bar.dataset.id)); return; }
  const tr = e.target.closest('[data-dia]');
  if(tr) openSheet(null, tr.dataset.dia);
});

/* ─── GRÁFICOS ─── */
function mesesRetroativos(n){
  const out=[];
  const d=new Date();
  for(let i=n-1;i>=0;i--){
    const ref=new Date(d.getFullYear(),d.getMonth()-i,1);
    out.push({y:ref.getFullYear(),m:ref.getMonth(),label:MES[ref.getMonth()].slice(0,3)});
  }
  return out;
}

function chartPanel(){
  const meses=mesesRetroativos(6);
  const fab=m=>S.shifts.filter(s=>counts(s)&&parseDate(dataCaixa(s)).getMonth()===m.m&&parseDate(dataCaixa(s)).getFullYear()===m.y);
  const dados=meses.map(m=>{
    const arr=fab(m);
    return {
      label:m.label,
      fat: arr.reduce((a,s)=>a+liq(s),0),
      rec: arr.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0),
      n:   arr.length,
    };
  });

  const maxVal=Math.max(...dados.map(d=>d.fat),1);
  const W=320,H=160,pad={t:10,r:16,b:36,l:52};
  const gW=W-pad.l-pad.r, gH=H-pad.t-pad.b;
  const barW=Math.floor(gW/dados.length*0.55);
  const x=i=>pad.l+i*(gW/dados.length)+gW/dados.length/2;
  const y=v=>pad.t+gH*(1-v/maxVal);
  const ticks=4;

  // eixo Y
  let yAxis='';
  for(let i=0;i<=ticks;i++){
    const val=maxVal*i/ticks;
    const yy=y(val);
    yAxis+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`;
    yAxis+=`<text x="${pad.l-5}" y="${yy+4}" text-anchor="end" font-size="10" fill="var(--dim)">${val>=1000?(val/1000).toFixed(val%1000?1:0)+'k':val}</text>`;
  }

  // barras (faturado) e barras sobrepostas (recebido)
  let bars='', recBars='', pts=[], ptsFat=[];
  dados.forEach((d,i)=>{
    const bh=gH*(d.fat/maxVal);
    const bhr=gH*(d.rec/maxVal);
    bars+=`<rect x="${x(i)-barW/2}" y="${y(d.fat)}" width="${barW}" height="${bh}" rx="3" fill="var(--accent)" opacity=".22"/>`;
    recBars+=`<rect x="${x(i)-barW/2}" y="${y(d.rec)}" width="${barW}" height="${bhr}" rx="3" fill="var(--accent)" opacity=".7"/>`;
    pts.push([x(i),y(d.rec)]);
    ptsFat.push([x(i),y(d.fat)]);
    bars+=`<text x="${x(i)}" y="${H-pad.b+16}" text-anchor="middle" font-size="10.5" fill="var(--dim)">${d.label}</text>`;
  });

  // linhas
  const linha=(pts,cor,op)=>{
    if(pts.length<2) return '';
    const d='M'+pts.map(p=>p.join(',')).join('L');
    return `<path d="${d}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" opacity="${op}"/>`;
  };
  const pontos=(pts,cor)=>pts.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${cor}"/>`).join('');

  const svg=`<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    ${yAxis}${bars}${recBars}
    ${linha(ptsFat,'var(--accent)',0.35)}
    ${linha(pts,'var(--accent)',1)}
    ${pontos(pts,'var(--accent)')}
  </svg>`;

  const totalFat=dados.reduce((a,d)=>a+d.fat,0);
  const totalRec=dados.reduce((a,d)=>a+d.rec,0);
  const pctGlobal=totalFat?Math.round(totalRec/totalFat*100):0;

  $('#chart-panel').innerHTML=`
    <div class="chart-wrap">
      <div class="chart-title">
        <strong>Faturado × Recebido</strong>
        <span>${pctGlobal}% recebido</span>
      </div>
      ${svg}
      <div class="chart-leg">
        <span><i style="background:var(--accent);opacity:.3"></i>Faturado</span>
        <span><i style="background:var(--accent)"></i>Recebido</span>
      </div>
    </div>
    <div class="row" style="padding:10px 0">
      <div class="txt"><b>Total faturado</b><small>6 meses</small></div>
      <div class="val">${brl(totalFat)}</div>
    </div>
    <div class="row" style="padding:10px 0;border-bottom:0">
      <div class="txt"><b>Total recebido</b><small>6 meses</small></div>
      <div class="val" style="color:var(--ok)">${brl(totalRec)}</div>
    </div>`;
}

/* ─── EXPORTAÇÃO CSV ─── */
// CSV no padrão do Excel brasileiro: separador ";" e vírgula decimal.
// Antes: nomes saíam com entidades HTML (&amp;) e vírgulas quebravam colunas.
const csvCel = v => { const t = String(v ?? ''); return /[";\n\r]/.test(t) ? '"'+t.replace(/"/g,'""')+'"' : t; };
const csvNum = n => (+n||0).toFixed(2).replace('.',',');
function gerarCSV(shifts){
  const lin=['Data;Local;Cidade;Turno;Duração (h);Bruto (R$);Líquido (R$);Pago;Data recebimento;Vencimento;Categoria;Observação'];
  shifts.filter(counts).sort((a,b)=>a.data.localeCompare(b.data)).forEach(s=>{
    const l=getLocal(s.localId)||{nome:'',cidade:''};
    lin.push([
      s.data, l.nome, l.cidade||'', ehBolsa(s)?'':s.turno, s.duracao||0,
      csvNum(bru(s)), csvNum(liq(s)), s.pago?'Sim':'Não', s.pagoEm||'', vencimento(s),
      s.categoria||'remunerado', s.obs||''
    ].map(csvCel).join(';'));
  });
  return lin.join('\r\n');
}
// Safari cancela o download se o blob URL for revogado no mesmo tick do click
function baixarBlob(blob, nome){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
function baixarCSV(conteudo,nome){
  baixarBlob(new Blob(['﻿'+conteudo],{type:'text/csv;charset=utf-8'}), nome);
  toast('CSV gerado');
}

/* ─── CONFERÊNCIA 14 DIAS ─── */
function renderConferencia(){
  const hj=hoje(); const dias=[];
  for(let i=13;i>=0;i--){ const d=new Date(hj); d.setDate(d.getDate()-i); dias.push(d); }
  const html=dias.map(d=>{
    const dStr=iso(d); const isHj=dStr===iso(hj);
    const fut=d>hj; const tem=S.shifts.some(s=>naAgenda(s)&&s.data===dStr&&!fut);
    const cls=fut?'futuro':tem?'tem':'vazio';
    return `<div class="conf-day ${cls}${isHj?' hoje':''}" data-day="${dStr}" title="${dStr}">${d.getDate()}</div>`;
  }).join('');
  $('#conf-grid-wrap').innerHTML=`<div class="conf-grid">${html}</div>`;
  $$('#conf-grid-wrap .conf-day').forEach(el=>{
    if(!el.classList.contains('futuro'))
      el.onclick=()=>{ if(!el.classList.contains('tem')) openSheet(null,el.dataset.day); };
  });
}

/* ─── META MENSAL ─── */
function renderMeta(){
  const meta=S.metaMensal||0;
  const hj=hoje(); const noMes=S.shifts.filter(counts).filter(s=>{
    const d=parseDate(dataCaixa(s));
    return d.getMonth()===hj.getMonth()&&d.getFullYear()===hj.getFullYear();
  });
  const fat=noMes.reduce((a,s)=>a+liq(s),0);
  const pct=meta?Math.min(100,Math.round(fat/meta*100)):0;
  const r=40,cx=48,cy=48,circ=2*Math.PI*r;
  const dash=circ*(pct/100), gap=circ-dash;
  const corArc=fat>=meta?'var(--ok)':'var(--accent)';
  if($('#meta-input')) $('#meta-input').value=meta||'';
  $('#meta-wrap').innerHTML=meta?`
    <div class="meta-ring">
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="8"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${corArc}" stroke-width="8"
          stroke-dasharray="${dash} ${gap}" stroke-linecap="round"
          transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dasharray .5s ease"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
          font-size="15" font-weight="800" fill="${corArc}" font-family="'Inter',sans-serif">${pct}%</text>
      </svg>
      <div class="mr-txt">
        <b>${brl(fat)}</b>
        <small>de ${brl(meta)} · ${fat>=meta?'Meta batida! 🎉':'faltam '+brl(meta-fat)}</small>
      </div>
    </div>` : `<div class="empty">Defina uma meta mensal abaixo para acompanhar o progresso.</div>`;
}
$('#btn-notif').onclick = pedirPermissaoNotif;

$('#meta-salvar').onclick=async()=>{
  const v=parseFloat($('#meta-input').value)||0;
  S.metaMensal=v; await store.save(S); haptic(10); renderMeta(); toast(v?'Meta salva':'Meta removida');
};

/* ─── PROJEÇÃO 3 MESES ─── */
function renderProjecao(){
  const meses=mesesRetroativos(6);
  const historico=meses.map(m=>{
    const arr=S.shifts.filter(s=>counts(s)&&parseDate(dataCaixa(s)).getMonth()===m.m&&parseDate(dataCaixa(s)).getFullYear()===m.y);
    return arr.reduce((a,s)=>a+liq(s),0);
  }).filter(v=>v>0);
  if(historico.length<2){ $('#proj-wrap').innerHTML=`<div class="empty">Com 2+ meses de dados aparece aqui a projeção dos próximos 3 meses.</div>`; return; }
  const media=historico.reduce((a,v)=>a+v,0)/historico.length;
  const desv=Math.sqrt(historico.reduce((a,v)=>a+(v-media)**2,0)/historico.length);
  const mesesFut=[];
  for(let i=1;i<=3;i++){
    const ref=new Date(); ref.setDate(1); ref.setMonth(ref.getMonth()+i);
    mesesFut.push({label:MES[ref.getMonth()]+' '+ref.getFullYear()});
  }
  $('#proj-wrap').innerHTML=mesesFut.map(m=>`
    <div class="proj-card">
      <div class="pc-label">— ${m.label}</div>
      <div class="pc-range">${brl(Math.max(0,media-desv))} – ${brl(media+desv)}</div>
      <div class="pc-base">Média histórica: ${brl(media)} · variação: ±${brl(desv)}</div>
    </div>`).join('');
}

function histLocal(){
  const locTotais=S.locais.map(l=>{
    const arr=S.shifts.filter(s=>counts(s)&&s.localId===l.id);
    const fat=arr.reduce((a,s)=>a+liq(s),0);
    const rec=arr.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0);
    const n=arr.length;
    // média de dias entre plantão e recebimento (só os pagos com data)
    const pagos=arr.filter(s=>s.pago&&s.pagoEm&&s.data);
    const mediaDias=pagos.length
      ? Math.round(pagos.reduce((a,s)=>a+(parseDate(s.pagoEm)-parseDate(s.data))/86400000,0)/pagos.length)
      : null;
    return {l,fat,rec,n,mediaDias};
  }).filter(x=>x.n>0).sort((a,b)=>b.fat-a.fat);
  const maxFat=Math.max(...locTotais.map(x=>x.fat),1);
  $('#hist-local').innerHTML=locTotais.length?locTotais.map(x=>`
    <div class="row" style="flex-direction:column;align-items:stretch;cursor:default;padding:12px 0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div class="swatch" style="background:${x.l.cor}"></div>
        <div class="txt"><b>${esc(x.l.nome)}</b><small>${x.n} ${x.n>1?'lançamentos':'lançamento'}</small></div>
        <div class="val">${brl(x.fat)}</div>
      </div>
      <div class="hist-bar"><i style="width:${Math.round(x.fat/maxFat*100)}%"></i></div>
      <div style="display:flex;justify-content:space-between;margin-top:5px">
        <span style="font-size:11.5px;color:var(--dim)">Recebido ${brl(x.rec)} (${x.fat?Math.round(x.rec/x.fat*100):0}%)</span>
        ${x.mediaDias!==null?`<span style="font-size:11.5px;color:var(--dim)">Paga em ~${x.mediaDias} dias</span>`:''}
      </div>
    </div>`).join('')
    :`<div class="empty">Lance plantões para ver o histórico por local.</div>`;
}

function renderChangelog(){
  const renderVersao = v=>`
    <div class="cl-version">
      <div class="cl-tag">
        <span class="v">v${v.v}</span>
        <span class="d">${v.d}</span>
      </div>
      <div class="cl-items">
        ${v.items.map(i=>`<div class="cl-item">
          <span class="badge badge-${i.t}">${i.t==='new'?'Novo':i.t==='fix'?'Correção':'Melhoria'}</span>
          <span>${i.txt}</span>
        </div>`).join('')}
      </div>
    </div>`;
  const primeira = CHANGELOG[0];
  const resto = CHANGELOG.slice(1);
  $('#changelog-list').innerHTML =
    renderVersao(primeira) +
    (resto.length ? `
      <div id="cl-mais-wrap" class="hidden" style="margin-top:4px">
        ${resto.map(renderVersao).join('')}
      </div>
      <button class="btn sm wide" id="cl-mais" style="margin-top:12px;color:var(--dim);border-color:var(--line)">
        Ver versões anteriores (${resto.length})
      </button>` : '');
  const btn = $('#cl-mais');
  if(btn) btn.onclick = ()=>{
    $('#cl-mais-wrap').classList.remove('hidden');
    btn.style.display='none';
  };
}

function renderTax(){
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const recebidos = S.shifts.filter(s => counts(s) && s.pago);
  const noMes = recebidos.filter(s=>{ const d = parseDate(dataCaixa(s)); return d.getMonth()===m && d.getFullYear()===y; });
  const noAno = recebidos.filter(s=> parseDate(dataCaixa(s)).getFullYear()===y);
  const vMes = noMes.reduce((a,s)=>a+liq(s),0);
  const vAno = noAno.reduce((a,s)=>a+liq(s),0);

  const faixa = vMes <= IRPF.isento ? 'dentro da faixa isenta'
              : vMes <= IRPF.redutorAte ? 'na faixa com redutor parcial'
              : 'acima do redutor — tributação integral';
  const cor = vMes <= IRPF.isento ? 'var(--ok)' : vMes <= IRPF.redutorAte ? 'var(--dia)' : 'var(--due)';
  const pct = Math.min(100, vMes / IRPF.redutorAte * 100);

  $('#tax-panel').innerHTML = `
    <div class="row"><div class="txt"><b>Recebido em ${MES[m]}</b><small style="color:${cor}">${faixa}</small></div>
      <div class="val">${brl(vMes)}</div></div>
    <div class="taxbar"><i style="width:${pct}%;background:${cor}"></i></div>
    <div class="row" style="border-bottom:0"><div class="txt"><small>Isenção mensal ${brl(IRPF.isento)} · redutor até ${brl(IRPF.redutorAte)}</small></div></div>
    <div class="row"><div class="txt"><b>Recebido em ${y}</b><small>soma do que já caiu na conta</small></div><div class="val">${brl(vAno)}</div></div>`;
}

/* ================= sheet plantão ================= */
function chipSet(sel,v){ $$(sel+' .chip').forEach(c=>c.classList.toggle('on',c.dataset.v===String(v))); }
function chipGet(sel){ const c = document.querySelector(sel+' .chip.on'); return c ? c.dataset.v : null; }

function fillLocalSelect(sel){
  $('#f-local').innerHTML = S.locais.map(l=>`<option value="${l.id}">${esc(l.nome)}${l.cidade?' — '+esc(l.cidade):''}</option>`).join('')
    + `<option value="__new">+ Cadastrar novo local</option>`;
  if(sel) $('#f-local').value = sel;
}
function fillColegas(){
  const set = [...new Set(S.shifts.map(s=>(s.colega||'').trim()).filter(Boolean))].sort();
  $('#colegas').innerHTML = set.map(c=>`<option value="${esc(c)}">`).join('');
}
function janela(){
  const dur = duracaoAtual(), h = $('#f-hora').value;
  let t = h && dur ? `Plantão de ${h} até ${fim(h,dur)} · ${dur} horas` : '—';
  const base = base12();
  if(base && dur && !valorTouched){
    const mult = (dur/12).toLocaleString('pt-BR',{maximumFractionDigits:2});
    t += ` · valor calculado como ${mult}× o plantão de 12h (${brl(base)})`;
  }
  $('#janela').textContent = t;
}

// local sugerido num lançamento novo: o do último lançamento da mesma categoria
// (antes era sempre o primeiro local cadastrado, mesmo que nunca usado para aquilo)
function localPadrao(cat){
  const resid = cat === 'residencia';
  const ok = l => l && (resid || !l.residencia);
  const ult = S.shifts.filter(s => (s.categoria||'remunerado') === cat && ok(getLocal(s.localId)))
                      .sort((a,b) => b.data.localeCompare(a.data))[0];
  if(ult) return ult.localId;
  if(resid){
    const h = S.locais.find(l => l.residencia) || S.locais.find(l => /felicio\s*rocho/i.test(semAcentoLocal(l.nome)));
    return h ? h.id : '__new';
  }
  return (S.locais.find(l => !l.residencia) || {}).id || '__new';
}
const semAcentoLocal = t => String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
// escolher no formulário um local da residência já troca a categoria (sem campos de valor)
function categoriaPeloLocal(){
  const l = getLocal($('#f-local').value), cat = chipGet('#f-cat');
  if(l && l.residencia && cat !== 'residencia' && cat !== 'bolsa'){ chipSet('#f-cat', 'residencia'); aplicarCategoria(); }
}
// plantão noturno obrigatório da residência: já abre com noturno, 19h, 12h e o hospital
function novoPlantaoResidencia(data){
  openSheet(null, data || null, 'residencia');
  chipSet('#f-turno', 'noturno'); $('#f-hora').value = '19:00';
  chipSet('#f-dur', '12'); $('#f-durc-wrap').classList.add('hidden');
  if($('#f-local').value === '__new'){ $('#f-newlocal-wrap').classList.remove('hidden'); $('#f-newlocal').value = 'Hospital Felício Rocho'; }
  janela();
}
function openSheet(shift, presetDate, presetCategoria){
  editing = shift || null;
  valorTouched = !!shift;
  $('#sh-title').textContent = shift ? 'Editar plantão' : 'Novo plantão';
  $('#sh-del').classList.toggle('hidden', !shift);
  $('#cal-row').classList.toggle('hidden', !shift);
  $('#f-rep-wrap').classList.toggle('hidden', !!shift);
  $('#f-rep').value = '0';
  fillColegas();

  const s = shift || {
    data: presetDate || iso(new Date()), localId: localPadrao(presetCategoria || 'remunerado'),
    turno:'diurno', duracao:12, hora:'07:00', valor:'', pago:false,
    tipo:'meu', colega:'', contra:'devolver', quitado:false, obs:'',
    categoria: presetCategoria || 'remunerado', liquido:'', urgente:false, blTipo:'ferias', blFim:''
  };

  fillLocalSelect(s.localId);
  $('#f-date').value = s.data;
  $('#f-hora').value = s.hora || '07:00';
  $('#f-valor').value = s.valor ?? '';
  $('#f-obs').value = s.obs || '';
  $('#f-colega').value = s.colega || '';
  $('#f-newlocal').value = '';
  $('#f-newlocal-wrap').classList.toggle('hidden', s.localId !== '__new');

  chipSet('#f-turno', s.turno);
  const preset = [6,12,24,36].includes(+s.duracao);
  chipSet('#f-dur', preset ? String(s.duracao) : 'custom');
  $('#f-durc-wrap').classList.toggle('hidden', preset);
  $('#f-durc').value = preset ? 8 : s.duracao;

  chipSet('#f-cat', s.categoria || 'remunerado');
  const lAtual = getLocal(s.localId) || {};
  // bloqueio agora em sheet separado
  $('#f-npart').value  = s.nPart  || 0;
  $('#f-nplano').value = s.nPlano || 0;
  $('#f-nproc').value  = s.nProc  || 0;
  $('#f-vpart').value  = s.vPart  || lAtual.vPart  || 70;
  $('#f-vplano').value = s.vPlano || lAtual.vPlano || 50;
  $('#f-vproc').value  = s.vProc  || lAtual.vProc  || 0;
  liqTouched = !!shift; conflitoOk = false;
  $('#f-urgente').classList.toggle('on', !!(shift && shift.urgente));
  $('#f-liquido').value = (s.liquido ?? '') === '' ? (s.valor ?? '') : s.liquido;
  $$('#f-wd .chip').forEach(c=>c.classList.remove('on'));
  $('#f-wd-wrap').classList.add('hidden');
  $('#f-rep-ate-wrap').classList.add('hidden'); $('#f-rep-ate').value = '';
  $('#rep-hint').textContent = '—';
  aplicarCategoria();
  if(!shift) categoriaPeloLocal();
  chipSet('#f-tipo', s.tipo);
  chipSet('#f-contra', s.contra || 'devolver');
  $('#troca-wrap').classList.toggle('hidden', s.tipo === 'meu');
  $('#f-pago').classList.toggle('on', !!s.pago);
  $('#f-pagoem-wrap').classList.toggle('hidden', !s.pago);
  $('#f-pagoem').value = s.pagoEm || iso(new Date());
  vencTouched = !!s.venc;
  $('#f-venc').value = s.venc || vencimento(s);
  atualizarVenc();
  $('#f-quitado').classList.toggle('on', !!s.quitado);
  contraHint(); janela();
  renderNotasSheet(shift);
  renderModelosSheet(!shift);

  $('#sheet').classList.add('open'); $('#scrim').classList.add('open');
  lockScroll();
  if(!shift) autoValor();
}

function closeSheets(){
  $$('.sheet.open').forEach(el=>el.classList.remove('open')); // inclui #sheet-bl
  $('#scrim').classList.remove('open');
  editing = null; editingLocal = null; calAlvo = null; editingBloq = null;
  unlockScroll();
}

// bloqueia scroll da página enquanto um sheet está aberto.
// Idempotente: abrir um sheet por cima de outro não sobrescreve a posição salva
// (antes, scrollY já era 0 com o body fixo e a página voltava ao topo ao fechar).
let _scrollY = 0, _locked = false;
function lockScroll(){
  if(_locked) return;
  _locked = true;
  abrirCamadaHist();
  _scrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_scrollY}px`;
  document.body.style.width = '100%';
}
function unlockScroll(){
  if(!_locked) return;
  _locked = false;
  fecharCamadaHist();
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo({top: _scrollY, behavior: 'instant'});
}

/* ================= botão / gesto Voltar (Android) =================
   Sem isto, Voltar com um sheet aberto fechava o app inteiro. Cada camada
   aberta (sheet, menu do +, retrospectiva, imagem, boas-vindas) ocupa uma
   entrada no histórico: Voltar fecha a camada. Fora da aba Mês, Voltar
   leva de volta a ela. No iPhone (sem botão Voltar) nada muda.           */
let _histCamada = false, _histAba = false, _ignorarPop = 0, _porVoltar = false;
function abrirCamadaHist(){ if(_histCamada) return; _histCamada = true; history.pushState({ plantoes:'camada' }, ''); }
function fecharCamadaHist(){
  if(!_histCamada) return;
  _histCamada = false;
  if(!_porVoltar) voltarConsumir();      // fechado pela tela: remove a entrada que a camada criou
}
function voltarConsumir(){ _ignorarPop++; history.back(); }
function fecharCamadaTopo(){
  const ov = document.getElementById('img-overlay'); if(ov){ ov.remove(); return true; }
  if($('#welcome')){ const b = $('#wl-skip'); if(b) b.click(); return true; }
  if($('#wrapped-sheet').classList.contains('open')){ closeWrapped(); return true; }
  if($('#fab-menu')){ $('#fab-menu').remove(); return true; }
  if(document.querySelector('.sheet.open')){ closeSheets(); return true; }
  return false;
}
window.addEventListener('popstate', ()=>{
  if(_ignorarPop > 0){ _ignorarPop--; return; }
  if(_histCamada){
    _histCamada = false; _porVoltar = true;
    try{ fecharCamadaTopo(); } finally { _porVoltar = false; }
    const ainda = document.querySelector('.sheet.open') || $('#wrapped-sheet').classList.contains('open') || $('#welcome') || $('#fab-menu');
    if(ainda) abrirCamadaHist();          // ainda há outra camada por baixo: o próximo Voltar fecha ela
    else if(_locked){ _locked = false; document.body.style.position = ''; document.body.style.top = ''; document.body.style.width = ''; window.scrollTo({ top:_scrollY, behavior:'instant' }); }
    return;
  }
  if(_histAba){ _histAba = false; const b = document.querySelector('nav button[data-v="mes"]'); if(b) b.click(); }
});

// Esc fecha qualquer sheet/overlay (desktop)
document.addEventListener('keydown', e=>{
  if(e.key !== 'Escape') return;
  const ov = document.getElementById('img-overlay');
  if(ov){ ov.remove(); return; }
  if($('#wrapped-sheet').classList.contains('open')){ closeWrapped(); return; }
  if($('#fab-menu')){ $('#fab-menu').remove(); return; }
  if(document.querySelector('.sheet.open')) closeSheets();
});

// Bloqueia gesto de navegação horizontal do iOS dentro dos sheets
// (swipe da borda esquerda que desloca toda a view horizontalmente)
(function initSheetHorizontalBlock(){
  let _tx = 0, _ty = 0;
  document.addEventListener('touchstart', e => {
    if(!document.querySelector('.sheet.open, #scrim.open')) return;
    _tx = e.touches[0].clientX;
    _ty = e.touches[0].clientY;
  }, {passive: true});

  document.addEventListener('touchmove', e => {
    if(!document.querySelector('.sheet.open, #scrim.open')) return;
    // não bloqueia contêineres que rolam na horizontal de propósito
    for(let n = e.target; n && n !== document.body; n = n.parentElement){
      if(n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return;
    }
    const dx = Math.abs(e.touches[0].clientX - _tx);
    const dy = Math.abs(e.touches[0].clientY - _ty);
    // se o gesto é predominantemente horizontal, bloqueia
    if(dx > dy && dx > 5){
      e.preventDefault();
    }
  }, {passive: false});
})();

function duracaoAtual(){
  const sel = chipGet('#f-dur');
  return sel === 'custom' ? (parseInt($('#f-durc').value) || 0) : parseInt(sel);
}
function base12(){
  const l = getLocal($('#f-local').value);
  if(!l) return 0;
  return (chipGet('#f-turno') === 'noturno' ? l.vNoite : l.vDia) || 0;
}
function aplicarCategoria(){
  const cat = chipGet('#f-cat');
  const resid = cat === 'residencia', amb = cat === 'ambulatorio', bolsa = cat === 'bolsa';

  // Turno e Duração: só a renda fixa não tem (residência tem horário e duração reais)
  $('#f-turno-wrap').classList.toggle('hidden', bolsa);
  // Origem (meu / peguei / passei): trocas também acontecem entre residentes
  $('#f-origem-wrap').classList.toggle('hidden', bolsa);
  $('#resid-hint').classList.toggle('hidden', !resid);
  // Repetir: ocultar para renda fixa ou quando editando
  $('#f-rep-wrap').classList.toggle('hidden', bolsa || !!editing);

  // Seção financeira
  if(bolsa){
    // Renda fixa: mostrar valor/líquido E o bloco financeiro completo (pago + recebido em + vencimento)
    $('#f-valor-wrap').classList.remove('hidden');
    $('#f-liq-wrap').classList.remove('hidden');
    $('#fin-wrap').classList.remove('hidden');
  } else {
    // Comportamento original: residência esconde valor/líquido/fin
    ['#f-valor-wrap','#f-liq-wrap','#fin-wrap'].forEach(sel=>$(sel).classList.toggle('hidden', resid));
  }

  $('#amb-wrap').classList.toggle('hidden', !amb);

  const nomes = { residencia:'plantão da residência', ambulatorio:'dia de atendimento', remunerado:'plantão', bolsa:'renda fixa' };
  $('#sh-title').textContent = (editing ? 'Editar ' : 'Novo ') + (nomes[cat] || 'plantão');
  if(amb) calcAmb();
}

// no ambulatório o valor vem da produção do dia
function calcAmb(){
  const n = id => parseInt($(id).value) || 0;
  const v = id => parseFloat($(id).value) || 0;
  const part = n('#f-npart') * v('#f-vpart');
  const plano = n('#f-nplano') * v('#f-vplano');
  const proc = n('#f-nproc') * v('#f-vproc');
  const total = Math.round((part + plano + proc) * 100) / 100;
  $('#f-valor').value = total || '';
  liqTouched = false; autoLiquido();
  const p = [];
  if(part)  p.push(`${n('#f-npart')} × ${brl(v('#f-vpart'))}`);
  if(plano) p.push(`${n('#f-nplano')} × ${brl(v('#f-vplano'))}`);
  if(proc)  p.push(`${n('#f-nproc')} × ${brl(v('#f-vproc'))}`);
  $('#amb-hint').textContent = p.length ? `${p.join('  +  ')}  =  ${brl(total)}` : 'Informe quantos pacientes você atendeu.';
}

function retencaoLocal(){
  const l = getLocal($('#f-local').value);
  return l ? (+l.retencao || 0) : 0;
}
function autoLiquido(){
  if(liqTouched) return;
  const v = parseFloat($('#f-valor').value) || 0;
  $('#f-liquido').value = v ? Math.round(v * (1 - retencaoLocal()/100) * 100) / 100 : '';
}

function autoValor(){
  if(valorTouched){ janela(); return; }
  const base = base12(), dur = duracaoAtual();
  if(base && dur) $('#f-valor').value = Math.round(base * dur / 12 * 100) / 100;
  autoLiquido(); janela();
}

function atualizarVenc(){
  const localId = $('#f-local').value;
  const l = getLocal(localId);
  if(!vencTouched){
    $('#f-venc').value = vencimento({ data: $('#f-date').value || iso(new Date()), localId });
  }
  const quando = PAGMES[l && typeof l.pagMes==='number' ? l.pagMes : 1];
  $('#venc-hint').textContent = !l
    ? 'Sem regra cadastrada — usando dia 10 do mês seguinte.'
    : l.pagIncerto
      ? `${l.nome} paga ${quando}, sem dia definido. A data abaixo é só a referência de fim de mês — confirme o recebimento quando o dinheiro entrar.`
      : `Regra de ${l.nome}: dia ${l.pagDia||10}, ${quando}. Altere só se este pagamento for exceção.`;
}

function contraHint(){
  const c = chipGet('#f-contra'), t = chipGet('#f-tipo'), h = $('#contra-hint');
  $('#f-quitado').classList.toggle('hidden', c !== 'devolver');
  if(c==='devolver') h.textContent = t==='passei'
    ? 'O colega fica devendo um plantão para você.'
    : 'Você fica devendo um plantão para o colega.';
  else if(c==='dinheiro') h.textContent = 'Acerto em dinheiro — fora do saldo de trocas.';
  else h.textContent = 'Sem contrapartida — fora do saldo de trocas.';
}

// janela real de cada compromisso, para cruzar horários
function janelaDe(s){
  const d = parseDate(s.data);
  const [hh,mm] = (s.hora||'07:00').split(':').map(Number);
  const ini = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh||0, mm||0);
  return { ini: ini.getTime(), fim: ini.getTime() + (Number(s.duracao)||0)*3600000 };
}
function conflito(novo, ignoraId){
  const a = janelaDe(novo);
  if(!(a.fim > a.ini)) return null;
  return S.shifts.find(s=>{
    if(s.id === ignoraId || (!naAgenda(s) && !ehBloq(s))) return false;
    const b = janelaDe(s);
    return a.ini < b.fim && b.ini < a.fim;
  }) || null;
}

// datas extras da repetição: semanal/quinzenal (dias marcados), mensal no
// "Nº dia da semana" (ex.: 2º sábado; 5º = último) ou mensal no mesmo dia.
// Vai até a data escolhida (padrão: 3 meses), no máximo 120 lançamentos.
const ORD = ['1º','2º','3º','4º','último'];
function repAte(inicio){
  let ate = $('#f-rep-ate').value ? parseDate($('#f-rep-ate').value) : null;
  if(!ate || ate < inicio){ ate = new Date(inicio); ate.setMonth(ate.getMonth()+3); }
  return ate;
}
function datasRepeticao(dataBase){
  const modo = $('#f-rep').value;
  if(!modo || modo === '0') return [];
  const inicio = parseDate(dataBase), ate = repAte(inicio), out = [], MAX = 120;
  if(modo === 'sem' || modo === 'quinz'){
    const passo = modo === 'quinz' ? 2 : 1;
    let wds = $$('#f-wd .chip.on').map(c=>+c.dataset.v);
    if(!wds.length) wds = [inicio.getDay()];
    const dom0 = domingoSemana(inicio).getTime();
    for(let d = new Date(inicio); d <= ate && out.length < MAX; d.setDate(d.getDate()+1)){
      const semana = Math.round((domingoSemana(d).getTime() - dom0) / (7*86400000));
      if(semana % passo) continue;
      if(wds.includes(d.getDay()) && iso(d) !== dataBase) out.push(iso(d));
    }
  } else if(modo === 'mesnth'){
    const w = inicio.getDay(), n = Math.ceil(inicio.getDate()/7);
    for(let i = 1; out.length < MAX; i++){
      const y = inicio.getFullYear(), m = inicio.getMonth() + i;
      let d;
      if(n >= 5){ d = new Date(y, m+1, 0); while(d.getDay() !== w) d.setDate(d.getDate()-1); }
      else { d = new Date(y, m, 1); while(d.getDay() !== w) d.setDate(d.getDate()+1); d.setDate(d.getDate() + 7*(n-1)); }
      if(d > ate) break;
      out.push(iso(d));
    }
  } else if(modo === 'mesdia'){
    const dia = inicio.getDate();
    for(let i = 1; out.length < MAX; i++){
      const y = inicio.getFullYear(), m = inicio.getMonth() + i;
      const d = new Date(y, m, Math.min(dia, new Date(y, m+1, 0).getDate()));
      if(d > ate) break;
      out.push(iso(d));
    }
  }
  return out;
}

async function saveShift(){
  let localId = $('#f-local').value;
  if(localId === '__new'){
    const nome = $('#f-newlocal').value.trim();
    if(!nome){ toast('Dê um nome ao local'); $('#f-newlocal').focus(); return; }
    const turno = chipGet('#f-turno'), v = parseFloat($('#f-valor').value)||0;
    const dur0 = duracaoAtual() || 12;
    const b = Math.round(v * 12 / dur0 * 100) / 100;   // converte para base de 12h
    const novo = { id:uid(), nome, cidade:'', endereco:'', cor:CORES[S.locais.length % CORES.length],
                   vDia: turno==='diurno'?b:0, vNoite: turno==='noturno'?b:0, residencia: chipGet('#f-cat') === 'residencia' };
    S.locais.push(novo); localId = novo.id;
  }
  const durSel = chipGet('#f-dur');
  const duracao = durSel==='custom' ? (parseInt($('#f-durc').value)||1) : parseInt(durSel);
  const tipo = chipGet('#f-tipo');

  const categoria = chipGet('#f-cat');
  const resid = categoria === 'residencia';
  const pago = !resid && $('#f-pago').classList.contains('on');
  const amb = categoria === 'ambulatorio';
  const base = {
    categoria,
    urgente: categoria !== 'residencia' && categoria !== 'bolsa' && $('#f-urgente').classList.contains('on'),
    blTipo:'', blFim:'', blDiaInt:true,
    nPart:  amb ? (parseInt($('#f-npart').value)||0)  : 0,
    nPlano: amb ? (parseInt($('#f-nplano').value)||0) : 0,
    nProc:  amb ? (parseInt($('#f-nproc').value)||0)  : 0,
    vPart:  amb ? (parseFloat($('#f-vpart').value)||0)  : 0,
    vPlano: amb ? (parseFloat($('#f-vplano').value)||0) : 0,
    vProc:  amb ? (parseFloat($('#f-vproc').value)||0)  : 0,
    liquido: resid ? 0 : (parseFloat($('#f-liquido').value) || parseFloat($('#f-valor').value) || 0),
    data: $('#f-date').value || iso(new Date()),
    localId, turno: chipGet('#f-turno'), duracao,
    hora: $('#f-hora').value,
    valor: resid ? 0 : (parseFloat($('#f-valor').value)||0),
    pago,
    pagoEm: pago ? ($('#f-pagoem').value || iso(new Date())) : '',
    venc: vencTouched ? $('#f-venc').value : '',
    tipo,
    colega: tipo==='meu' ? '' : $('#f-colega').value.trim(),
    contra: tipo==='meu' ? '' : chipGet('#f-contra'),
    quitado: tipo==='meu' ? false : $('#f-quitado').classList.contains('on'),
    obs: $('#f-obs').value.trim()
  };

  const wasEdit = !!editing;

  // conflito de horário — só avisa (e pede confirmação) em NOVOS lançamentos
  if(!wasEdit && !conflitoOk){
    const choque = conflito(base, null);
    // bloqueios (férias, viagem…) vivem em S.bloqueios e não eram checados
    const NB = {ferias:'férias',viagem:'viagem',sobreaviso:'sobreaviso',compromisso:'compromisso',outro:'bloqueio'};
    const bl = categoria !== 'bolsa' && S.bloqueios.find(b=> base.data >= b.ini && base.data <= (b.fim||b.ini));
    if(choque || bl){
      conflitoOk = true;
      haptic(25);
      if(choque){
        const d = parseDate(choque.data);
        toast(`Choca com ${localName(choque.localId)} em ${pad2(d.getDate())}/${pad2(d.getMonth()+1)} — salve de novo para confirmar`);
      } else {
        toast(`Dia marcado como ${NB[bl.motivo]||'bloqueio'} — salve de novo para confirmar`);
      }
      return;
    }
  }

  try {
    if(editing){ Object.assign(editing, base); }
    else{
      S.shifts.push({ id:uid(), ...base });
      const datas = datasRepeticao(base.data);
      datas.forEach(dt => S.shifts.push({ id:uid(), ...base, data: dt, pago:false, pagoEm:'', venc:'' }));
      if(datas.length) toast(`${datas.length+1} lançamentos criados`);
    }
    await store.save(S);
    haptic(wasEdit ? 8 : 12);
    closeSheets(); render();
    if(wasEdit) toast('Salvo ✓');
  } catch(err) {
    toast('Erro ao salvar: ' + (err && err.message ? err.message : String(err)));
  }
}

/* ================= sheet local ================= */
function paintCores(){
  $('#l-cores').innerHTML = CORES.map(c=>`<div class="sw-opt ${c===corSel?'on':''}" data-cor="${c}" style="background:${c}"></div>`).join('');
}
function openLocal(l){
  editingLocal = l || null;
  corSel = l ? (l.cor||CORES[0]) : CORES[S.locais.length % CORES.length];
  $('#l-title').textContent = l ? 'Editar local' : 'Novo local';
  $('#l-nome').value  = l ? l.nome : '';
  $('#l-sigla').value = l && l.sigla ? l.sigla : '';
  $('#l-sigla').placeholder = 'Automática' + (l ? ': ' + siglaLocal(l.id).replace(/^\?$/,'') : '');
  $('#l-cidade').value= l ? (l.cidade||'') : '';
  $('#l-end').value   = l ? (l.endereco||'') : '';
  $('#l-dia').value   = l ? (l.vDia||'') : '';
  $('#l-noite').value = l ? (l.vNoite||'') : '';
  $('#l-pagdia').value = l ? (l.pagDia||10) : 10;
  $('#l-reten').value = l ? (l.retencao||0) : 0;
  $('#l-vpart').value  = l ? (l.vPart||'')  : '';
  $('#l-vplano').value = l ? (l.vPlano||'') : '';
  $('#l-vproc').value  = l ? (l.vProc||'')  : '';
  chipSet('#l-pagmes', String(l && typeof l.pagMes === 'number' ? l.pagMes : 1));
  const inc = !!(l && l.pagIncerto);
  $('#l-pagincerto').classList.toggle('on', inc);
  $('#l-pagdia-wrap').classList.toggle('hidden', inc);
  $('#l-del').classList.toggle('hidden', !l);
  const resid = !!(l && l.residencia);
  $('#l-resid').classList.toggle('on', resid);
  $('#l-pag-wrap').classList.toggle('hidden', resid); $('#l-resid-hint').classList.toggle('hidden', !resid);
  paintCores();
  $('#sheet2').classList.add('open'); $('#scrim').classList.add('open');
  lockScroll();
}
async function saveLocal(){
  const nome = $('#l-nome').value.trim();
  if(!nome){ toast('Dê um nome ao local'); return; }
  const dados = {
    nome, cidade: $('#l-cidade').value.trim(), endereco: $('#l-end').value.trim(),
    cor: corSel, vDia: parseFloat($('#l-dia').value)||0, vNoite: parseFloat($('#l-noite').value)||0,
    pagIncerto: $('#l-pagincerto').classList.contains('on'),
    pagDia: Math.min(31, Math.max(1, parseInt($('#l-pagdia').value)||10)),
    pagMes: parseInt(chipGet('#l-pagmes')) || 0,
    retencao: Math.min(50, Math.max(0, parseFloat($('#l-reten').value)||0)),
    vPart: parseFloat($('#l-vpart').value)||0,
    vPlano: parseFloat($('#l-vplano').value)||0,
    vProc: parseFloat($('#l-vproc').value)||0,
    residencia: $('#l-resid').classList.contains('on'),
    sigla: $('#l-sigla').value.trim().toUpperCase().slice(0,4)
  };
  // virou local da residência: os lançamentos dele que estavam como plantão pago (e ainda não
  // recebidos) passam a ser plantões da residência — com Desfazer
  const alvo = editingLocal && dados.residencia
    ? S.shifts.filter(s => s.localId === editingLocal.id && (s.categoria||'remunerado') === 'remunerado' && !s.pago) : [];
  if(alvo.length){
    const local = editingLocal; closeSheets();
    comDesfazer(`Local salvo · ${alvo.length} lançamento${alvo.length>1?'s':''} passa${alvo.length>1?'ram':'ou'} para residência, sem remuneração`, ()=>{
      Object.assign(local, dados);
      alvo.forEach(s => { s.categoria = 'residencia'; s.valor = 0; s.liquido = 0; s.venc = ''; s.urgente = false; });
    });
    return;
  }
  if(editingLocal) Object.assign(editingLocal, dados);
  else S.locais.push({ id:uid(), ...dados });
  await store.save(S); closeSheets(); render(); toast('Local salvo');
}


/* ── Wrapped: Seu Ano em Números ── */
function openWrapped(){
  const sheet = document.getElementById('wrapped-sheet');
  const splash = document.getElementById('wrapped-splash');
  const btn = document.getElementById('wr-close');
  sheet.classList.add('open');
  if(btn) btn.classList.add('visible');
  lockScroll();
  if(splash){
    splash.style.display = 'flex';
    splash.classList.remove('out');
    setTimeout(()=>{ renderWrapped(); }, 100);
    setTimeout(()=>{
      splash.classList.add('out');
      setTimeout(()=>{ splash.style.display = 'none'; }, 420);
    }, 1000);
  } else {
    renderWrapped();
  }
}
function closeWrapped(){
  document.getElementById('wrapped-sheet').classList.remove('open');
  const btn = document.getElementById('wr-close');
  if(btn) btn.classList.remove('visible');
  unlockScroll();
}

/* helper: retângulo com cantos arredondados no canvas */
function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath();
}

/* ================= O ANO: dados para "Seu ano em números" e para a imagem ================= */
function maiorSequencia(y){
  const ps = plantoesPorHorario().filter(x => x.s.data.startsWith(String(y)));
  let melhor = { h: 0, ini: null, n: 0 }, ini = null, fim = null, n = 0;
  ps.forEach(x => {
    if(fim && x.ini - fim <= EMENDA_MS && x.ini >= fim - EMENDA_MS){ fim = new Date(Math.max(+fim, +x.f)); n++; }
    else { ini = x.ini; fim = x.f; n = 1; }
    const h = Math.round((fim - ini) / 3600000);
    if(h > melhor.h) melhor = { h, ini, n };
  });
  return melhor;
}
function dadosAno(y){
  const itens = S.shifts.filter(s => s.data.startsWith(String(y)));
  const A = agregar(itens);
  const meses = MES_CURTO.map((_, m) => { const a = agregar(doMes(y, m)); return { m, fat: a.fat, fatPl: a.fatPl, fatFx: a.fatFx, h: a.h }; });
  const porLoc = {};
  A.pl.forEach(s => { const x = porLoc[s.localId] = porLoc[s.localId] || { lid: s.localId, fat: 0, h: 0, n: 0 }; x.fat += liq(s); x.h += +s.duracao||0; x.n++; });
  const locais = Object.values(porLoc).sort((a,b) => b.fat - a.fat);
  const horasDia = {};
  itens.filter(s => naAgenda(s) && !ehBolsa(s) && !ehBloq(s)).forEach(s => { horasDia[s.data] = (horasDia[s.data]||0) + (+s.duracao||0); });
  const ant = agregar(S.shifts.filter(s => s.data.startsWith(String(y-1))));
  const melhorMes = meses.slice().sort((a,b) => b.fat - a.fat)[0];
  return { y, A, meses, locais, horasDia, seq: maiorSequencia(y), antes: ant.n || ant.fat ? ant : null, melhorMes };
}

function renderWrapped(){
  const y = new Date().getFullYear(), D = dadosAno(y), A = D.A;
  $('#wr-ano').textContent = y + ' em números';
  $('#wr-total').textContent = brl(A.fat);
  $('#wr-sub').textContent = A.n
    ? `${A.n} ${A.n===1?'plantão registrado':'plantões registrados'}` + (A.fatFx ? ` · ${brl(A.fatPl)} em plantões + ${brl(A.fatFx)} de entradas fixas` : '')
    : 'Nenhum plantão no ano';
  $('#wr-horas').textContent = A.h ? A.h + 'h' : '—';
  $('#wr-horas-sub').textContent = A.h ? `≈ ${Math.round(A.h/24)} dias inteiros` + (A.hRes ? ` · +${A.hRes}h de residência` : '') : '';
  const top = D.locais[0];
  $('#wr-top-local').textContent = top ? localName(top.lid) : '—';
  $('#wr-top-local-sub').textContent = top ? `${brl(top.fat)} · ${top.n} ${top.n===1?'plantão':'plantões'} · ${brl(top.h ? top.fat/top.h : 0)}/h` : '';
  const mm = D.melhorMes;
  $('#wr-mes-top').textContent = mm && mm.fat ? MES[mm.m].charAt(0).toUpperCase() + MES[mm.m].slice(1) : '—';
  $('#wr-mes-top-sub').textContent = mm && mm.fat ? `${brl(mm.fat)} · ${mm.h}h` : '';
  $('#wr-qtd').textContent = A.n || '—';
  $('#wr-qtd-sub').textContent = A.n ? `${Math.round(A.recPl / (A.fatPl||1) * 100)}% do valor já recebido` : '';
  $('#wr-ticket').textContent = A.media ? brl(A.media) : '—';
  $('#wr-ticket-sub').textContent = A.vph ? `${brl(A.vph)} por hora trabalhada` : '';
  $('#wr-seq').textContent = D.seq.h ? D.seq.h + 'h seguidas' : '—';
  $('#wr-seq-sub').textContent = D.seq.ini ? `${D.seq.n} ${D.seq.n===1?'plantão':'plantões emendados'} a partir de ${pad2(D.seq.ini.getDate())}/${pad2(D.seq.ini.getMonth()+1)}` : '';
  $('#wr-noites').textContent = A.noites || '—';
  $('#wr-noites-sub').textContent = A.noites ? `${Math.round(A.noites / (A.n||1) * 100)}% dos plantões foram noturnos` : '';
  atualizarPreviaAno();
}

/* ── imagem do ano: post (1080×1350) ou stories (1080×1920), com modo discreto (sem R$) ── */
const wrOpcoes = () => ({
  formato: document.querySelector('#wr-formato .on')?.dataset.fmt || 'post',
  discreto: !!document.querySelector('#wr-discreto.on'),
});
let _wrIcone = null;
function carregarIconeAno(){
  return new Promise(ok => {
    if(_wrIcone) return ok(_wrIcone);
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { _wrIcone = img; ok(img); }; img.onerror = () => ok(null);
    img.src = './icon-512.png';
  });
}
async function atualizarPreviaAno(){
  const el = $('#wr-previa'); if(!el) return;
  try{
    const D = dadosAno(new Date().getFullYear());
    el.src = gerarCanvasAno(D, { ...wrOpcoes(), icone: await carregarIconeAno() }).toDataURL('image/png');
    el.classList.toggle('stories', wrOpcoes().formato === 'stories');
  }catch(e){ registrarErro(e, 'ano:previa'); }
}

function gerarCanvasAno(D, { formato = 'post', discreto = false, icone = null } = {}){
  const W = 1080, H = formato === 'stories' ? 1920 : 1350, st = formato === 'stories';
  const cvs = document.createElement('canvas'); cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d'), A = D.A, P = 72, CW = W - 2*P;
  const C = { tx:'#F4F4F5', dim:'#A1A1AA', dim2:'#71717A', ac:'#8B93FF', ac2:'#5B5BD6', fx:'#F5B544', card:'rgba(255,255,255,.06)', linha:'rgba(255,255,255,.10)' };
  const F = (peso, px) => `${peso} ${px}px Inter, "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const texto = (t, x, y, f, cor, al = 'left') => { ctx.font = f; ctx.fillStyle = cor; ctx.textAlign = al; ctx.fillText(t, x, y); };
  const caber = (t, peso, px, max) => { ctx.font = F(peso, px); while(ctx.measureText(t).width > max && px > 20){ px -= 4; ctx.font = F(peso, px); } return px; };
  const grande = v => discreto ? '' : brl(v);

  // fundo
  const g = ctx.createLinearGradient(0, 0, W*0.3, H);
  g.addColorStop(0, '#0E0C22'); g.addColorStop(.5, '#17114A'); g.addColorStop(1, '#090814');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const brilho = ctx.createRadialGradient(W*0.85, H*0.08, 0, W*0.85, H*0.08, W*0.7);
  brilho.addColorStop(0, 'rgba(139,147,255,.28)'); brilho.addColorStop(1, 'rgba(139,147,255,0)');
  ctx.fillStyle = brilho; ctx.fillRect(0, 0, W, H);

  let y = st ? 150 : 76;
  const gap = st ? 44 : 26;
  // cabeçalho: ícone + nome + ano
  let xNome = P;
  if(icone){ ctx.save(); roundRect(ctx, P, y - 6, 64, 64, 16); ctx.clip(); ctx.drawImage(icone, P, y - 6, 64, 64); ctx.restore(); xNome = P + 82; }
  texto('Plantaê!', xNome, y + 42, F(800, 44), C.tx);
  ctx.font = F(700, 30); const anoTxt = String(D.y), anoW = ctx.measureText(anoTxt).width + 44;
  roundRect(ctx, W - P - anoW, y, anoW, 52, 26); ctx.fillStyle = 'rgba(139,147,255,.18)'; ctx.fill();
  texto(anoTxt, W - P - anoW/2, y + 37, F(700, 30), C.ac, 'center');
  y += 64 + gap + 18;

  // número principal
  texto(discreto ? 'MEU ANO EM PLANTÕES' : 'MEU ANO EM PLANTÕES · FATURADO', P, y, F(700, 24), C.dim);
  y += st ? 150 : 120;
  const principal = discreto ? `${A.h}h` : brl(A.fat);
  const px = caber(principal, 800, st ? 150 : 132, CW);
  const gt = ctx.createLinearGradient(P, 0, P + CW*0.8, 0); gt.addColorStop(0, '#FFFFFF'); gt.addColorStop(1, '#B7BCFF');
  texto(principal, P, y, F(800, px), gt);
  y += st ? 70 : 52;
  const sub = discreto
    ? `${A.n} plantões · ≈ ${Math.round(A.h/24)} dias inteiros de trabalho`
    : A.fatFx ? `Plantões ${brl(A.fatPl)}  +  entradas fixas ${brl(A.fatFx)}` : `${A.n} plantões · ${A.h} horas`;
  texto(sub, P, y, F(500, caber(sub, 500, 32, CW)), C.dim);
  if(D.antes){
    const base = discreto ? D.antes.h : D.antes.fat, atual = discreto ? A.h : A.fat;
    if(base > 0){
      const pct = Math.round((atual/base - 1) * 100), t = `${pct >= 0 ? '▲ +' : '▼ '}${pct}% vs ${D.y - 1}`;
      y += st ? 64 : 48; ctx.font = F(700, 26); const tw = ctx.measureText(t).width + 36;
      roundRect(ctx, P, y - 34, tw, 48, 24); ctx.fillStyle = pct >= 0 ? 'rgba(86,180,233,.18)' : 'rgba(240,163,94,.18)'; ctx.fill();
      texto(t, P + 18, y - 1, F(700, 26), pct >= 0 ? '#7CC8F2' : '#F0A35E');
    }
  }
  y += gap + 8;

  // barras dos 12 meses
  const chH = st ? 330 : 212;
  roundRect(ctx, P, y, CW, chH, 28); ctx.fillStyle = C.card; ctx.fill();
  texto(discreto ? 'Horas por mês' : 'Faturado por mês', P + 32, y + 50, F(700, 26), C.tx);
  const vals = D.meses.map(m => discreto ? m.h : m.fat), max = Math.max(...vals, 1), mi = vals.indexOf(Math.max(...vals));
  const bx = P + 32, bW = CW - 64, by = y + 80, bH = chH - 80 - 56, col = bW / 12, bw = col * 0.62;
  D.meses.forEach((m, i) => {
    const v = vals[i], h = Math.max(v ? 6 : 0, bH * v / max), x = bx + col*i + (col - bw)/2, topo = by + bH - h;
    if(!discreto && m.fatFx && m.fat){
      const hFx = bH * m.fatFx / max;
      roundRect(ctx, x, topo, bw, h, 8); ctx.fillStyle = i === mi ? C.ac : 'rgba(139,147,255,.55)'; ctx.fill();
      ctx.fillStyle = 'rgba(245,181,68,.85)'; ctx.fillRect(x, by + bH - hFx, bw, Math.min(hFx, h));
    } else if(h){ roundRect(ctx, x, topo, bw, h, 8); ctx.fillStyle = i === mi ? C.ac : 'rgba(139,147,255,.55)'; ctx.fill(); }
    if(i === mi && v) texto(discreto ? `${v}h` : kBRL(v), x + bw/2, topo - 12, F(700, 22), C.tx, 'center');
    texto(MES_CURTO[m.m][0].toUpperCase(), x + bw/2, by + bH + 38, F(600, 22), i === mi ? C.tx : C.dim2, 'center');
  });
  if(!discreto && D.meses.some(m => m.fatFx)){
    ctx.fillStyle = 'rgba(245,181,68,.85)'; ctx.fillRect(P + CW - 230, y + 32, 18, 18);
    texto('entradas fixas', P + CW - 204, y + 49, F(500, 20), C.dim);
  }
  y += chH + gap;

  // mapa de calor do ano
  const ini = new Date(D.y, 0, 1), desloc = ini.getDay(), dias = (new Date(D.y + 1, 0, 1) - ini) / 86400000;
  const nSem = Math.ceil((desloc + dias) / 7), passo = CW / nSem, cel = passo * 0.8;
  texto('Dias de plantão', P, y + 4, F(700, 24), C.tx);
  const nDias = Object.keys(D.horasDia).length;
  texto(`${nDias} dias`, P + CW, y + 4, F(600, 22), C.dim, 'right');
  y += 24;
  for(let i = 0; i < dias; i++){
    const d = new Date(D.y, 0, 1 + i), k = iso(d), h = D.horasDia[k] || 0, pos = i + desloc;
    const nv = !h ? 0 : h <= 6 ? .3 : h <= 12 ? .55 : h <= 24 ? .8 : 1;
    roundRect(ctx, P + Math.floor(pos/7) * passo, y + (pos % 7) * passo, cel, cel, 3);
    ctx.fillStyle = h ? `rgba(139,147,255,${nv})` : 'rgba(255,255,255,.06)'; ctx.fill();
  }
  y += 7 * passo + gap + 6;

  // quatro números
  const st4 = discreto
    ? [['Horas', `${A.h}h`, `≈ ${Math.round(A.h/24)} dias`], ['Plantões', String(A.n), `${A.noites} noturnos`],
       ['Maior sequência', D.seq.h ? `${D.seq.h}h` : '—', D.seq.h ? `${D.seq.n} emendados` : ''], ['Noites viradas', String(A.noites), `${Math.round(A.noites/(A.n||1)*100)}% dos plantões`]]
    : [['Horas', `${A.h}h`, `≈ ${Math.round(A.h/24)} dias`], ['Plantões', String(A.n), `${A.noites} noturnos`],
       ['Por hora', A.vph ? brl(A.vph) : '—', 'média dos plantões'], ['Maior sequência', D.seq.h ? `${D.seq.h}h` : '—', D.seq.h ? `${D.seq.n} emendados` : '']];
  const cw = (CW - 24) / 2, chh = st ? 150 : 116;
  st4.forEach(([r, v, s], i) => {
    const x = P + (i % 2) * (cw + 24), yy = y + Math.floor(i/2) * (chh + 18);
    roundRect(ctx, x, yy, cw, chh, 24); ctx.fillStyle = C.card; ctx.fill();
    texto(r.toUpperCase(), x + 28, yy + 42, F(700, 19), C.dim);
    texto(v, x + 28, yy + (st ? 98 : 82), F(800, caber(v, 800, st ? 50 : 40, cw - 56)), C.tx);
    if(s) texto(s, x + 28, yy + (st ? 130 : 104), F(500, 20), C.dim2);
  });
  y += 2 * chh + 18 + gap;

  // onde trabalhou: 3 locais principais (só percentual — sem expor valores)
  const top = (discreto ? D.locais.slice().sort((a,b) => b.h - a.h) : D.locais).slice(0, 3), totPl = A.fatPl || 1, totH = A.h || 1;
  if(top.length){
    texto('Onde mais trabalhei', P, y + 4, F(700, 24), C.tx);
    y += st ? 34 : 24;
    const rowH = st ? 62 : 42;
    top.forEach((l, i) => {
      const yy = y + i * rowH, pct = discreto ? l.h / totH : l.fat / totPl;
      roundRect(ctx, P, yy, 70, 38, 10); ctx.fillStyle = localCor(l.lid); ctx.globalAlpha = .9; ctx.fill(); ctx.globalAlpha = 1;
      texto(siglaLocal(l.lid), P + 35, yy + 27, F(800, 20), '#0B0B12', 'center');
      ctx.font = F(600, 24); let nome = nomeCurto(l.lid); while(ctx.measureText(nome).width > CW - 300 && nome.length > 4) nome = nome.slice(0, -2);
      if(nome !== nomeCurto(l.lid)) nome += '…';
      texto(nome, P + 88, yy + 27, F(600, 24), C.tx);
      const bxx = P + CW - 190, bww = 120;
      roundRect(ctx, bxx, yy + 13, bww, 12, 6); ctx.fillStyle = C.linha; ctx.fill();
      roundRect(ctx, bxx, yy + 13, Math.max(8, bww * pct), 12, 6); ctx.fillStyle = C.ac; ctx.fill();
      texto(`${Math.round(pct*100)}%`, P + CW, yy + 27, F(700, 22), C.tx, 'right');
    });
    y += (top.length - 1) * rowH + 38;
  }

  // rodapé
  const yRod = H - (st ? 120 : 34);
  texto(`plantaê · ${location.host || 'plantoes'}`, W/2, yRod, F(500, 20), 'rgba(255,255,255,.38)', 'center');
  cvs.dataset.fim = Math.round(y); cvs.dataset.rodape = yRod - 20;   // conferido nos testes: nada encosta no rodapé
  return cvs;
}

function mostrarImagemOverlay(dataUrl, ano){
  // Remove overlay anterior se existir
  const prev = document.getElementById('img-overlay');
  if(prev) prev.remove();

  const ov = document.createElement('div');
  ov.id = 'img-overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;box-sizing:border-box';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'max-width:100%;max-height:72vh;border-radius:12px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.6)';

  const hint = document.createElement('p');
  hint.textContent = 'Segure a imagem para salvar ou compartilhar';
  hint.style.cssText = 'color:rgba(255,255,255,0.7);font-size:14px;text-align:center;margin:0;font-family:system-ui,sans-serif';

  const btn = document.createElement('button');
  btn.textContent = 'Fechar';
  btn.style.cssText = 'background:rgba(255,255,255,0.12);color:#fff;border:none;border-radius:24px;padding:10px 32px;font-size:15px;cursor:pointer;font-family:system-ui,sans-serif';
  btn.onclick = ()=>{ ov.remove(); if(!_locked) fecharCamadaHist(); };

  ov.appendChild(img);
  ov.appendChild(hint);
  ov.appendChild(btn);
  ov.addEventListener('click', e=>{ if(e.target===ov){ ov.remove(); fecharCamadaHist(); } });
  document.body.appendChild(ov);
  if(!_locked) abrirCamadaHist();
}

async function compartilharAno(){
  const D = dadosAno(new Date().getFullYear()), op = wrOpcoes();
  let dataUrl;
  try{ dataUrl = gerarCanvasAno(D, { ...op, icone: await carregarIconeAno() }).toDataURL('image/png'); }
  catch(e){ toast('Erro ao gerar imagem: ' + e.message); return; }
  const nome = `plantae-${D.y}${op.formato === 'stories' ? '-stories' : ''}${op.discreto ? '-discreto' : ''}.png`;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if(isIOS){ mostrarImagemOverlay(dataUrl, D.y); return; }
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], nome, { type: 'image/png' });
  if(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })){
    try{ await navigator.share({ files: [file], title: 'Plantaê! ' + D.y }); return; }catch(err){ if(err && err.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = dataUrl; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  toast('Imagem salva ✓');
}
document.addEventListener('click', e => {
  const f = e.target.closest('#wr-formato button');
  if(f){ document.querySelectorAll('#wr-formato button').forEach(b => b.classList.toggle('on', b === f)); atualizarPreviaAno(); return; }
  if(e.target.closest('#wr-discreto')) setTimeout(atualizarPreviaAno, 0);   // o manipulador geral já trocou o "on"
});

/* ================= eventos ================= */
// ── Wrapped handlers (delegation). Os botões também tinham onclick inline — cada toque
//    disparava duas vezes (duas imagens geradas, compartilhamento aberto duas vezes). ──
document.addEventListener('click', function(e){
  if(e.target.closest('#wr-close'))    closeWrapped();
  if(e.target.closest('#wr-share'))    compartilharAno();
  if(e.target.closest('#wrapped-btn')) openWrapped();
});
// ── pull-to-refresh ──
(function(){
  const IND   = document.getElementById('ptr-indicator');
  const SPIN  = document.getElementById('ptr-spinner');
  const THRESHOLD = 72;   // px para disparar
  const MAX_PULL  = 90;
  let startY = 0, pulling = false, released = false;
  let rafId  = null;
  let spinning = false;

  function setHeight(h){
    IND.style.height = h + 'px';
    SPIN.style.opacity = Math.min(1, h / THRESHOLD);
    const rot = (h / THRESHOLD) * 180;
    SPIN.style.transform = `rotate(${rot}deg)`;
  }

  function startSpin(){
    spinning = true;
    SPIN.style.transition = 'opacity .2s';
    SPIN.style.transform  = '';
    SPIN.style.animation  = 'ptr-spin .7s linear infinite';
  }

  function reset(){
    IND.style.transition   = 'height .3s ease';
    SPIN.style.transition  = 'opacity .3s';
    setHeight(0);
    setTimeout(()=>{
      IND.style.transition  = '';
      SPIN.style.animation  = '';
      SPIN.style.transform  = '';
      spinning = false; pulling = false; released = false;
    }, 320);
  }

  let ptrStartX = 0;
  let ptrDecided = false; // true quando decidimos se é vertical ou horizontal

  document.addEventListener('touchstart', e=>{
    // com sheet aberto o body fica fixo (scrollY=0) — sem este guard,
    // arrastar o sheet para baixo acionava o refresh por trás
    if(_locked || window.scrollY > 4) return;
    if(e.target.closest('.sheet, #wrapped-sheet, #img-overlay')) return;
    startY    = e.touches[0].clientY;
    ptrStartX = e.touches[0].clientX;
    pulling   = true;
    released  = false;
    ptrDecided = false;
    IND.style.transition = '';
  }, {passive:true});

  document.addEventListener('touchmove', e=>{
    if(!pulling || released) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - ptrStartX;
    // decidir direção na primeira movimentação
    if(!ptrDecided){
      if(Math.abs(dy) < 4 && Math.abs(dx) < 4) return;
      ptrDecided = true;
      // se for swipe horizontal, desativa pull-to-refresh
      if(Math.abs(dx) > Math.abs(dy)){ pulling = false; return; }
    }
    if(!pulling) return;
    if(dy <= 0) return;
    const pull = Math.min(dy * .45, MAX_PULL);
    setHeight(pull);
  }, {passive:true});

  document.addEventListener('touchend', async ()=>{
    if(!pulling || released) return;
    released = true;
    const h = parseFloat(IND.style.height)||0;
    if(h >= THRESHOLD){
      IND.style.transition = 'height .2s ease';
      IND.style.height     = THRESHOLD + 'px';
      startSpin();
      await new Promise(r=>setTimeout(r, 700));
      render();
      toast('Atualizado ✓');
      await new Promise(r=>setTimeout(r, 300));
    }
    reset();
  });
})();

// ocultar saldo
let saldoOculto = false;
const MASK = 'R$ •••••';

function aplicarOcultar(){
  document.body.classList.toggle('saldo-oculto', saldoOculto);
  $('#ico-olho').style.display     = saldoOculto ? 'none' : '';
  $('#ico-olho-off').style.display = saldoOculto ? '' : 'none';
  // hero principal
  const el = $('#h-total');
  if(saldoOculto){
    if(!el.dataset.real) el.dataset.real = el.textContent;
    el.textContent = MASK;
    el.style.fontSize = 'clamp(36px,9vw,48px)';
    el.style.letterSpacing = '.05em';
  } else {
    if(el.dataset.real){ heroSet(el, el.dataset.real); el.removeAttribute('data-real'); }
    el.style.fontSize = '';
    el.style.letterSpacing = '';
  }
}

$('#btn-ocultar').onclick = ()=>{
  saldoOculto = !saldoOculto;
  haptic(6);
  try{ localStorage.setItem('plantoes:oculto', saldoOculto ? '1' : ''); }catch(e){}
  aplicarOcultar();
};

$('#prev').onclick  = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1); render(); };
$('#next').onclick  = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1); render(); };
$('#today').onclick = ()=>{ cursor = new Date(); render(); };
$('#prev-il').onclick   = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1); render(); };
$('#next-il').onclick   = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1); render(); };
$('#today-il').onclick  = ()=>{ cursor = new Date(); render(); };
$('#cx-prev-il').onclick  = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1); render(); };
$('#cx-next-il').onclick  = ()=>{ cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1); render(); };
$('#cx-today-il').onclick = ()=>{ cursor = new Date(); render(); };

$$('nav button').forEach(b=>{
  b.onclick = ()=>{
    if(view === 'mes' && b.dataset.v !== 'mes' && !_histAba){ _histAba = true; history.pushState({ plantoes:'aba' }, ''); }
    else if(b.dataset.v === 'mes' && _histAba){ _histAba = false; voltarConsumir(); }
    view = b.dataset.v;
    $$('nav button').forEach(x=>x.classList.toggle('on', x===b));
    ['mes','caixa','resumo','locais','ajustes'].forEach(v=>$('#v-'+v).classList.toggle('hidden', v!==view));
    $('#fab').classList.toggle('hidden', view!=='mes' && view!=='locais');
    const at = $('#add-top');
    at.textContent = view==='locais' ? 'Novo local' : 'Novo plantão';
    at.style.visibility = (view==='mes' || view==='locais') ? 'visible' : 'hidden';
    window.scrollTo({top:0});
    render();
  };
});

/* ===== BLOQUEIOS ===== */
let editingBloq = null;

function openBloqueio(b){
  editingBloq = b || null;
  chipSet('#sbl-motivo', b?.motivo || 'ferias');
  const hoje2 = iso(new Date());
  $('#sbl-ini').value = b?.ini || hoje2;
  $('#sbl-fim').value = b?.fim || b?.ini || hoje2;
  $('#sbl-obs').value = b?.obs || '';
  $('#sbl-del').classList.toggle('hidden', !b);
  $('#scrim').classList.add('open');
  $('#sheet-bl').classList.add('open');
  lockScroll();
}

function closeBloqueio(){
  $('#sheet-bl').classList.remove('open');
  $('#scrim').classList.remove('open');
  editingBloq = null;
  unlockScroll();
}

$('#sbl-close').onclick = closeBloqueio;
$('#sbl-del').onclick = async ()=>{
  if(!editingBloq) return;
  const id = editingBloq.id;   // confirm() nativo era ignorado em alguns contextos do iPhone
  closeBloqueio();
  comDesfazer('Bloqueio removido', ()=>{ S.bloqueios = S.bloqueios.filter(b=>b.id!==id); });
};

$('#sbl-save').onclick = async ()=>{
  const ini = $('#sbl-ini').value;
  const fim = $('#sbl-fim').value || ini;
  if(!ini){ toast('Informe a data de início'); return; }
  if(fim < ini){ toast('Data fim deve ser ≥ início'); return; }
  const bl = {
    id: editingBloq?.id || uid(),
    motivo: chipGet('#sbl-motivo') || 'ferias',
    ini, fim, obs: $('#sbl-obs').value.trim()
  };
  if(editingBloq){
    const idx = S.bloqueios.findIndex(b=>b.id===bl.id);
    if(idx>=0) S.bloqueios[idx]=bl; else S.bloqueios.push(bl);
  } else {
    S.bloqueios.push(bl);
  }
  await store.save(S); closeBloqueio(); render();
  toast(editingBloq ? 'Bloqueio atualizado' : 'Bloqueio adicionado');
};

function novoItem(){
  if(view==='locais') return openLocal(null);
  let menu = $('#fab-menu');
  if(menu){ menu.remove(); return; }
  menu = document.createElement('div');
  menu.id = 'fab-menu';
  menu.style.cssText = `position:fixed;right:20px;bottom:calc(150px + env(safe-area-inset-bottom));
    background:var(--surface);border:1px solid var(--line);border-radius:14px;
    box-shadow:var(--sh-md);z-index:31;overflow:hidden;min-width:210px;`;
  const itemStyle = `display:flex;align-items:center;gap:12px;width:100%;border:0;background:none;
    padding:14px 16px;font-family:inherit;font-size:14px;font-weight:600;color:var(--ink);cursor:pointer;text-align:left;`;
  const sep = `border-bottom:1px solid var(--line);`;
  const freq = modelosFrequentes(3);
  menu.innerHTML = (freq.length ? `<div style="padding:10px 16px 4px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)">Lançar hoje</div>`
      + freq.map((m,i)=>`<button data-fab-mod="${i}" style="${itemStyle}padding-top:10px;padding-bottom:10px;${i===freq.length-1?sep:''}">
          <i style="width:9px;height:9px;border-radius:3px;background:${localCor(m.localId)};flex:none"></i>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nomeCurto(m.localId))}<small style="display:block;font-weight:500;color:var(--dim);font-size:12px">${rotuloModelo(m)}</small></span></button>`).join('') : '') + `
    <button id="fab-p"  style="${itemStyle}${sep}">🏥 <span>Novo plantão</span></button>
    <button id="fab-am" style="${itemStyle}${sep}">🩺 <span>Dia de consultório</span></button>
    <button id="fab-r"  style="${itemStyle}${sep}">🌙 <span>Plantão da residência<small style="display:block;font-weight:500;color:var(--dim);font-size:12px">obrigatório · sem remuneração</small></span></button>
    <button id="fab-b"  style="${itemStyle}">🔒 <span>Bloqueio de agenda</span></button>`;
  menu.style.animation = 'fabIn .18s cubic-bezier(.32,.72,0,1)';
  document.body.appendChild(menu);
  haptic(6);
  // um único listener, sempre removido — antes ficava pendurado quando se escolhia um item
  // escolher um item passa a "camada" do histórico para a tela que abre (o Voltar fecha essa tela);
  // antes o menu desfazia a entrada enquanto a tela criava outra, e fechar a tela voltava uma
  // página a mais — no app instalado, saía do app
  function fechar(passarCamada){ menu.remove(); document.removeEventListener('click', fora, true); if(!passarCamada && !_locked) fecharCamadaHist(); }
  abrirCamadaHist();
  function fora(e){ if(!menu.contains(e.target) && !e.target.closest('#fab, #add-top')) fechar(); }
  setTimeout(()=>document.addEventListener('click', fora, true), 0);
  menu.querySelector('#fab-p') .onclick = ()=>{ fechar(true); openSheet(null, null, 'remunerado'); };
  menu.querySelector('#fab-am').onclick = ()=>{ fechar(true); openSheet(null, null, 'ambulatorio'); };
  menu.querySelector('#fab-r') .onclick = ()=>{ fechar(true); novoPlantaoResidencia(); };
  menu.querySelector('#fab-b') .onclick = ()=>{ fechar(true); openBloqueio(null); };
  menu.querySelectorAll('[data-fab-mod]').forEach(b=> b.onclick = ()=>{
    fechar(true); openSheet(null, iso(new Date()), freq[+b.dataset.fabMod].categoria); aplicarModelo(freq[+b.dataset.fabMod]);
  });
}
$('#fab').onclick = novoItem;

// período do resumo
document.querySelectorAll('#res-periodo button').forEach(b=>{
  b.onclick = ()=>{
    document.querySelectorAll('#res-periodo button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); renderResumo();
  };
});

// quick-banner: registrar com um toque.
// Era uma IIFE que rodava antes do load (S vazio) — o banner aparecia sempre.
// Agora é recalculado a cada render().
function atualizaQuickBanner(){
  const hj = hoje();
  const temHoje = S.shifts.some(s=>s.data===iso(hj) && naAgenda(s)) || !!plantaoAtual().ativo;
  const banner = $('#quick-banner');
  if(!banner) return;
  const vendoHoje = sameMonth(iso(hj), cursor);
  if(!temHoje && viewTipo==='lista' && vendoHoje){
    banner.classList.remove('hidden');
    const d=hj; const WD_S=['dom','seg','ter','qua','qui','sex','sáb'];
    $('#qb-data').textContent = `Hoje · ${WD_S[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth()+1)}`;
  } else { banner.classList.add('hidden'); }
}
$('#quick-banner').onclick = ()=> openSheet(null, iso(hoje()));

$$('#view-toggle button').forEach(b=>{
  b.onclick = ()=>{
    viewTipo = b.dataset.vt;
    $$('#view-toggle button').forEach(x=>x.classList.toggle('on', x===b));
    if(viewTipo==='dia'){
      diaAtual=new Date();
      $('#shift-list').classList.add('hidden');
      $('#week-view').classList.add('hidden');
      $$('#filter button').forEach(x=>x.closest('.segs').classList.add('hidden'));
      renderDia();
    } else if(viewTipo==='semana'){
      semanaAtual=new Date();
      $('#shift-list').classList.add('hidden');
      $('#day-view').classList.add('hidden');
      $$('#filter button').forEach(x=>x.closest('.segs').classList.add('hidden'));
      renderSemana();
    } else {
      $('#shift-list').classList.remove('hidden');
      $('#day-view').classList.add('hidden');
      $('#week-view').classList.add('hidden');
      $$('#filter button').forEach(x=>x.closest('.segs').classList.remove('hidden'));
      renderMes();
    }
    atualizaQuickBanner();
  };
});
$('#add-top').onclick = novoItem;
$('#scrim').onclick = closeSheets;
$('#sd-close').onclick = closeSheets;
$('#sh-close').onclick = closeSheets;
$('#l-close').onclick = closeSheets;
$('#sh-save').onclick = saveShift;
$('#l-save').onclick = saveLocal;

$$('#filter button').forEach(b=>{
  b.onclick = ()=>{ filter = b.dataset.f; $$('#filter button').forEach(x=>x.classList.toggle('on',x===b)); renderMes(); };
});

// confirmação em dois toques (diálogos nativos podem ser bloqueados)
const pending = new Map();
function twoStep(btn, action){
  const k = btn.id;
  if(pending.has(k)){ const p = pending.get(k); clearTimeout(p.t); btn.textContent = p.label; pending.delete(k); action(); return; }
  const label = btn.textContent;
  btn.textContent = 'Toque de novo';
  pending.set(k, { label, t: setTimeout(()=>{ btn.textContent = label; pending.delete(k); }, 4000) });
}
$('#sh-del').onclick = ()=>{
  if(!editing) return;
  const id = editing.id, nome = localName(editing.localId);
  closeSheets();
  comDesfazer(`Plantão excluído · ${nome}`, ()=>{ S.shifts = S.shifts.filter(s=>s.id!==id); });
};
$('#l-del').onclick = ()=>{
  if(!editingLocal) return;
  const id = editingLocal.id, nome = editingLocal.nome;
  const n = S.shifts.filter(s=>s.localId===id).length;
  closeSheets();
  comDesfazer(n ? `${nome} excluído · ${n} lançamento${n>1?'s':''} sem local` : `${nome} excluído`,
    ()=>{ S.locais = S.locais.filter(l=>l.id!==id); });
};

// chips, toggles, swatches
document.addEventListener('click', e=>{
  const sw = e.target.closest('.sw-opt');
  if(sw){ corSel = sw.dataset.cor; paintCores(); return; }
  const chip = e.target.closest('.chip');
  if(chip){
    const box = chip.parentElement;
    if(box.id === 'f-wd'){          // dias da semana aceitam vários
      chip.classList.toggle('on');
      atualizarRepHint();
      return;
    }
    Array.from(box.children).forEach(c=>c.classList.remove('on'));
    chip.classList.add('on');
    if(box.id === 'f-cat'){ aplicarCategoria(); autoValor(); }
    if(box.id==='f-turno'){
      // horário padrão acompanha o turno (só troca se ainda estava no padrão do outro turno)
      const h = $('#f-hora');
      if(chip.dataset.v === 'noturno' && h.value === '07:00') h.value = '19:00';
      if(chip.dataset.v === 'diurno' && h.value === '19:00') h.value = '07:00';
      autoValor(); janela();
    }
    if(box.id==='l-pagmes') return;
    if(box.id==='f-dur'){ $('#f-durc-wrap').classList.toggle('hidden', chip.dataset.v!=='custom'); autoValor(); }
    if(box.id==='f-tipo'){ $('#troca-wrap').classList.toggle('hidden', chip.dataset.v==='meu'); contraHint(); }
    if(box.id==='f-contra') contraHint();
    return;
  }
  const tog = e.target.closest('.toggle');
  if(tog){
    tog.classList.toggle('on');
    if(tog.id === 'pref-vibrar'){
      const on = tog.classList.contains('on');
      lsSet('plantoes:vibrar', on ? '' : '0');
      if(on) haptic(20);
      return;
    }
    if(tog.id.startsWith('av-')){
      const p = avisoPrefs(); p[tog.id.slice(3)] = tog.classList.contains('on');
      lsSet('plantoes:avisos', JSON.stringify(p));
      if(p[tog.id.slice(3)] && !notifAtiva()) pedirPermissaoNotif();
      agendarNotificacoes(); renderAvisosUI();
      return;
    }
    if(tog.id === 'l-resid'){
      const on = tog.classList.contains('on');
      $('#l-pag-wrap').classList.toggle('hidden', on); $('#l-resid-hint').classList.toggle('hidden', !on);
      return;
    }
    if(tog.id === 'l-pagincerto'){
      $('#l-pagdia-wrap').classList.toggle('hidden', tog.classList.contains('on'));
    }
    if(tog.id === 'f-pago'){
      const on = tog.classList.contains('on');
      haptic(on ? 10 : 6);
      $('#f-pagoem-wrap').classList.toggle('hidden', !on);
      if(on && !$('#f-pagoem').value) $('#f-pagoem').value = iso(new Date());
    }
    return;
  }
  const map = e.target.closest('[data-map]');
  if(map){ e.stopPropagation(); window.open(decodeURIComponent(map.dataset.map),'_blank','noopener'); return; }
});

$('#cal-open').onclick = ()=>{ const s = editing; closeSheets(); openCal(s); };
$('#c-close').onclick = closeSheets;
$('#c-google').onclick = ()=>{
  if(!calAlvo) return;
  window.open(urlGoogle(calAlvo), '_blank', 'noopener');
  closeSheets();
};
$('#c-apple').onclick = ()=>{
  if(!calAlvo) return;
  const s = calAlvo;
  baixarIcs([s], `plantao-${s.data}.ics`);
  closeSheets();
};
$('#ics-mes').onclick = ()=> baixarIcs(
  mesData().filter(naAgenda),
  `plantoes-${cursor.getFullYear()}-${pad2(cursor.getMonth()+1)}.ics`
);
$('#ics-all').onclick = ()=> baixarIcs(
  S.shifts.filter(naAgenda).sort((a,b)=>a.data.localeCompare(b.data)),
  `plantoes-todos.ics`
);

$('#f-local').onchange = ()=>{ $('#f-newlocal-wrap').classList.toggle('hidden', $('#f-local').value!=='__new'); categoriaPeloLocal(); autoValor(); atualizarVenc(); };
$('#f-date').onchange = ()=>{ atualizarVenc(); atualizarRepHint(); conflitoOk = false; };
$('#f-venc').oninput = ()=>{ vencTouched = true; $('#venc-hint').textContent = 'Data definida manualmente para este plantão.'; };
$('#f-valor').oninput = ()=>{ valorTouched = true; autoLiquido(); };
$('#f-liquido').oninput = ()=> liqTouched = true;
['#f-npart','#f-nplano','#f-nproc','#f-vpart','#f-vplano','#f-vproc'].forEach(sel=>{
  $(sel).oninput = ()=>{ if(chipGet('#f-cat')==='ambulatorio') calcAmb(); };
});

// bolsa da residência: duas parcelas por mês, com datas de início separadas
$('#b-gerar').onclick = async ()=>{
  const v1 = parseFloat($('#b-v1').value)||0, v2 = parseFloat($('#b-v2').value)||0;
  if(!v1 && !v2){ toast('Informe ao menos uma parcela'); return; }

  // Helper: resolve intervalo de uma parcela
  function resolveIntervalo(iniId, fimId, fallbackIni){
    const iniVal = $(iniId).value || fallbackIni;
    const [iy, im] = iniVal.split('-').map(Number);
    const fimVal = $(fimId).value;
    let fy, fm;
    if(fimVal){
      [fy, fm] = fimVal.split('-').map(Number);
    } else {
      const hoje = new Date();
      fy = hoje.getFullYear(); fm = hoje.getMonth() + 1 + 12;
      if(fm > 12){ fy += Math.floor((fm-1)/12); fm = ((fm-1)%12)+1; }
    }
    return { iy, im, fy, fm };
  }

  const bolsa  = v2 ? resolveIntervalo('#b-ini2','#b-fim2','2025-04') : null;
  const auxilio = v1 ? resolveIntervalo('#b-ini1','#b-fim1','2025-12') : null;

  // Intervalo global para iterar (mínimo de inícios, máximo de fins)
  let globalIy = 9999, globalIm = 12, globalFy = 0, globalFm = 0;
  [bolsa, auxilio].filter(Boolean).forEach(i => {
    if(i.iy < globalIy || (i.iy === globalIy && i.im < globalIm)){ globalIy = i.iy; globalIm = i.im; }
    if(i.fy > globalFy || (i.fy === globalFy && i.fm > globalFm)){ globalFy = i.fy; globalFm = i.fm; }
  });

  let l = S.locais.find(x=>x.nome === 'Renda Fixa da Residência' || x.nome === 'Bolsa da residência');
  if(!l){
    l = { id:uid(), nome:'Renda Fixa da Residência', cidade:'', endereco:'',
          cor:CORES[S.locais.length % CORES.length], vDia:0, vNoite:0,
          pagDia:2, pagMes:0, retencao:0, vPart:0, vPlano:0, vProc:0 };
    S.locais.push(l);
  }

  let y = globalIy, m = globalIm - 1, criados = 0;
  while(y < globalFy || (y === globalFy && m <= globalFm - 1)){
    const d = iso(nEsimoUtil(y, m, 2));
    const mesNum = y * 12 + m; // número absoluto de mês para comparar intervalos

    const parcelas = [
      bolsa  && mesNum >= bolsa.iy  * 12 + bolsa.im  - 1 && mesNum <= bolsa.fy  * 12 + bolsa.fm  - 1 ? [v2,'Bolsa-Residência']  : null,
      auxilio && mesNum >= auxilio.iy * 12 + auxilio.im - 1 && mesNum <= auxilio.fy * 12 + auxilio.fm - 1 ? [v1,'Auxílio-Moradia'] : null,
    ].filter(Boolean);

    parcelas.forEach(([v, rot])=>{
      if(!v) return;
      const existe = S.shifts.some(s=>ehBolsa(s) && s.data === d && (s.obs === rot || (rot==='Auxílio-Moradia' && s.obs==='Bolsa') || (rot==='Bolsa-Residência' && s.obs==='Complementação')));
      if(existe) return;
      S.shifts.push({ id:uid(), categoria:'bolsa', data:d, localId:l.id, turno:'diurno',
        duracao:0, hora:'', valor:v, liquido:v, pago:false, pagoEm:'', venc:d,
        tipo:'meu', colega:'', contra:'', quitado:false, obs:rot,
        nPart:0, nPlano:0, nProc:0, vPart:0, vPlano:0, vProc:0 });
      criados++;
    });
    m++; if(m > 11){ m = 0; y++; }
  }
  if(criados){ await store.save(S); render(); toast(`${criados} entradas de renda fixa criadas`); }
  else toast('Tudo já estava lançado');
};
$('#f-rep').onchange = ()=>{
  const m = $('#f-rep').value;
  $('#f-wd-wrap').classList.toggle('hidden', m !== 'sem' && m !== 'quinz');
  $('#f-rep-ate-wrap').classList.toggle('hidden', m === '0');
  if(m !== '0' && !$('#f-rep-ate').value){
    const d = parseDate($('#f-date').value || iso(new Date())); d.setMonth(d.getMonth()+3);
    $('#f-rep-ate').value = iso(d);
  }
  atualizarRepHint();
};
$('#f-rep-ate').oninput = atualizarRepHint;
function atualizarRepHint(){
  const m = $('#f-rep').value;
  if(!m || m === '0'){ $('#rep-hint').textContent = '—'; return; }
  const base = $('#f-date').value || iso(new Date()), d0 = parseDate(base);
  const n = datasRepeticao(base).length, ate = repAte(d0);
  const ateTxt = `${pad2(ate.getDate())}/${pad2(ate.getMonth()+1)}/${ate.getFullYear()}`;
  const desc = m === 'mesnth' ? `todo ${ORD[Math.min(4, Math.ceil(d0.getDate()/7)-1)]} ${WD_LONG[d0.getDay()]} do mês`
             : m === 'mesdia' ? `todo dia ${d0.getDate()}`
             : m === 'quinz' ? 'a cada 2 semanas' : 'toda semana';
  $('#rep-hint').textContent = n ? `${desc[0].toUpperCase()+desc.slice(1)} até ${ateTxt}: mais ${n} lançamento${n>1?'s':''} além deste.`
                                 : `Nenhuma data nova até ${ateTxt}. Aumente o "Até".`;
}
$('#f-hora').onchange = janela;
$('#f-durc').oninput = autoValor;

// checklist principal: tratado pelo handler global de [data-cxpay] (aba Caixa).
// Antes havia um handler próprio aqui que marcava como pago e, no mesmo clique,
// o handler global invertia de volta — o item nunca ficava confirmado.

$('#shift-list').addEventListener('click', async e=>{
  if(e.target.closest('[data-map]')) return;
  const pay = e.target.closest('[data-pay]');
  if(pay){ e.stopPropagation(); await alternarPago(pay.dataset.pay); return; }
  const row = e.target.closest('.shift');
  if(row) abrirComTransicao(row, ()=>openSheet(S.shifts.find(x=>x.id===row.dataset.id)));
});

$('#next-card').addEventListener('click', e=>{
  if(e.target.closest('[data-map]')) return;
  const cal = e.target.closest('[data-cal]');
  if(cal){ e.stopPropagation(); openCal(S.shifts.find(x=>x.id===cal.dataset.cal)); return; }
  const c = e.target.closest('[data-id]');
  if(c) openSheet(S.shifts.find(x=>x.id===c.dataset.id));
});

$('#cal-grid').addEventListener('click', e=>{
  const b = e.target.closest('[data-day]'); if(!b) return;
  haptic(5);
  const ds = iso(new Date(cursor.getFullYear(), cursor.getMonth(), +b.dataset.day));
  if(selDia === ds && !itensDoDia(ds).length && !bloqueioDoDia(ds)){ openSheet(null, ds); return; }   // 2º toque num dia vazio lança
  selDia = ds;
  document.querySelectorAll('#cal-grid .cd.sel').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
  renderAgDia();
});
$('#ag-dia').addEventListener('click', async e=>{
  const novo = e.target.closest('[data-novo]'); if(novo){ openSheet(null, novo.dataset.novo); return; }
  const rap = e.target.closest('[data-rap]');
  if(rap){
    const ds = rap.closest('[data-dia]').dataset.dia;
    if(rap.dataset.rap === 'res'){ novoPlantaoResidencia(ds); return; }
    const m = modelosFrequentes(4)[+rap.dataset.rap]; if(!m) return;
    openSheet(null, ds, m.categoria || 'remunerado'); aplicarModelo(m); haptic(8);
    return;
  }
  const bl = e.target.closest('[data-bl]'); if(bl){ const x = S.bloqueios.find(b => b.id === bl.dataset.bl); if(x) openBloqueio(x); return; }
  const pay = e.target.closest('[data-pay]'); if(pay){ e.stopPropagation(); await alternarPago(pay.dataset.pay); return; }
  const row = e.target.closest('.shift'); if(row) abrirComTransicao(row, ()=>openSheet(S.shifts.find(x=>x.id===row.dataset.id)));
});


// aba Caixa
document.addEventListener('click', async e=>{
  const pay = e.target.closest('[data-cxpay]');
  if(pay){
    e.stopPropagation();
    const s = S.shifts.find(x=>x.id===pay.dataset.cxpay);
    if(!s) return;
    s.pago = !s.pago;
    s.pagoEm = s.pago ? (s.pagoEm || iso(new Date())) : '';
    haptic(s.pago ? 12 : 6);
    await store.save(S); render();
    if(s.pago) confettiPay(liq(s));
    if(s.pago){
      // verificar streak após confirmar
      const pagos = S.shifts.filter(x => counts(x) && x.pago && vencimento(x))
        .sort((a,b) => dataCaixa(b).localeCompare(dataCaixa(a)));
      let streak = 0;
      for(const x of pagos){
        const venc = parseDate(vencimento(x));
        const cx   = parseDate(dataCaixa(x));
        if(Math.round((cx-venc)/86400000) <= 7) streak++; else break;
      }
      if(streak >= 3 && streak % 3 === 0){
        haptic(20); toast(`⚡ ${streak} pagos em dia!`);
      } else {
        toast('💰 '+brl(liq(s))+' confirmado');
      }
    } else { toast('Voltou para previsto'); }
    return;
  }
  const g = e.target.closest('[data-goto]');
  if(g){
    const [yy,mm] = g.dataset.goto.split('-').map(Number);
    cursor = new Date(yy, mm, 1); render(); window.scrollTo({top:0,behavior:'smooth'});
    return;
  }
  const o = e.target.closest('[data-cxopen]');
  if(o) openSheet(S.shifts.find(x=>x.id===o.dataset.cxopen));
});

// tr-list removido — aba Trocas substituída por Resumo

$('#loc-list').addEventListener('click', e=>{
  if(e.target.closest('[data-map]')) return;
  const r = e.target.closest('[data-loc]');
  if(r) openLocal(getLocal(r.dataset.loc));
});

$('#csv-ano').onclick = ()=>{
  const y=cursor.getFullYear();
  const s=S.shifts.filter(sh=>parseDate(sh.data).getFullYear()===y);
  baixarCSV(gerarCSV(s),`plantoes-${y}.csv`);
};
$('#csv-tudo').onclick = ()=> baixarCSV(gerarCSV(S.shifts),'plantoes-completo.csv');

$('#recover').onclick = async ()=>{
  const achados = [];
  if(hasCloud && typeof window.storage.list === 'function'){
    try{
      const r = await window.storage.list('plantoes');
      const keys = (r && r.keys) || [];
      for(const item of keys){
        const k = typeof item === 'string' ? item : (item && item.key);
        if(!k) continue;
        const d = await lerNuvem(k);
        if(d) achados.push(d);
      }
    }catch(e){}
  }
  try{
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(!k || k.indexOf('plantoes') !== 0) continue;
      const d = lerLocal(k);
      if(d) achados.push(d);
    }
  }catch(e){}

  const idsS = new Set(S.shifts.map(s=>s.id));
  const idsL = new Set(S.locais.map(l=>l.id));
  let nS = 0, nL = 0;
  achados.forEach(d=>{
    (d.locais||[]).forEach(l=>{ if(l && l.id && !idsL.has(l.id)){ S.locais.push(l); idsL.add(l.id); nL++; } });
    (d.shifts||[]).forEach(s=>{ if(s && s.id && !idsS.has(s.id)){ S.shifts.push(s); idsS.add(s.id); nS++; } });
  });

  if(nS || nL){
    S = normalize(S);
    await store.save(S); render();
    toast(`Recuperados ${nS} plantões e ${nL} locais`);
  }else toast('Nada a mais foi encontrado');
};

$('#export').onclick = ()=>{
  baixarBlob(new Blob([JSON.stringify(S,null,2)],{type:'application/json'}), `plantoes-${iso(new Date())}.json`);
  try{ localStorage.setItem('plantoes:lastBackup', iso(new Date())); }catch(e){}
  toast('Backup baixado');
};
$('#import').onclick = ()=> twoStep($('#import'), ()=> $('#file').click());
// enviar o backup pelo compartilhamento do sistema — o jeito mais simples de levar os dados para outro celular
$('#export-share').onclick = async ()=>{
  const nome = `plantoes-${iso(new Date())}.json`;
  const blob = new Blob([JSON.stringify(S, null, 2)], { type:'application/json' });
  let arq = null; try{ arq = new File([blob], nome, { type:'application/json' }); }catch(e){}
  if(arq && navigator.canShare && navigator.canShare({ files:[arq] })){
    try{
      await navigator.share({ files:[arq], title:'Backup Plantaê!', text:'Backup do Plantaê! — abra no celular novo em Ajustes → Restaurar backup.' });
      lsSet('plantoes:lastBackup', iso(new Date())); renderBackupInfo(); toast('Backup enviado');
    }catch(e){ if(e && e.name !== 'AbortError') toast('Não consegui compartilhar — use Baixar backup'); }
    return;
  }
  baixarBlob(blob, nome); lsSet('plantoes:lastBackup', iso(new Date())); renderBackupInfo();
  toast('Compartilhar não disponível aqui — o backup foi baixado');
};
$('#file').onchange = e=>{
  const f = e.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = async ()=>{
    let d; try{ d = JSON.parse(r.result); }catch(err){ toast('Arquivo inválido'); return; }
    await restaurarDados(d);
  };
  r.readAsText(f); e.target.value = '';
};

// troca os dados deste aparelho pelos de um backup (arquivo ou Drive). Guarda antes uma
// cópia do que havia aqui, para não perder nada por engano.
async function restaurarDados(d, msg = 'Backup restaurado'){
  if(!d || !Array.isArray(d.shifts)){ toast('Arquivo inválido'); return false; }
  if((+d.v||0) > SCHEMA){ toast('Backup feito numa versão mais nova do app. Atualize o app e tente de novo.'); return false; }
  try{ if(S.shifts.length) localStorage.setItem('plantoes:pre-restauracao', JSON.stringify(S)); }catch(e){}
  _histRotulo = 'Restaurou backup';
  S = normalize(d);                 // inclui bloqueios e metas do backup
  _liveEstado = '';
  await store.save(S); render(); toast(msg);
  return true;
}

/* ================= formulário curto em sheet =================
   Substitui prompt() — a janela nativa pode ser bloqueada no app instalado e
   o "1.500,50" virava 150050 ao apagar tudo que não era dígito.           */
function formSheet({ titulo, campos, salvar = 'Salvar', remover = null }){
  return new Promise(resolve => {
    delete $('#sd-body').dataset.saude;
    $('#sd-title').textContent = titulo;
    $('#sd-body').innerHTML = campos.map(c => `<label class="f"><span>${esc(c.label)}</span>
        <input id="fs-${c.id}" type="${c.tipo||'text'}" ${c.tipo==='number'?'inputmode="decimal" step="0.01" min="0"':''}
          value="${esc(c.valor ?? '')}" placeholder="${esc(c.ph||'')}" autocomplete="off"></label>`).join('')
      + `<div class="actions"><button class="btn prim" id="fs-ok">${esc(salvar)}</button></div>`
      + (remover ? `<button class="btn wide fs-rm" id="fs-rm">${esc(remover)}</button>` : '');
    $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
    const primeiro = $('#fs-'+campos[0].id); if(primeiro) primeiro.focus();
    let feito = false;
    const fim = v => { if(feito) return; feito = true; obs.disconnect(); closeSheets(); resolve(v); };
    $('#fs-ok').onclick = () => fim(Object.fromEntries(campos.map(c => [c.id, $('#fs-'+c.id).value])));
    if(remover) $('#fs-rm').onclick = () => fim('remover');
    $('#sd-body').onkeydown = e => { if(e.key === 'Enter' && e.target.tagName === 'INPUT'){ e.preventDefault(); $('#fs-ok').click(); } };
    // fechado por fora (fundo, Fechar, Esc) → cancela
    const obs = new MutationObserver(() => { if(!$('#sheet-detail').classList.contains('open') && !feito){ feito = true; obs.disconnect(); resolve(null); } });
    obs.observe($('#sheet-detail'), { attributes:true, attributeFilter:['class'] });
  });
}

/* ================= transição card → sheet =================
   View Transitions API: o card tocado se transforma no sheet de edição.
   Sem suporte (iOS < 18) ou com "reduzir movimento", abre normalmente.    */
function abrirComTransicao(origem, abrir){
  const reduz = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!document.startViewTransition || reduz || !origem){ abrir(); return; }
  const sh = $('#sheet'), sc = $('#scrim');
  origem.style.viewTransitionName = 'vt-card';
  sh.classList.add('vt-sem-anim'); sc.classList.add('vt-sem-anim');   // evita deslizar e transformar ao mesmo tempo
  let t;
  try{
    t = document.startViewTransition(()=>{ origem.style.viewTransitionName = ''; sh.style.viewTransitionName = 'vt-card'; abrir(); });
  }catch(e){ origem.style.viewTransitionName = ''; sh.classList.remove('vt-sem-anim'); sc.classList.remove('vt-sem-anim'); abrir(); return; }
  t.finished.finally(()=>{ sh.style.viewTransitionName = ''; sh.classList.remove('vt-sem-anim'); sc.classList.remove('vt-sem-anim'); });
}

/* ================= botão + que se recolhe ao rolar ================= */
(function(){
  let ultimoY = window.scrollY, ticking = false;
  const fab = () => $('#fab');
  window.addEventListener('scroll', ()=>{
    if(ticking || _locked) return;
    ticking = true;
    requestAnimationFrame(()=>{
      const y = window.scrollY, f = fab();
      if(f){
        if(y > ultimoY + 6 && y > 120) f.classList.add('fab-oculto');      // descendo
        else if(y < ultimoY - 6 || y < 120) f.classList.remove('fab-oculto'); // subindo ou no topo
      }
      ultimoY = y; ticking = false;
    });
  }, { passive:true });
  // com o teclado aberto (digitando uma anotação, por exemplo) o + também sai do caminho
  document.addEventListener('focusin', e=>{ if(e.target.matches('input, textarea, select') && fab()) fab().classList.add('fab-oculto'); });
  document.addEventListener('focusout', ()=>{ setTimeout(()=>{ if(!document.activeElement || !document.activeElement.matches('input, textarea, select')){ const f = fab(); if(f) f.classList.remove('fab-oculto'); } }, 50); });
})();

/* ================= instalação (Android/Chrome) ================= */
let _instalarEvt = null;
const instalado = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _instalarEvt = e; renderInstalar(); });
window.addEventListener('appinstalled', () => { _instalarEvt = null; renderInstalar(); toast('App instalado ✓'); });
function renderInstalar(){
  const b = $('#btn-instalar'); if(b) b.classList.toggle('hidden', instalado() || !_instalarEvt);
  const t = $('#pref-vibrar'); if(t) t.classList.toggle('on', lsGet('plantoes:vibrar') !== '0');
  const w = $('#wl-instalar'); if(w) w.classList.toggle('hidden', instalado() || !_instalarEvt);
}
document.addEventListener('click', async e=>{
  if(!e.target.closest('#btn-instalar, #wl-instalar') || !_instalarEvt) return;
  _instalarEvt.prompt();
  try{ await _instalarEvt.userChoice; }catch(err){}
  _instalarEvt = null; renderInstalar();
});
// o service worker avisa quando um aviso (ou um botão dele) foi tocado com o app já aberto
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
  const d = e.data || {};
  if(d.tipo === 'abrir-url'){ try{ tratarAcao(new URL(d.url, location.href).searchParams); }catch(err){} return; }
  if(d.tipo === 'abrir-plantao'){ const s = S.shifts.find(x => x.id === d.sid); if(s){ closeSheets(); openSheet(s); } }
});
// ações por endereço: atalhos do ícone (novo, próximo, buscar) e botões dos avisos (ver, anotar, recebi)
function tratarAcao(params){
  const acao = params.get('action'), id = params.get('id');
  const achar = x => S.shifts.find(s => s.id === x);
  if(acao === 'buscar'){ closeSheets(); abrirBusca(); return; }
  if(acao === 'novo'){ closeSheets(); openSheet(null); return; }
  if(acao === 'proximo'){
    const nx = S.shifts.filter(s=>naAgenda(s)&&s.data>=iso(hoje())).sort((a,b)=>a.data.localeCompare(b.data))[0];
    if(nx){ closeSheets(); openSheet(nx); }
    return;
  }
  if(acao === 'plantao'){ const s = achar(id); if(s){ closeSheets(); openSheet(s); } return; }
  if(acao === 'anotar'){
    const s = achar(id); if(!s) return;
    const { ativo } = plantaoAtual();
    if(ativo && ativo.id === s.id){
      closeSheets(); lsSet('plantoes:liveMin', ''); cursor = new Date();
      if(view !== 'mes'){ const b = document.querySelector('nav button[data-v="mes"]'); if(b) b.click(); } else render();
      setTimeout(()=>{ const i = $('#ln-input'); if(i){ i.scrollIntoView({ block:'center' }); i.focus(); } }, 250);
    } else { closeSheets(); openSheet(s); }
    return;
  }
  if(acao === 'recebi'){
    const ids = String(params.get('ids') || id || '').split(',').filter(Boolean);
    const alvo = ids.map(achar).filter(s => s && !s.pago);
    if(!alvo.length){ toast(ids.length ? 'Já estava marcado como recebido' : 'Lançamento não encontrado'); return; }
    const hojeI = iso(new Date()), total = alvo.reduce((a, s) => a + liq(s), 0);
    _histRotulo = 'Recebido pelo aviso';
    comDesfazer(`${brl(total)} marcado${alvo.length > 1 ? 's' : ''} como recebido${alvo.length > 1 ? 's' : ''}`, ()=>{
      alvo.forEach(s => { s.pago = true; s.pagoEm = hojeI; });
    });
  }
}

/* ================= busca ================= */
const semAcento = t => String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
function abrirBusca(){
  delete $('#sd-body').dataset.saude;
  $('#sd-title').textContent = 'Buscar';
  $('#sd-body').innerHTML = `<input id="busca-q" type="search" placeholder="Local, colega, anotação, mês ou data (12/10)" autocomplete="off" enterkeyhint="search" aria-label="Buscar">
    <div id="busca-res" class="busca-res"></div>`;
  $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
  const q = $('#busca-q'); q.focus(); q.oninput = ()=>buscar(q.value); buscar('');
}
function buscar(q){
  const box = $('#busca-res'); if(!box) return;
  const toks = semAcento(q).trim().split(/\s+/).filter(Boolean);
  if(!toks.length){
    box.innerHTML = `<p class="busca-dica">Busca em ${S.shifts.length} lançamentos. Experimente: <b>pendente</b>, <b>noturno</b>, um colega, <b>${MES[new Date().getMonth()]}</b> ou <b>${pad2(new Date().getDate())}/${pad2(new Date().getMonth()+1)}</b>.</p>`;
    return;
  }
  const CAT = { remunerado:'plantao', ambulatorio:'consultorio ambulatorio', residencia:'residencia', bolsa:'renda fixa bolsa' };
  const achados = S.shifts.filter(s => {
    const l = getLocal(s.localId) || {}, d = parseDate(s.data);
    const txt = semAcento([l.nome, l.cidade, s.colega, s.obs, (s.notas||[]).map(n=>n.txt).join(' '),
      CAT[s.categoria]||'', s.turno, `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}`, MES[d.getMonth()], d.getFullYear(),
      counts(s) ? (s.pago ? 'pago recebido caiu' : 'pendente a receber previsto') : '',
      s.tipo==='peguei' ? 'peguei troca' : s.tipo==='passei' ? 'passei troca' : ''].join(' '));
    return toks.every(t => txt.includes(t));
  }).sort((a,b)=>b.data.localeCompare(a.data));
  box.innerHTML = achados.length ? `<p class="busca-dica">${achados.length} resultado${achados.length>1?'s':''}</p>` + achados.slice(0,60).map(s=>{
      const d = parseDate(s.data);
      return `<button class="busca-item" data-busca="${s.id}" style="--c:${localCor(s.localId)}">
        <span class="bi-d"><b>${d.getDate()}</b><small>${MES[d.getMonth()].slice(0,3)} ${String(d.getFullYear()).slice(2)}</small></span>
        <span class="bi-t"><b>${esc(localName(s.localId))}</b><small>${esc(metaLinha(s,''))}${s.colega?' · '+esc(s.colega):''}</small></span>
        ${counts(s) ? `<span class="pill ${s.pago?'pago':'pend'}">${brl(liq(s))}</span>` : ''}</button>`;
    }).join('') : `<p class="busca-dica">Nada encontrado para "${esc(q)}".</p>`;
}
document.addEventListener('click', e=>{
  if(e.target.closest('#btn-busca')){ abrirBusca(); return; }
  const r = e.target.closest('[data-busca]');
  if(r){ const s = S.shifts.find(x=>x.id===r.dataset.busca); closeSheets(); if(s) openSheet(s); }
});

/* ================= boas-vindas (primeira abertura) =================
   O app é público: quem abre sem dados vê um passo a passo curto em vez
   de telas vazias. Cadastra o primeiro local e já abre o primeiro plantão. */
function boasVindas(){
  if(S.locais.length || S.shifts.length || lsGet('plantoes:boasVindas')) return;
  const ov = document.createElement('div');
  ov.id = 'welcome'; ov.className = 'welcome';
  ov.innerHTML = `<div class="wl-card">
    <img src="./icon-192.png" alt="" class="wl-logo">
    <h2>Bem-vindo ao Plantaê!</h2>
    <p class="wl-sub">Seus plantões, o que entra na conta e quando — num lugar só.</p>
    <ul class="wl-list">
      <li><b>Agenda e conflitos</b> — lance plantões e veja choques de horário na hora.</li>
      <li><b>Caixa de verdade</b> — o app calcula quando cada plantão cai na conta.</li>
      <li><b>Avisos</b> — 1h antes de começar e 30 min antes de terminar.</li>
    </ul>
    <div class="wl-step">
      <span class="wl-k">Primeiro passo · onde você dá plantão?</span>
      <input id="wl-nome" placeholder="Ex.: UPA Centro" autocomplete="off" maxlength="60">
      <div class="row2">
        <label class="f"><span>Diurno 12h (R$)</span><input id="wl-dia" type="number" inputmode="decimal" placeholder="1200"></label>
        <label class="f"><span>Noturno 12h (R$)</span><input id="wl-noite" type="number" inputmode="decimal" placeholder="1400"></label>
      </div>
      <label class="f"><span>Paga no dia (do mês seguinte)</span><input id="wl-pag" type="number" inputmode="numeric" value="10" min="1" max="31"></label>
    </div>
    <button class="btn prim wide" id="wl-ok">Cadastrar e lançar meu primeiro plantão</button>
    <button class="btn wide hidden" id="wl-instalar" style="margin-top:10px">Instalar o app neste celular</button>
    <div class="wl-alt"><button id="wl-restore">Tenho um backup</button><button id="wl-drive" class="hidden">Backup no Google Drive</button><button id="wl-skip">Explorar primeiro</button></div>
  </div>`;
  document.body.appendChild(ov);
  lockScroll(); renderInstalar();
  const fechar = ()=>{ lsSet('plantoes:boasVindas','1'); ov.classList.add('out'); setTimeout(()=>ov.remove(), 300); unlockScroll(); };
  ov.querySelector('#wl-skip').onclick = fechar;
  ov.querySelector('#wl-restore').onclick = ()=>{ fechar(); $('#file').click(); };
  // celular novo: conectar o Google já oferece o último backup do Drive (conta.js)
  pushConfig().then(cfg => { const b = ov.querySelector('#wl-drive'); if(cfg.google && b){ b.classList.remove('hidden'); b.onclick = ()=>{ fechar(); gConectar(); }; } }).catch(()=>{});
  ov.querySelector('#wl-ok').onclick = async ()=>{
    const nome = ov.querySelector('#wl-nome').value.trim();
    if(!nome){ ov.querySelector('#wl-nome').focus(); toast('Dê um nome ao local'); return; }
    S.locais.push({ id:uid(), nome, cidade:'', endereco:'', cor:CORES[0],
      vDia: parseFloat(ov.querySelector('#wl-dia').value)||0, vNoite: parseFloat(ov.querySelector('#wl-noite').value)||0,
      pagDia: Math.min(31, Math.max(1, parseInt(ov.querySelector('#wl-pag').value)||10)), pagMes:1, pagIncerto:false, retencao:0 });
    await store.save(S); fechar(); render();
    setTimeout(()=>openSheet(null, iso(new Date()), 'remunerado'), 320);
  };
}

/* ================= paletas ================= */
const PALETAS = [
  { id:'',          nome:'Clássico',     desc:'Índigo original',                 sw:['#F8F9FA','#6366F1','#059669','#D97706'], bg:['#F8F9FA','#18181B'] },
  { id:'diaenoite', nome:'Dia e Noite',  desc:'Âmbar de dia, índigo à noite',    sw:['#FAF8F5','#D97706','#4F46E5','#0284C7'], bg:['#FAF8F5','#0F1115'] },
  { id:'cirurgico', nome:'Cirúrgico',    desc:'Verde-azulado sobre grafite',     sw:['#F3F7F7','#0D9488','#0E1B1D','#15803D'], bg:['#F3F7F7','#0A1213'] },
  { id:'fintech',   nome:'Fintech',      desc:'Preto, branco e verde-limão',     sw:['#F5F5F2','#0A0A0A','#C6F432','#3F7D0B'], bg:['#F5F5F2','#0A0A0A'] },
  { id:'daltonico', nome:'Daltonismo',   desc:'Azul e laranja, sem verde e vermelho', sw:['#F7F8FA','#1D4ED8','#0072B2','#E69F00'], bg:['#F7F8FA','#111318'] },
];
function aplicarPaleta(){
  const id = lsGet('plantoes:paleta'), r = document.documentElement;
  if(id) r.dataset.paleta = id; else delete r.dataset.paleta;
  const h = new Date().getHours();
  r.dataset.fase = (h >= 6 && h < 18) ? 'dia' : 'noite';
  // cor da barra de status acompanha o fundo da paleta
  const pal = PALETAS.find(p => p.id === id) || PALETAS[0];
  THEME_META.forEach(par => {
    const escuro = (par[0].dataset.tema || par[0].getAttribute('media') || '').includes('dark');
    par[1] = pal.bg[escuro ? 1 : 0];
    if(!r.classList.contains('modo-plantao')) par[0].content = par[1];
  });
}
function renderPaletas(){
  const g = $('#pal-grid'); if(!g) return;
  const atual = lsGet('plantoes:paleta');
  g.innerHTML = PALETAS.map(p => `<button class="pal ${p.id===atual?'on':''}" data-pal="${p.id}">
    <span class="pal-sw">${p.sw.map(c=>`<i style="background:${c}"></i>`).join('')}</span>
    <span><b>${p.nome}</b><br><small>${p.desc}</small></span></button>`).join('');
}
document.addEventListener('click', e=>{
  const b = e.target.closest('[data-pal]'); if(!b) return;
  lsSet('plantoes:paleta', b.dataset.pal);
  aplicarPaleta(); renderPaletas(); haptic(8);
  toast('Paleta ' + (PALETAS.find(p=>p.id===b.dataset.pal)||PALETAS[0]).nome);
});

/* ================= modelos de plantão =================
   Detectados do histórico, sem cadastro: combinações de categoria + local +
   turno + horário + duração que se repetem (≥2× em 6 meses). O valor vem do
   lançamento mais recente daquela combinação.                              */
let _modelos = [];
function modelosFrequentes(max = 6){
  const lim = iso(new Date(Date.now() - 180*86400000));
  const m = new Map();
  for(const s of S.shifts){
    if(s.data < lim || !counts(s) || ehBolsa(s) || !getLocal(s.localId) || !s.hora || !(+s.duracao > 0)) continue;
    const k = [s.categoria||'remunerado', s.localId, s.turno, s.hora, +s.duracao].join('|');
    const e = m.get(k) || { n:0, ult:null };
    e.n++; if(!e.ult || s.data > e.ult.data) e.ult = s;
    m.set(k, e);
  }
  return [...m.values()].filter(e => e.n >= 2)
    .sort((a,b) => b.n - a.n || b.ult.data.localeCompare(a.ult.data))
    .slice(0, max).map(e => e.ult);
}
// "UPA Acrízio Menezes (Justinópolis)" → "UPA Acrízio Menezes"
const nomeCurto = id => localName(id).replace(/\s*\(.*?\)\s*/g, ' ').trim();
function rotuloModelo(m){
  const t = ehAmb(m) ? 'Consultório' : m.turno === 'noturno' ? 'Noturno' : 'Diurno';
  return `${t} · ${m.hora} · ${m.duracao}h${liq(m) ? ' · '+brl(liq(m)) : ''}`;
}
function renderModelosSheet(novo){
  _modelos = novo ? modelosFrequentes() : [];
  $('#f-modelos').classList.toggle('hidden', !_modelos.length);
  $('#f-mod-row').innerHTML = _modelos.map((m,i)=>`<button type="button" class="mod" data-mod="${i}" style="--c:${localCor(m.localId)}">
    <i></i><span><b>${esc(nomeCurto(m.localId))}</b><small>${rotuloModelo(m)}</small></span></button>`).join('');
}
function aplicarModelo(m){
  chipSet('#f-cat', m.categoria || 'remunerado');
  fillLocalSelect(m.localId); $('#f-newlocal-wrap').classList.add('hidden');
  chipSet('#f-turno', m.turno);
  const preset = [6,12,24,36].includes(+m.duracao);
  chipSet('#f-dur', preset ? String(m.duracao) : 'custom');
  $('#f-durc-wrap').classList.toggle('hidden', preset);
  if(!preset) $('#f-durc').value = m.duracao;
  $('#f-hora').value = m.hora;
  aplicarCategoria(); categoriaPeloLocal();
  if(!ehAmb(m)){
    $('#f-valor').value = m.valor || ''; valorTouched = true;
    $('#f-liquido').value = liq(m) || ''; liqTouched = true;
  }
  vencTouched = false; atualizarVenc(); janela();
  conflitoOk = false;
  haptic(8);
}
$('#f-mod-row').addEventListener('click', e=>{
  const b = e.target.closest('[data-mod]'); if(!b) return;
  aplicarModelo(_modelos[+b.dataset.mod]);
  $$('#f-mod-row .mod').forEach(x => x.classList.toggle('on', x === b));
});

/* ================= saúde dos dados =================
   Varredura dos lançamentos à procura do que costuma passar despercebido.
   Cada problema tem uma chave estável para poder ser ignorado.            */
const fmtD = d => { const x = parseDate(d); return pad2(x.getDate())+'/'+pad2(x.getMonth()+1); };
function problemasDados(){
  const out = [], t = iso(hoje());
  let ign = []; try{ ign = JSON.parse(lsGet('plantoes:saudeIgn') || '[]'); }catch(e){}
  const add = p => { if(!ign.includes(p.key)) out.push(p); };
  const lim = iso(new Date(Date.now() - 120*86400000));
  const agenda = S.shifts.filter(s => naAgenda(s) && !ehBloq(s) && !ehBolsa(s) && s.data >= lim);

  // duplicados: mesmo dia, hora, local e tipo
  const grupos = {};
  agenda.forEach(s => { const k = [s.data, s.hora, s.localId, s.categoria].join('|'); (grupos[k] = grupos[k] || []).push(s); });
  const emDup = new Set();
  Object.values(grupos).filter(g => g.length > 1).forEach(g => {
    g.slice(1).forEach(s => emDup.add(s.id));   // mantém um representante na checagem de conflito
    add({ key:'dup:'+g.map(s=>s.id).sort().join(','), nivel:'alto', tag:'Duplicado', alvo:g[1].id,
      titulo: localName(g[0].localId),
      desc: `${g.length} lançamentos idênticos em ${fmtD(g[0].data)} às ${g[0].hora||'--:--'}. Se um é repetição, abra e exclua.` });
  });

  // horários sobrepostos (fora os duplicados exatos)
  const jan = agenda.filter(s => +s.duracao > 0 && !emDup.has(s.id)).map(s => ({ s, j: janelaDe(s) })).sort((a,b)=>a.j.ini - b.j.ini);
  for(let i = 0; i < jan.length; i++){
    for(let k = i+1; k < jan.length && jan[k].j.ini < jan[i].j.fim; k++){
      const a = jan[i].s, b = jan[k].s;
      add({ key:`sob:${a.id}:${b.id}`, nivel:'alto', tag:'Conflito', alvo:b.id,
        titulo: `${nomeCurto(a.localId)} × ${nomeCurto(b.localId)}`,
        desc: `Horários se sobrepõem em ${fmtD(a.data)}: ${a.hora} (${a.duracao}h) e ${fmtD(b.data)} ${b.hora} (${b.duracao}h).` });
    }
  }

  S.shifts.forEach(s => {
    if(ehBloq(s)) return;
    if(!getLocal(s.localId))
      add({ key:'sl:'+s.id, nivel:'medio', tag:'Sem local', alvo:s.id, titulo:'Lançamento sem local',
        desc:`${fmtD(s.data)} · o local foi excluído. Abra e escolha um local para ele voltar aos relatórios.` });
    else if(counts(s) && !ehBolsa(s) && !(liq(s) > 0))
      add({ key:'sv:'+s.id, nivel:'medio', tag:'Sem valor', alvo:s.id, titulo: localName(s.localId),
        desc:`${fmtD(s.data)} · sem valor lançado, então fica fora do faturamento e do caixa.` });
    else if(counts(s) && !s.pago && vencimento(s) < iso(new Date(Date.now() - 30*86400000))){
      const dias = Math.round((hoje() - parseDate(vencimento(s)))/86400000);
      add({ key:'atr:'+s.id, nivel: dias > 60 ? 'alto' : 'medio', tag:'Atrasado', alvo:s.id, pagar:true,
        titulo: `${localName(s.localId)} · ${brl(liq(s))}`,
        desc:`Plantão de ${fmtD(s.data)}, vencido há ${dias} dias. Se já caiu e você esqueceu de marcar, confirme aqui.` });
    }
  });
  const ordem = { alto:0, medio:1 };
  return out.sort((a,b) => ordem[a.nivel] - ordem[b.nivel]);
}

const ICON_SETA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>';
function renderSaude(){
  const el = $('#h-saude'); if(!el) return;
  const n = problemasDados().length;
  el.innerHTML = n ? `<button class="saude-bar" id="saude-open"><span>🩺 <b>${n} ${n>1?'itens':'item'} para revisar</b> nos seus lançamentos</span>${ICON_SETA}</button>` : '';
  if($('#sheet-detail').classList.contains('open') && $('#sd-body').dataset.saude) renderSaudeLista();
}
function renderSaudeLista(){
  const lista = problemasDados();
  $('#sd-title').textContent = 'Saúde dos dados';
  $('#sd-body').dataset.saude = '1';
  $('#sd-body').innerHTML = lista.length ? lista.map(p => `<div class="sd-item">
      <div class="sd-top"><span class="sd-tag ${p.nivel==='alto'?'alto':''}">${p.tag}</span><b>${esc(p.titulo)}</b></div>
      <p>${esc(p.desc)}</p>
      <div class="sd-acts">
        ${p.pagar ? `<button class="prim" data-saude-pay="${p.alvo}">Já caiu</button>` : ''}
        <button class="${p.pagar?'':'prim'}" data-saude-open="${p.alvo}">${p.pagar?'Abrir':'Corrigir'}</button>
        <button data-saude-ign="${esc(p.key)}">Ignorar</button>
      </div></div>`).join('')
    : `<div class="sd-ok">✓ Tudo certo com os seus lançamentos</div>`;
}
document.addEventListener('click', e=>{
  if(e.target.closest('#saude-open')){
    renderSaudeLista();
    $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
    return;
  }
  const op = e.target.closest('[data-saude-open]');
  if(op){ const s = S.shifts.find(x=>x.id===op.dataset.saudeOpen); closeSheets(); if(s) openSheet(s); return; }
  const pg = e.target.closest('[data-saude-pay]');
  if(pg){
    const s = S.shifts.find(x=>x.id===pg.dataset.saudePay); if(!s) return;
    comDesfazer(`Recebimento confirmado · ${brl(liq(s))}`, ()=>{ s.pago = true; s.pagoEm = s.pagoEm || iso(new Date()); });
    return;
  }
  const ig = e.target.closest('[data-saude-ign]');
  if(ig){
    let ign = []; try{ ign = JSON.parse(lsGet('plantoes:saudeIgn') || '[]'); }catch(err){}
    ign.push(ig.dataset.saudeIgn); lsSet('plantoes:saudeIgn', JSON.stringify(ign.slice(-500)));
    renderSaude(); renderSaudeLista(); haptic(6);
  }
});

/* ================= avisos (notificações) =================
   Três avisos por plantão: 1h antes de começar, 30 min antes de terminar e
   (opcional) na véspera às 20h. Agendados pelo próprio app: disparam com o app
   aberto ou recém-usado. Ao voltar para o app, avisos perdidos há ≤10 min saem.
   Disparo pelo service worker — iPhone/Android não aceitam new Notification()
   em app instalado (era o motivo do aviso antigo não aparecer).             */
const AVISO_DEF = { inicio:true, fim:true, vespera:false, pag:true };
const AVISO_INI_MS = 60*60000, AVISO_FIM_MS = 30*60000, AVISO_ATRASO_MS = 10*60000;
let _avisoTimers = [];

const urlPlantao = id => './?action=plantao&id=' + encodeURIComponent(id);
function avisoPrefs(){ try{ return { ...AVISO_DEF, ...JSON.parse(lsGet('plantoes:avisos') || '{}') }; }catch(e){ return { ...AVISO_DEF }; } }
function avisosVistos(){ try{ return JSON.parse(lsGet('plantoes:avisosVistos') || '[]'); }catch(e){ return []; } }
function marcarAvisoVisto(tag){ const v = avisosVistos(); v.push(tag); lsSet('plantoes:avisosVistos', JSON.stringify(v.slice(-300))); }
const notifSuportada = () => 'Notification' in window;
const notifAtiva = () => notifSuportada() && Notification.permission === 'granted';

// lista de avisos dos plantões próximos (janela real: data + hora + duração)
function avisosPendentes(now = Date.now(), horizonte = 8*86400000){
  const p = avisoPrefs(), out = [];
  const lim = iso(new Date(now - 3*86400000));
  for(const s of S.shifts){
    if(!naAgenda(s) || ehBolsa(s) || ehBloq(s) || !(+s.duracao > 0) || s.data < lim) continue;
    const j = janelaDe(s), nome = localName(s.localId), l = getLocal(s.localId);
    const hIni = s.hora || '07:00', hFim = fim(hIni, s.duracao);
    const onde = l && l.cidade ? ` · ${l.cidade}` : '';
    const tipo = ehResid(s) ? nomeResid(s) : ehAmb(s) ? 'Consultório' : 'Plantão';
    // botões do aviso (Android; o iPhone mostra só o aviso): rota até o local e o próprio plantão
    const url = urlPlantao(s.id), ver = { acao:'ver', titulo:'Ver plantão', url };
    const mapa = mapsUrl(l), rota = mapa ? [{ acao:'rota', titulo:'Como chegar', url: mapa }] : [];
    if(p.inicio) out.push({ at: j.ini - AVISO_INI_MS, tag:`ini:${s.id}:${j.ini}`, sid:s.id, url, acoes:[...rota, ver],
      title:`${tipo} em 1 hora`, body:`${nome} · ${hIni} → ${hFim} · ${s.duracao}h${onde}` });
    if(p.fim) out.push({ at: j.fim - AVISO_FIM_MS, tag:`fim:${s.id}:${j.fim}`, sid:s.id, url,
      acoes:[{ acao:'anotar', titulo:'Anotar', url:'./?action=anotar&id='+encodeURIComponent(s.id) }, ver],
      title:`${tipo} termina em 30 min`, body:`${nome} · até ${hFim}${counts(s) && liq(s) ? ' · '+brl(liq(s))+' a receber' : ''}` });
    if(p.vespera){
      const v = new Date(j.ini); v.setDate(v.getDate()-1); v.setHours(20,0,0,0);
      if(v.getTime() < j.ini - AVISO_INI_MS) out.push({ at: v.getTime(), tag:`vesp:${s.id}:${j.ini}`, sid:s.id, url, acoes:[...rota, ver],
        title:`${tipo} amanhã`, body:`${nome} · ${hIni} · ${s.duracao}h${onde}` });
    }
  }
  // dia previsto do pagamento, às 10h: um aviso por local e dia, com "Recebi" para dar baixa sem abrir o app
  if(p.pag){
    const hojeI = iso(new Date(now)), grupos = new Map();
    for(const s of S.shifts){
      if(!counts(s) || s.pago || !(liq(s) > 0) || vencIncerto(s)) continue;
      const v = vencimento(s); if(v < hojeI) continue;
      const k = v + ':' + (s.localId || '-');
      if(!grupos.has(k)) grupos.set(k, { v, localId: s.localId, itens: [] });
      grupos.get(k).itens.push(s);
    }
    for(const [k, g] of grupos){
      const d = parseDate(g.v); d.setHours(10, 0, 0, 0);
      const n = g.itens.length, total = g.itens.reduce((a, s) => a + liq(s), 0);
      const ids = g.itens.map(s => s.id), url = urlPlantao(ids[0]);
      const qual = ehBolsa(g.itens[0]) ? '' : ` · ${n} ${n > 1 ? 'plantões' : 'plantão'}`;
      out.push({ at: d.getTime(), tag:`pag:${k}`, sid: ids[0], url,
        acoes:[{ acao:'recebi', titulo:'Recebi', url:'./?action=recebi&ids='+ids.map(encodeURIComponent).join(',') }, { acao:'ver', titulo:'Ver', url }],
        title:'Pagamento previsto hoje', body:`${localName(g.localId)}${qual} · ${brl(total)}` });
    }
  }
  return out.filter(a => a.at > now - AVISO_ATRASO_MS && a.at <= now + horizonte).sort((a,b)=>a.at - b.at);
}

async function mostrarNotificacao(title, opts){
  // badge = ícone pequeno da barra de status do Android: precisa ser silhueta branca
  const o = { icon:'./icon-192.png', badge:'./icons/badge-96.png', vibrate:[120,60,120], ...opts };
  try{
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if(reg && reg.showNotification){ await reg.showNotification(title, o); return true; }
  }catch(e){}
  try{ const { actions, ...simples } = o; new Notification(title, simples); return true; }catch(e){ return false; }   // botões só existem no aviso do service worker
}

async function dispararAviso(a){
  if(avisosVistos().includes(a.tag) || !notifAtiva()) return;
  marcarAvisoVisto(a.tag);
  // tocar no aviso abre o próprio plantão
  const sid = a.sid || a.tag.split(':')[1] || '', acoes = (a.acoes || []).slice(0, 2);
  await mostrarNotificacao(a.title, { body:a.body, tag:a.tag, actions: acoes.map(x => ({ action:x.acao, title:x.titulo })),
    data:{ url: a.url || urlPlantao(sid), sid, acoes } });
  if(!document.hidden) toast('🔔 ' + a.title);   // com o app em primeiro plano o iPhone pode não exibir o banner
}

// recria todos os timers — chamado a cada render e ao voltar para o app
function agendarNotificacoes(){
  _avisoTimers.forEach(clearTimeout); _avisoTimers = [];
  if(!notifAtiva()) return;
  agendarSyncPush();
  if(pushAtivo()) return;          // o servidor entrega (inclusive com o app fechado) — sem timers locais duplicados
  const now = Date.now(), vistos = new Set(avisosVistos());
  for(const a of avisosPendentes(now)){
    if(vistos.has(a.tag)) continue;
    const ms = a.at - now;
    if(ms <= 0) dispararAviso(a);                       // perdido há pouco (app estava fechado)
    else _avisoTimers.push(setTimeout(()=>dispararAviso(a), ms));
  }
}
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) agendarNotificacoes(); });

const caminhoNotif = () => SO === 'android' ? 'Configurações → Aplicativos → Plantaê! → Notificações'
                         : SO === 'ios' ? 'Ajustes do iPhone → Notificações → Plantaê!' : 'configurações do navegador';
async function pedirPermissaoNotif(){
  if(!notifSuportada()){
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    toast(ios ? 'No iPhone, instale o app na Tela de Início para ativar os avisos' : SO === 'android' ? 'Abra pelo Chrome e instale o app para ativar os avisos' : 'Este navegador não suporta notificações');
    return false;
  }
  if(Notification.permission === 'denied'){ toast('Avisos bloqueados — libere em ' + caminhoNotif()); renderAvisosUI(); return false; }
  if(Notification.permission !== 'granted'){
    const r = await Notification.requestPermission();
    if(r !== 'granted'){ toast('Permissão não concedida'); renderAvisosUI(); return false; }
    toast('Avisos ativados ✓');
  }
  agendarNotificacoes(); renderAvisosUI();
  return true;
}

// seção de Ajustes: estado, preferências e o próximo aviso agendado
function renderAvisosUI(){
  const st = $('#notif-status'); if(!st) return;
  const p = avisoPrefs(), btn = $('#btn-notif');
  ['inicio','fim','vespera','pag'].forEach(k => $('#av-'+k).classList.toggle('on', !!p[k]));
  let txt, cor = '';
  if(!notifSuportada()){
    txt = /iP(hone|ad|od)/.test(navigator.userAgent)
      ? 'Instale o app na Tela de Início (Safari → Compartilhar → Adicionar à Tela de Início) para ativar'
      : 'Não suportado neste navegador';
    btn.classList.add('hidden');
  } else if(Notification.permission === 'denied'){
    txt = 'Bloqueados — libere em ' + caminhoNotif(); cor = 'var(--due)';
    btn.classList.add('hidden');
  } else if(Notification.permission !== 'granted'){
    txt = 'Desativados'; btn.classList.remove('hidden'); btn.textContent = 'Ativar';
  } else {
    const prox = avisosPendentes().find(a => a.at > Date.now() && !avisosVistos().includes(a.tag));
    if(prox){
      const d = new Date(prox.at);
      txt = `Próximo: ${quandoDia(prox.at)} às ${pad2(d.getHours())}:${pad2(d.getMinutes())} — ${prox.title.toLowerCase()}`;
    } else txt = (p.inicio || p.fim || p.vespera || p.pag) ? 'Ativados · nenhum plantão nos próximos dias' : 'Ativados, mas todos os tipos estão desligados';
    cor = 'var(--ok)';
    btn.classList.add('hidden');
  }
  st.textContent = txt; st.style.color = cor;
  renderPushStatus();
}

$('#btn-notif-teste').onclick = async ()=>{
  if(!notifAtiva() && !(await pedirPermissaoNotif())) return;
  // com o servidor ativo, o teste percorre o caminho real: app → servidor → QStash → celular
  if(pushAtivo() && await testePush()){ toast('Teste enviado pelo servidor — chega em alguns segundos (pode fechar o app)'); return; }
  const ok = await mostrarNotificacao('Plantaê! 🔔', { body:'Os avisos estão funcionando neste aparelho.', tag:'teste-'+Date.now() });
  toast(ok ? 'Aviso de teste enviado' : 'Não consegui mostrar o aviso');
};

/* ================= avisos pelo servidor (Web Push) =================
   O app manda a lista dos próximos avisos (até 7 dias) para /api/agendar,
   que agenda cada um no QStash; na hora, /api/enviar manda o push e ele
   chega mesmo com o app fechado. O servidor não guarda nada: o app guarda
   os ids dos agendamentos e pede o cancelamento quando a agenda muda.
   Se o servidor não estiver configurado, valem os avisos locais.          */
const PUSH_HORIZONTE = 6.5 * 86400000, PUSH_RESYNC = 20 * 3600000;
let _pushCfg = null, _pushTimer = null, _pushRodando = false;
const pushAtivo = () => lsGet('plantoes:pushOk') === '1';
const pushSuportado = () => 'serviceWorker' in navigator && 'PushManager' in window;
function hashTxt(t){ let h = 2166136261; for(let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function b64url(b64){ const pad = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
async function pushConfig(){
  if(_pushCfg && !_pushCfg.offline) return _pushCfg;
  try{ const r = await fetch('./api/config', { cache:'no-store' }); _pushCfg = r.ok ? await r.json() : { ativo:false }; }
  catch(e){ _pushCfg = { ativo:false, offline:true }; }
  if(!_pushCfg || typeof _pushCfg.ativo !== 'boolean') _pushCfg = { ativo:false };
  return _pushCfg;
}
async function pushAssinatura(cfg){
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // chave do servidor mudou: refaz a inscrição
  if(sub && lsGet('plantoes:pushChave') && lsGet('plantoes:pushChave') !== cfg.vapidPublica){ try{ await sub.unsubscribe(); }catch(e){} sub = null; }
  if(!sub){ sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: b64url(cfg.vapidPublica) }); lsSet('plantoes:pushChave', cfg.vapidPublica); }
  return sub;
}
function avisosParaServidor(now){
  return paraServidor(avisosPendentes(now, PUSH_HORIZONTE).filter(a => a.at > now + 20000).slice(0, 40));
}
const paraServidor = lista => lista.map(a => {
  const sid = a.sid || a.tag.split(':')[1] || '';
  return { at:a.at, tag:a.tag, title:a.title, body:a.body, sid, url: a.url || urlPlantao(sid), acoes: (a.acoes || []).slice(0, 2) };
});
/* Espelho da agenda de avisos (35 dias) no Cache Storage: o service worker não lê o
   localStorage, então é por aqui que ele renova os agendamentos em segundo plano
   (Periodic Background Sync), sem o app aberto. O "estado" (hash, ids no QStash) é
   compartilhado: quem sincronizou por último vale.                                   */
const ESTADO_CACHE = 'plantoes-estado', ESPELHO_URL = new URL('./__estado/avisos.json', location.href).href;
let _espelhoHash = '';
async function lerEspelho(){
  try{ const r = await (await caches.open(ESTADO_CACHE)).match(ESPELHO_URL); return r ? await r.json() : null; }catch(e){ return null; }
}
async function gravarEspelho(esp){
  try{ await (await caches.open(ESTADO_CACHE)).put(ESPELHO_URL, new Response(JSON.stringify(esp), { headers:{ 'content-type':'application/json' } })); }catch(e){}
}
async function espelharAvisos(subJ, estado){
  if(!('caches' in window)) return;
  const avisos = paraServidor(avisosPendentes(Date.now(), 35 * 86400000).slice(0, 300));
  const h = hashTxt(JSON.stringify([subJ.endpoint, avisos, estado]));
  if(h === _espelhoHash) return;
  _espelhoHash = h;
  await gravarEspelho({ sub: subJ, avisos, estado, em: Date.now() });
}
let _renovacaoPedida = false;
async function registrarRenovacao(){
  if(_renovacaoPedida) return; _renovacaoPedida = true;
  try{
    const reg = await navigator.serviceWorker.ready;
    if(!reg.periodicSync) return;
    const p = navigator.permissions ? await navigator.permissions.query({ name:'periodic-background-sync' }).catch(() => null) : null;
    if(p && p.state !== 'granted') return;           // o Chrome libera para apps instalados e usados com frequência
    await reg.periodicSync.register('avisos', { minInterval: 12 * 3600000 });
  }catch(e){}
}
function agendarSyncPush(){ clearTimeout(_pushTimer); _pushTimer = setTimeout(()=>sincronizarPush(false), 2500); }
async function sincronizarPush(forcar){
  if(_pushRodando || !notifAtiva() || !pushSuportado()) return;
  _pushRodando = true;
  try{
    const cfg = await pushConfig();
    if(!cfg.ativo){ if(!cfg.offline) lsSet('plantoes:pushOk', ''); return; }
    const sub = await pushAssinatura(cfg);
    const now = Date.now(), avisos = avisosParaServidor(now);
    const subJ = sub.toJSON ? sub.toJSON() : sub;
    const hash = hashTxt(subJ.endpoint + JSON.stringify(avisos.map(a => [a.at, a.tag, a.title, a.body])));
    let ult = {}; try{ ult = JSON.parse(lsGet('plantoes:pushSync') || '{}'); }catch(e){}
    // o service worker pode ter renovado em segundo plano: adota o estado mais recente
    const esp = await lerEspelho();
    if(esp && esp.estado && (esp.estado.em || 0) > (ult.em || 0)){ ult = esp.estado; lsSet('plantoes:pushSync', JSON.stringify(ult)); }
    // nada mudou e sincronizou há menos de 20h: não gasta agendamentos à toa
    if(!forcar && ult.hash === hash && now - (ult.em||0) < PUSH_RESYNC && pushAtivo()){ espelharAvisos(subJ, ult); registrarRenovacao(); return; }
    const r = await fetch('./api/agendar', { method:'POST', headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ sub: subJ, cancelar: ult.ids || [], avisos }) });
    if(!r.ok) throw new Error('agendar respondeu ' + r.status);
    const d = await r.json();
    const estado = { hash, em: now, ids: (d.ids || []).filter(Boolean), n: avisos.length };
    lsSet('plantoes:pushSync', JSON.stringify(estado));
    await espelharAvisos(subJ, estado);
    registrarRenovacao();
    const antes = pushAtivo();
    lsSet('plantoes:pushOk', '1');
    if(!antes){ _avisoTimers.forEach(clearTimeout); _avisoTimers = []; }
  }catch(e){
    registrarErro(e, 'push');
    lsSet('plantoes:pushOk', '');
  }finally{
    _pushRodando = false;
    renderAvisosUI();
  }
}
async function testePush(){
  try{
    const cfg = await pushConfig(); if(!cfg.ativo) return false;
    const sub = await pushAssinatura(cfg);
    const r = await fetch('./api/agendar', { method:'POST', headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ sub: sub.toJSON(), cancelar: [], avisos: [{ at: Date.now() + 3000, tag:'teste-'+Date.now(), title:'Plantaê! 🔔', body:'Aviso de teste pelo servidor — chega mesmo com o app fechado.', url:'./' }] }) });
    return r.ok;
  }catch(e){ registrarErro(e, 'push:teste'); return false; }
}
function renderPushStatus(){
  const el = $('#push-status'), linha = $('#push-linha'); if(!el) return;
  let ult = {}; try{ ult = JSON.parse(lsGet('plantoes:pushSync') || '{}'); }catch(e){}
  let txt;
  if(!pushSuportado()) txt = 'Entrega: só com o app aberto (este navegador não recebe push)';
  else if(!notifAtiva()) txt = 'Entrega: ative as notificações primeiro';
  else if(pushAtivo()) txt = `Entrega pelo servidor ✓ chegam com o app fechado · ${ult.n||0} agendado${(ult.n||0)===1?'':'s'}`;
  else if(_pushCfg && !_pushCfg.ativo && !_pushCfg.offline) txt = 'Entrega: só com o app aberto (servidor de avisos não configurado)';
  else txt = 'Entrega: só com o app aberto';
  el.textContent = txt;
  linha.classList.toggle('ok', pushAtivo() && notifAtiva());
}

/* ================= MODO PLANTÃO (em andamento) =================
   Quando o relógio está dentro da janela de um plantão, a tela inicial vira
   um painel de acompanhamento e o app entra em tema OLED. Minimizar devolve o
   tema normal e deixa uma barra compacta. Até 3h após o fim, mostra o card de
   "plantão concluído" com a previsão de pagamento.                          */
const LIVE_POS_MS = 3 * 3600000;
const THEME_META = Array.from(document.querySelectorAll('meta[name="theme-color"]')).map(m=>[m, m.content]);
let _liveEstado = '', _liveId = null;

function lsGet(k){ try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } }
function lsSet(k,v){ try{ v ? localStorage.setItem(k,v) : localStorage.removeItem(k); }catch(e){} }

// plantão em andamento e o recém-encerrado. Considera início em dias anteriores
// (noturno que começou ontem, plantões de 24h/36h).
function plantaoAtual(now = Date.now()){
  const limite = iso(new Date(now - 3*86400000));
  const hojeIso = iso(new Date(now));
  let ativo = null, recente = null, jA = null, jR = null;
  for(const s of S.shifts){
    if(!naAgenda(s) || ehBolsa(s) || ehBloq(s)) continue;
    if(!(+s.duracao > 0) || s.data < limite || s.data > hojeIso) continue;
    const j = janelaDe(s);
    if(j.ini <= now && now < j.fim){ if(!jA || j.ini > jA.ini){ ativo = s; jA = j; } }
    else if(j.fim <= now && now - j.fim < LIVE_POS_MS){ if(!jR || j.fim > jR.fim){ recente = s; jR = j; } }
  }
  return { ativo, recente };
}

// 6h37 · 6h · 37min
function fmtMin(m){ m = Math.max(0, m); const h = Math.floor(m/60), mm = m % 60; return h ? `${h}h${mm ? pad2(mm) : ''}` : `${mm}min`; }
// decorrido + restante sempre fecham a duração (sem 5h12 + 6h47 = 11h59)
function minutosLive(s, now){
  const j = janelaDe(s), tot = Math.round((j.fim - j.ini)/60000);
  const dec = Math.min(tot, Math.max(0, Math.floor((now - j.ini)/60000)));
  return { tot, dec, rest: tot - dec };
}
function quandoDia(ts){
  const d = new Date(ts);
  const dias = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - hoje())/86400000);
  return dias === 0 ? 'hoje' : dias === 1 ? 'amanhã' : dias === -1 ? 'ontem' : WD[d.getDay()];
}

function setModoPlantao(on){
  const r = document.documentElement;
  if(r.classList.contains('modo-plantao') === on) return;
  r.classList.toggle('modo-plantao', on);
  THEME_META.forEach(([m, orig]) => { m.content = on ? '#000000' : orig; });
}

const ICON_MIN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_PLUS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const RING_R = 88, RING_C = 2 * Math.PI * RING_R;

function renderLive(){
  const box = $('#live-panel'); if(!box) return;
  const now = Date.now();
  const { ativo, recente } = plantaoAtual(now);
  const mesAtual = sameMonth(iso(hoje()), cursor);
  let modo = 'none';
  if(ativo) modo = (lsGet('plantoes:liveMin') === ativo.id || !mesAtual) ? 'bar' : 'full';
  else if(recente && lsGet('plantoes:liveDone') !== recente.id) modo = 'done';

  setModoPlantao(modo === 'full');

  const s = ativo || recente;
  _liveId = s ? s.id : null;
  // assinatura: só remonta o painel quando algo estrutural muda — assim o
  // campo de anotação não perde o que está sendo digitado a cada atualização
  const estado = modo + ':' + (s ? [s.id, s.hora, s.duracao, s.localId, s.valor, s.liquido, s.pago].join('|') : '');
  const mudou = estado !== _liveEstado;
  if(mudou){ _liveEstado = estado; renderNext(); }

  if(modo === 'none'){ box.innerHTML = ''; return; }
  if(mudou || !box.firstElementChild) montarLive(box, modo, s, now);
  tickLive(s, now);
}

function montarLive(box, modo, s, now){
  const j = janelaDe(s);
  const cor = localCor(s.localId), nome = esc(localName(s.localId));
  const hIni = s.hora || '07:00', hFim = fim(hIni, s.duracao), dur = +s.duracao;
  const tipo = ehResid(s) ? nomeResid(s) : ehAmb(s) ? 'Consultório' : (s.turno === 'noturno' ? 'Noturno' : 'Diurno');
  const valor = liq(s), remunerado = counts(s) && valor > 0;

  if(modo === 'bar'){
    box.innerHTML = `<button class="live-bar" id="live-expand" style="--lc:${cor}" aria-label="Abrir painel do plantão">
      <i class="live-dot"></i><b>Em plantão</b><span>${nome}</span><em class="lb-t" id="lb-t"></em>${ICON_CHEV}</button>`;
    return;
  }

  if(modo === 'done'){
    const v = parseDate(vencimento(s));
    const prev = s.pago ? 'já recebido'
      : vencIncerto(s) ? `previsto para ${MES[v.getMonth()]}`
      : `cai em ${pad2(v.getDate())}/${pad2(v.getMonth()+1)}`;
    const n = (s.notas||[]).length;
    box.innerHTML = `<section class="live live-done">
      <div class="ld-check"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <div class="ld-title">Plantão concluído</div>
      <div class="ld-sub">${nome} · ${dur}h · ${hIni} → ${hFim}</div>
      ${remunerado ? `<div class="ld-val money">${brl(valor)}</div><div class="ld-sub">${prev}</div>` : ''}
      ${n ? `<div class="ld-sub" style="margin-top:10px">${n} anotaç${n>1?'ões':'ão'} registrada${n>1?'s':''}</div>` : ''}
      <div class="ld-rest">Bom descanso.</div>
      <div class="live-actions">
        <button id="live-det">Ver plantão</button>
        <button id="ld-ok" class="prim">Dispensar</button>
      </div>
    </section>`;
    return;
  }

  // marcas de cada hora ao redor do anel (até 36h fica legível)
  const H = Math.round(dur);
  let ticks = '';
  if(H >= 2 && H <= 36){
    for(let k = 1; k < H; k++){
      const a = (-90 + 360 * k / H) * Math.PI / 180;
      ticks += `<circle class="lr-tick" data-k="${k/H}" cx="${(100 + 72*Math.cos(a)).toFixed(2)}" cy="${(100 + 72*Math.sin(a)).toFixed(2)}" r="1.7"/>`;
    }
  }
  const stat3 = remunerado
    ? `<div class="ls"><small>Já rendeu</small><b class="money" id="ls-rendeu">—</b><em>de ${brl(valor)}</em></div>`
    : `<div class="ls"><small>Tipo</small><b>${tipo}</b><em>${ehResid(s) ? 'sem remuneração' : '—'}</em></div>`;

  box.innerHTML = `<section class="live" style="--lc:${cor}">
    <div class="live-top"><i class="live-dot"></i>Em plantão
      <button class="live-min" id="live-min" aria-label="Minimizar painel">${ICON_MIN}</button></div>
    <div class="live-local">${nome}</div>
    <div class="live-meta">${ehResid(s) || ehAmb(s) ? '' : (s.turno === 'noturno' ? ICON_MOON : ICON_SUN)}
      <span>${tipo} · ${hIni} → ${hFim} · ${dur}h</span></div>

    <div class="live-ring">
      <svg viewBox="0 0 200 200" role="img" aria-label="Progresso do plantão">
        <circle class="lr-track" cx="100" cy="100" r="${RING_R}"/>
        <circle class="lr-fill" id="lr-fill" cx="100" cy="100" r="${RING_R}" transform="rotate(-90 100 100)"
          stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/>
        ${ticks}
      </svg>
      <div class="lr-center"><div class="lr-big" id="lr-big">—</div><div class="lr-sm" id="lr-sm"></div></div>
    </div>
    <div class="live-falta" id="live-falta"></div>

    <div class="live-stats">
      <div class="ls"><small>Início</small><b>${hIni}</b><em>${quandoDia(j.ini)}</em></div>
      <div class="ls"><small>Fim</small><b>${hFim}</b><em>${quandoDia(j.fim)}</em></div>
      ${stat3}
    </div>

    <div class="live-notes">
      <div class="ln-head"><span>Anotações</span><span id="ln-count"></span></div>
      <div id="ln-list"></div>
      <div class="ln-add">
        <input id="ln-input" type="text" maxlength="200" enterkeyhint="done" autocomplete="off"
          placeholder="Anotar algo rápido…" aria-label="Nova anotação">
        <button id="ln-add-btn" aria-label="Adicionar anotação">${ICON_PLUS}</button>
      </div>
      <div class="ln-hint" id="ln-hint">Fica salvo neste aparelho e no backup. Evite dados que identifiquem pacientes.</div>
    </div>

    <div class="live-actions"><button id="live-det">Detalhes do plantão</button></div>
  </section>`;
  renderLiveNotas(s);
}

// atualização leve (a cada 15s): só números e anel, sem tocar no resto
function tickLive(s, now){
  if(!s) return;
  const j = janelaDe(s), mt = minutosLive(s, now);
  const lb = $('#lb-t'); if(lb) lb.textContent = 'faltam ' + fmtMin(mt.rest);
  const fill = $('#lr-fill'); if(!fill) return;
  const pct = mt.tot ? mt.dec / mt.tot : 0;
  // primeiro quadro parte do zero para o anel "encher" ao abrir
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ fill.setAttribute('stroke-dashoffset', (RING_C * (1 - pct)).toFixed(2)); }));
  $$('.lr-tick').forEach(t => t.classList.toggle('done', +t.dataset.k <= pct));
  const h = Math.floor(mt.dec/60), mm = mt.dec % 60;
  $('#lr-big').innerHTML = h ? `${h}<i>h</i>${pad2(mm)}` : `${mm}<i>min</i>`;
  const sm = $('#lr-sm');
  sm.textContent = pct >= .9 ? `reta final · ${Math.round(pct*100)}%` : `de ${+s.duracao}h · ${Math.round(pct*100)}%`;
  sm.classList.toggle('final', pct >= .9);
  $('#live-falta').innerHTML = `Faltam <b>${fmtMin(mt.rest)}</b> · termina ${quandoDia(j.fim)} às ${fim(s.hora||'07:00', s.duracao)}`;
  const r = $('#ls-rendeu'); if(r) r.textContent = brl(liq(s) * pct);
}

function renderLiveNotas(s){
  const list = $('#ln-list'); if(!list) return;
  const notas = s.notas || [];
  list.innerHTML = notas.map((n,i)=>`<div class="ln"><time>${esc(n.h)}</time><span>${esc(n.txt)}</span>
    <button data-ln-del="${i}" aria-label="Apagar anotação">×</button></div>`).join('');
  $('#ln-count').textContent = notas.length ? notas.length : '';
  const hint = $('#ln-hint'); if(hint) hint.classList.toggle('hidden', notas.length > 0);
}

async function addNotaLive(){
  const inp = $('#ln-input'); if(!inp) return;
  const txt = inp.value.trim(); if(!txt) { inp.focus(); return; }
  const s = S.shifts.find(x=>x.id===_liveId); if(!s) return;
  const d = new Date();
  (s.notas = s.notas || []).push({ h: pad2(d.getHours())+':'+pad2(d.getMinutes()), em: d.toISOString(), txt });
  inp.value = '';
  renderLiveNotas(s);
  haptic(8);
  await store.save(S);
}

$('#live-panel').addEventListener('click', async e=>{
  const s = S.shifts.find(x=>x.id===_liveId);
  if(e.target.closest('#live-min')){ lsSet('plantoes:liveMin', _liveId); haptic(6); renderLive(); return; }
  if(e.target.closest('#live-expand')){
    lsSet('plantoes:liveMin', '');
    // navegando em outro mês: volta para o mês atual para abrir o painel
    if(!sameMonth(iso(hoje()), cursor)){ cursor = new Date(); render(); }
    else renderLive();
    window.scrollTo({top:0, behavior:'smooth'});
    return;
  }
  if(e.target.closest('#live-det')){ if(s) openSheet(s); return; }
  if(e.target.closest('#ld-ok')){ lsSet('plantoes:liveDone', _liveId); renderLive(); return; }
  if(e.target.closest('#ln-add-btn')){ addNotaLive(); return; }
  const del = e.target.closest('[data-ln-del]');
  if(del && s){
    const idx = +del.dataset.lnDel;
    comDesfazer('Anotação apagada', ()=>{ s.notas.splice(idx, 1); _liveEstado = ''; });
  }
});
$('#live-panel').addEventListener('keydown', e=>{
  if(e.key === 'Enter' && e.target.id === 'ln-input'){ e.preventDefault(); addNotaLive(); }
});
// relógio do painel: a cada 15s e ao voltar para o app
setInterval(()=>{ if(!document.hidden){ aplicarPaleta(); renderLive(); } }, 15000);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) renderLive(); });

// anotações também aparecem (e podem ser apagadas) no sheet de edição
function renderNotasSheet(s){
  const wrap = $('#f-notas-wrap'), notas = (s && s.notas) || [];
  wrap.classList.toggle('hidden', !notas.length);
  $('#f-notas').innerHTML = notas.map((n,i)=>`<div class="fn-item"><time>${esc(n.h)}</time><span>${esc(n.txt)}</span>
    <button type="button" data-fn-del="${i}" aria-label="Apagar anotação">×</button></div>`).join('');
}
$('#f-notas').addEventListener('click', async e=>{
  const b = e.target.closest('[data-fn-del]'); if(!b || !editing || !editing.notas) return;
  const alvo = editing, idx = +b.dataset.fnDel;
  comDesfazer('Anotação apagada', ()=>{ alvo.notas.splice(idx, 1); _liveEstado = ''; });
  renderNotasSheet(alvo);
});

/* ================= início ================= */
async function relatorioDiagnostico(){
  let erros = []; try{ erros = JSON.parse(lsGet(DIAG_KEY) || '[]'); }catch(e){}
  let uso = '';
  try{ if(navigator.storage && navigator.storage.estimate){ const q = await navigator.storage.estimate(); uso = `${Math.round((q.usage||0)/1024)} KB de ${Math.round((q.quota||0)/1048576)} MB`; } }catch(e){}
  let persist = '?'; try{ persist = navigator.storage && navigator.storage.persisted ? String(await navigator.storage.persisted()) : 'n/d'; }catch(e){}
  const tam = Math.round(JSON.stringify(S).length/1024);
  const instalado = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  const linhas = [
    `Plantaê! v${APP_VERSAO} · dados v${S.v||'?'} (app espera v${SCHEMA})`,
    `Gerado em ${new Date().toLocaleString('pt-BR')}`,
    `Aparelho: ${navigator.userAgent}`,
    `Tela ${screen.width}×${screen.height} · ${instalado ? 'instalado na Tela de Início' : 'aberto no navegador'} · tema ${temaEscuro()?'escuro':'claro'}${lsGet('plantoes:tema')?' (fixo)':' (automático)'} · paleta ${lsGet('plantoes:paleta')||'clássico'}`,
    `Dados: ${S.shifts.length} lançamentos · ${S.locais.length} locais · ${S.bloqueios.length} bloqueios · ${tam} KB${uso ? ' · armazenamento '+uso : ''} · persistente: ${persist}`,
    `Avisos: ${notifSuportada() ? Notification.permission : 'não suportado'} · saúde dos dados: ${problemasDados().length} item(ns) · histórico: ${histLer().length} ações`,
    '',
    erros.length ? `Erros registrados (${erros.length}):` : 'Nenhum erro registrado.',
    ...erros.slice().reverse().map(e => `• ${new Date(e.em).toLocaleString('pt-BR')} [v${e.v}${e.aba?' · '+e.aba:''}${e.n>1?' · '+e.n+'×':''}] ${e.msg}${e.onde?' @ '+e.onde:''}${e.stack?'\n    '+e.stack:''}`),
  ];
  return linhas.join('\n');
}
function renderDiagnostico(){
  const el = $('#diag-status'); if(!el) return;
  let erros = []; try{ erros = JSON.parse(lsGet(DIAG_KEY) || '[]'); }catch(e){}
  el.textContent = erros.length
    ? `${erros.length} erro${erros.length>1?'s':''} registrado${erros.length>1?'s':''} · último ${new Date(erros[erros.length-1].em).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`
    : 'Nenhum erro registrado neste aparelho ✓';
  el.style.color = erros.length ? 'var(--due)' : 'var(--ok)';
}
document.addEventListener('click', async e=>{
  if(e.target.closest('#diag-copiar')){
    const txt = await relatorioDiagnostico();
    let ok = false;
    try{ await navigator.clipboard.writeText(txt); ok = true; }catch(err){}
    if(ok){ toast('Relatório copiado — cole na conversa'); return; }
    // sem área de transferência: mostra o texto selecionado para copiar à mão
    delete $('#sd-body').dataset.saude;
    $('#sd-title').textContent = 'Relatório de diagnóstico';
    $('#sd-body').innerHTML = `<p class="hint" style="margin:0 0 8px">Selecione tudo e copie.</p><textarea id="diag-txt" readonly style="min-height:320px;font-size:12px;font-family:ui-monospace,monospace">${esc(txt)}</textarea>`;
    $('#sheet-detail').classList.add('open'); $('#scrim').classList.add('open'); lockScroll();
    const t = $('#diag-txt'); t.focus(); t.select();
    return;
  }
  if(e.target.closest('#diag-compartilhar')){
    const txt = await relatorioDiagnostico();
    if(navigator.share){ try{ await navigator.share({ title:'Diagnóstico Plantaê!', text: txt }); }catch(err){} }
    else toast('Compartilhar não está disponível aqui — use Copiar');
    return;
  }
  if(e.target.closest('#diag-limpar')){
    const antes = lsGet(DIAG_KEY);
    lsSet(DIAG_KEY, ''); renderDiagnostico();
    toast('Registro de erros limpo', { label:'Desfazer', fn: ()=>{ lsSet(DIAG_KEY, antes); renderDiagnostico(); } });
  }
});

/* ================= histórico de alterações =================
   A cada salvamento compara com o último estado salvo e registra o que mudou.
   Guarda só a versão anterior de cada item alterado (não cópias inteiras),
   nas últimas 50 ações, fora do backup. Desfazer devolve esses itens.      */
const HIST_KEY = 'plantoes:hist', HIST_MAX = 50, HIST_COLS = ['shifts','locais','bloqueios'];
const HIST_TOPO = ['metaMensal','metaAnual','metaObjetivo','limiarHoras'];
let _base = null, _histRotulo = '';
const histLer = () => { try{ return JSON.parse(lsGet(HIST_KEY) || '[]'); }catch(e){ return []; } };
function histGravar(lista){
  // se o aparelho estiver sem espaço, descarta as entradas mais antigas até caber
  for(let n = lista.length; n >= 0; n -= 5){
    try{ localStorage.setItem(HIST_KEY, JSON.stringify(lista.slice(-n))); return; }catch(e){}
  }
}
const rotShift = s => `${localName(s.localId)} ${s.data ? fmtD(s.data) : ''}`.trim();
const CAMPOS_NOMES = { valor:'valor', liquido:'líquido', data:'data', hora:'horário', duracao:'duração', localId:'local',
  turno:'turno', obs:'observação', venc:'vencimento', categoria:'tipo', colega:'colega', tipo:'origem', urgente:'urgência' };
function descreverMudanca(col, antes, depois){
  if(col === 'shifts'){
    const alvo = depois || antes;
    if(!antes) return ehBolsa(alvo) ? `Lançou renda fixa · ${rotShift(alvo)}` : `Lançou ${ehAmb(alvo)?'consultório':'plantão'} · ${rotShift(alvo)}`;
    if(!depois) return `Excluiu · ${rotShift(antes)}`;
    const dif = Object.keys({...antes, ...depois}).filter(k => JSON.stringify(antes[k]) !== JSON.stringify(depois[k]));
    if(dif.every(k => k==='pago' || k==='pagoEm')) return depois.pago ? `Confirmou recebimento · ${rotShift(depois)} · ${brl(liq(depois))}` : `Voltou para previsto · ${rotShift(depois)}`;
    if(dif.length === 1 && dif[0] === 'notas') return `Anotação · ${rotShift(depois)}`;
    const nomes = dif.map(k => CAMPOS_NOMES[k]).filter(Boolean);
    return `Editou · ${rotShift(depois)}${nomes.length ? ' ('+[...new Set(nomes)].slice(0,3).join(', ')+')' : ''}`;
  }
  if(col === 'locais'){
    if(!antes) return `Cadastrou local · ${depois.nome}`;
    if(!depois) return `Excluiu local · ${antes.nome}`;
    return `Editou local · ${depois.nome}`;
  }
  const b = depois || antes, per = b.ini ? ` · ${fmtD(b.ini)}${b.fim && b.fim!==b.ini ? '–'+fmtD(b.fim) : ''}` : '';
  return (!antes ? 'Bloqueou agenda' : !depois ? 'Removeu bloqueio' : 'Editou bloqueio') + per;
}
function registrarHistorico(novo){
  if(!_base){ _base = JSON.parse(JSON.stringify(novo)); return; }
  const ops = [], descs = [];
  for(const col of HIST_COLS){
    const A = new Map((_base[col]||[]).map(x=>[x.id,x])), B = new Map((novo[col]||[]).map(x=>[x.id,x]));
    for(const [id, x] of B){
      const ant = A.get(id);
      if(!ant){ ops.push({ col, id, antes:null }); descs.push(descreverMudanca(col, null, x)); }
      else if(JSON.stringify(ant) !== JSON.stringify(x)){ ops.push({ col, id, antes:ant }); descs.push(descreverMudanca(col, ant, x)); }
    }
    for(const [id, ant] of A) if(!B.has(id)){ ops.push({ col, id, antes:ant }); descs.push(descreverMudanca(col, ant, null)); }
  }
  for(const k of HIST_TOPO){
    if(JSON.stringify(_base[k]) !== JSON.stringify(novo[k])){
      ops.push({ topo:k, antes: _base[k] === undefined ? null : _base[k] });
      descs.push({ metaMensal:'Alterou a meta mensal', metaAnual:'Alterou a meta anual', metaObjetivo:'Alterou o objetivo', limiarHoras:'Alterou o limite de horas' }[k]);
    }
  }
  _base = JSON.parse(JSON.stringify(novo));
  if(!ops.length){ _histRotulo = ''; return; }
  // várias mudanças de uma vez (repetição, renda fixa, restauração) viram uma linha só
  const lanc = descs.filter(d => d.startsWith('Lançou')).length;
  let desc = descs.length === 1 ? descs[0]
           : lanc === descs.length ? `Lançou ${lanc} lançamentos · a partir de ${descs[0].split(' · ').pop()}`
           : `${descs.length} alterações · ${descs[0]}…`;
  if(_histRotulo) desc = _histRotulo + ' · ' + desc;
  _histRotulo = '';
  const lista = histLer();
  lista.push({ id: uid(), em: new Date().toISOString(), desc, ops });
  histGravar(lista.slice(-HIST_MAX));
}
async function desfazerHistorico(id){
  const lista = histLer(), ent = lista.find(e => e.id === id);
  if(!ent) return;
  if(document.querySelector('.sheet.open')) closeSheets();
  for(const op of [...ent.ops].reverse()){
    if(op.topo){ if(op.antes === null) delete S[op.topo]; else S[op.topo] = op.antes; continue; }
    const arr = S[op.col] = S[op.col] || [];
    const i = arr.findIndex(x => x.id === op.id);
    if(op.antes === null){ if(i >= 0) arr.splice(i, 1); }
    else if(i >= 0) arr[i] = op.antes; else arr.push(op.antes);
  }
  S = aplicarPadroes(S);
  _histRotulo = 'Desfez';
  _liveEstado = '';
  await store.save(S); render(); haptic(8);
  toast('Desfeito: ' + ent.desc.replace(/^Desfez · /,''));
}
function renderHistorico(){
  const el = $('#hist-lista'); if(!el) return;
  const lista = histLer().slice().reverse();
  const quando = iso => { const d = new Date(iso), hj = hoje(); const dia = Math.round((new Date(d.getFullYear(),d.getMonth(),d.getDate()) - hj)/86400000);
    return `${dia===0?'hoje':dia===-1?'ontem':pad2(d.getDate())+'/'+pad2(d.getMonth()+1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const mostrar = el.dataset.tudo ? lista : lista.slice(0, 8);
  el.innerHTML = lista.length ? mostrar.map(e => `<div class="hist-item">
      <div class="hi-t"><b>${esc(e.desc)}</b><small>${quando(e.em)}</small></div>
      <button class="btn sm" data-hist-undo="${e.id}">Desfazer</button></div>`).join('')
    + (lista.length > 8 && !el.dataset.tudo ? `<button class="btn sm wide" id="hist-mais" style="margin-top:8px">Ver todas (${lista.length})</button>` : '')
    : '<div class="empty">Nenhuma alteração registrada ainda.</div>';
}
document.addEventListener('click', e=>{
  const u = e.target.closest('[data-hist-undo]');
  if(u){ desfazerHistorico(u.dataset.histUndo); return; }
  if(e.target.closest('#hist-mais')){ $('#hist-lista').dataset.tudo = '1'; renderHistorico(); }
});

/* ================= versão dos dados e migrações =================
   Cada mudança no formato dos dados ganha um passo numerado em MIGRACOES.
   Os dados guardam a versão em S.v; ao abrir, só os passos que faltam rodam,
   em ordem, e uma cópia do original fica em localStorage antes de migrar.
   aplicarPadroes() completa campos ausentes e pode rodar quantas vezes for. */
const SCHEMA = 3;
const MIGRACOES = {
  // 1 · bloqueios saíram da lista de plantões para S.bloqueios
  1: d => {
    const antigos = (d.shifts||[]).filter(s=>s.categoria==='bloqueio').map(s=>({
      id: s.id || uid(), motivo: s.blTipo||'ferias', ini: s.data, fim: s.blFim||s.data, obs: s.obs||'' }));
    d.bloqueios = [...(d.bloqueios||[]), ...antigos];
    d.shifts = (d.shifts||[]).filter(s=>s.categoria!=='bloqueio');
    return d;
  },
  // 2 · anotações do modo plantão: sempre lista de {h, txt}
  2: d => {
    (d.shifts||[]).forEach(s=>{
      if(s.notas == null) return;
      s.notas = (Array.isArray(s.notas) ? s.notas : [])
        .filter(n => n && String(n.txt||'').trim())
        .map(n => ({ h: String(n.h||'--:--').slice(0,5), em: n.em || '', txt: String(n.txt).slice(0,500) }));
    });
    return d;
  },
  // 3 · números guardados como texto em versões antigas viram número
  3: d => {
    (d.shifts||[]).forEach(s=>{
      s.valor = +s.valor || 0;
      s.duracao = +s.duracao || 0;
      if(s.liquido !== '' && s.liquido != null) s.liquido = +s.liquido || 0;
    });
    (d.locais||[]).forEach(l=>{ l.vDia = +l.vDia || 0; l.vNoite = +l.vNoite || 0; l.pagDia = +l.pagDia || 10; });
    ['metaMensal','metaAnual'].forEach(k=>{ if(d[k] != null) d[k] = +d[k] || 0; });
    return d;
  },
};
function migrar(d){
  const de = +d.v || 0;
  if(de > SCHEMA) return d;   // veio de uma versão mais nova do app: não mexe
  if(de < SCHEMA){
    try{ const k = 'plantoes:pre-migracao-v'+de; if(!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(d)); }catch(e){}
    d = JSON.parse(JSON.stringify(d));
    for(let v = de + 1; v <= SCHEMA; v++) d = MIGRACOES[v](d);
  }
  d.v = SCHEMA;
  return d;
}
function aplicarPadroes(d){
  // ...l / ...d preservam campos que antes eram descartados a cada recarga
  const locais = (d.locais||[]).map((l,i)=>({
    ...l,
    id:l.id, nome:l.nome, cidade:l.cidade||'', endereco:l.endereco||'',
    cor:l.cor||CORES[i%CORES.length], vDia:l.vDia||0, vNoite:l.vNoite||0,
    pagDia: l.pagDia || 10,
    pagMes: typeof l.pagMes === 'number' ? l.pagMes : 1,
    pagIncerto: !!l.pagIncerto,
    retencao: +l.retencao || 0
  }));
  const bloqueios = (d.bloqueios||[])
    .filter((b,i,a)=>a.findIndex(x=>x.id===b.id)===i) // deduplicar
    .map(b=>({ id:b.id||uid(), motivo:b.motivo||'ferias', ini:b.ini||b.data||'', fim:b.fim||b.ini||'', obs:b.obs||'' }));
  const shifts = (d.shifts||[]).filter(s=>s.categoria!=='bloqueio').map(s=>({
    ...s, categoria: s.categoria || 'remunerado',
    urgente: !!s.urgente, blTipo:'', blFim:'',
    nPart:+s.nPart||0, nPlano:+s.nPlano||0, nProc:+s.nProc||0,
    vPart:+s.vPart||0, vPlano:+s.vPlano||0, vProc:+s.vProc||0
  }));
  return { ...d, shifts, locais, bloqueios };
}
function normalize(d){ return aplicarPadroes(migrar(d)); }

(async function init(){
  const saved = await store.load();
  if(saved && Array.isArray(saved.shifts)){
    const veio = +saved.v || 0;
    S = normalize(saved);
    _base = JSON.parse(JSON.stringify(S));      // base do histórico: abrir o app não é uma "alteração"
    if(veio < SCHEMA) await store.save(S);   // grava já no formato novo
    if(veio > SCHEMA) toast('Estes dados vieram de uma versão mais nova do app — atualize para não perder nada');
  }
  if(!_base) _base = JSON.parse(JSON.stringify(S));
  // preferência de saldo oculto sobrevive ao fechar o app
  try{ if(localStorage.getItem('plantoes:oculto')){ saldoOculto = true; } }catch(e){}
  render();
  if(saldoOculto) aplicarOcultar();
  boasVindas();
  marcarLocalResidencia();
  // pede ao navegador para não apagar os dados por falta de espaço/uso (iOS/Chrome)
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
  // dismiss splash screen — usa RAF para garantir que o elemento existe no DOM
  // sai assim que a primeira tela está pronta (antes esperava 0,8 s fixos a cada abertura)
  function dismissSplash(){
    const splash = document.getElementById('splash');
    if(!splash) return;
    requestAnimationFrame(()=>{
      splash.classList.add('out');
      setTimeout(()=>{ if(splash.parentNode) splash.parentNode.removeChild(splash); }, 260);
    });
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', dismissSplash, {once:true});
  } else {
    dismissSplash();
  }
  // Safari fora do modo app não expõe Notification — antes isso lançava erro e
  // interrompia o init (atalhos ?action=novo / proximo não funcionavam)
  if('Notification' in window && Notification.permission==='granted') agendarNotificacoes();
  // atalhos do ícone e botões dos avisos chegam como ?action=…
  const params = new URLSearchParams(location.search);
  if(params.get('action')){ history.replaceState(history.state, '', location.pathname); setTimeout(()=>tratarAcao(params), 300); }
})();

/* ================= tema: Automático / Claro / Escuro ================= */
function renderTema(){
  const atual = lsGet('plantoes:tema');
  document.querySelectorAll('#tema-segs button').forEach(b => b.classList.toggle('on', b.dataset.tema === atual));
}
document.addEventListener('click', e => {
  const b = e.target.closest('#tema-segs button'); if(!b) return;
  lsSet('plantoes:tema', b.dataset.tema);
  aplicarTema(b.dataset.tema);
  aplicarPaleta(); renderTema(); haptic(8);
  toast(b.dataset.tema ? 'Tema ' + b.textContent.toLowerCase() : 'Tema automático — acompanha o celular');
});
renderTema();

/* uma vez: o Hospital Felício Rocho cadastrado antes desta versão vira local da residência
   (pedido do usuário), e os plantões dele ainda não recebidos passam a ser sem remuneração */
function marcarLocalResidencia(){
  if(lsGet('plantoes:residAuto') || S.locais.some(l => l.residencia)) return;
  const l = S.locais.find(x => /felicio\s*rocho/i.test(semAcentoLocal(x.nome)));
  lsSet('plantoes:residAuto', '1');
  if(!l) return;
  const alvo = S.shifts.filter(s => s.localId === l.id && (s.categoria||'remunerado') === 'remunerado' && !s.pago);
  setTimeout(() => comDesfazer(`${l.nome} agora é local da residência${alvo.length ? ` · ${alvo.length} lançamento${alvo.length>1?'s':''} sem remuneração` : ''}`, () => {
    l.residencia = true;
    alvo.forEach(s => { s.categoria = 'residencia'; s.valor = 0; s.liquido = 0; s.venc = ''; s.urgente = false; });
  }), 1200);
}

/* deslizar o dedo para o lado troca o mês (calendário) ou a semana (linha do tempo) */
function aoDeslizar(el, fn){
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); }, { passive: true });
  el.addEventListener('touchend', e => {
    if(x0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
    if(Math.abs(dx) > 60 && Math.abs(dy) < 45 && Date.now() - t0 < 700) fn(dx < 0 ? 1 : -1);
  }, { passive: true });
}
function animarTroca(el, dir){
  el.classList.remove('vem-esq', 'vem-dir'); void el.offsetWidth;
  el.classList.add(dir > 0 ? 'vem-dir' : 'vem-esq');
}
aoDeslizar($('#cal-mes'), dir => {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1); render(); haptic(6);
  animarTroca($('#cal-grid'), dir);
});
aoDeslizar($('#week-view'), dir => {
  semanaAtual.setDate(semanaAtual.getDate() + 7 * dir); renderSemana(); haptic(6);
  const tl = document.querySelector('#week-view .tl'); if(tl) animarTroca(tl, dir);
});
