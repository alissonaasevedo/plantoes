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
    const txt = JSON.stringify(data);
    let ok = false;
    if(hasCloud){ try{ await window.storage.set(KEY, txt); ok = true; }catch(e){} }
    try{ localStorage.setItem(KEY, txt); ok = true; }catch(e){}
    if(!ok) toast('Não consegui salvar');
    return ok;
  }
};

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
const haptic = (ms=8) => { try{ navigator.vibrate && navigator.vibrate(ms); }catch(e){} };
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

function evTitulo(s){ return (ehResid(s) ? 'Residência · ' : 'Plantão · ') + localName(s.localId); }
function evLocal(s){
  const l = getLocal(s.localId); if(!l) return '';
  return [l.endereco, l.cidade].filter(Boolean).join(', ') || [l.nome, l.cidade].filter(Boolean).join(', ');
}
function evDetalhe(s){
  const p = [`${s.duracao}h · ${s.turno}`];
  if(ehResid(s)) p.push('Plantão obrigatório — agenda bloqueada');
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
    b.onclick = ()=>{ clearTimeout(toastT); t.classList.remove('on'); acao.fn(); };
    t.appendChild(b);
  }
  t.classList.toggle('has-act', !!acao);
  t.classList.add('on');
  // mensagens longas (conflitos) ficam mais tempo; com ação, 5s para dar tempo de desfazer
  const dur = acao ? 5500 : Math.min(5000, Math.max(1900, msg.length * 55));
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('on'), dur);
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
  const ilMes=$('#il-mes'); if(ilMes) ilMes.textContent=MES[cursor.getMonth()]+' '+cursor.getFullYear();
  const ilCx=$('#il-caixa'); if(ilCx) ilCx.textContent='Caixa · '+MES[cursor.getMonth()];
  $('#mnav').classList.toggle('hidden', view !== 'mes' && view !== 'caixa');
  // só a aba visível é redesenhada (antes eram as 5, com gráficos, a cada toque);
  // trocar de aba chama render() de novo e desenha a nova
  ({ mes:renderMes, caixa:renderCaixa, resumo:()=>{ renderResumo(); renderAno(); }, locais:renderLocais, ajustes:renderAjustes })[view]();
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
          <div style="font-size:11px;padding:3px 9px;border-radius:99px;background:rgba(200,56,79,.07);color:var(--due);border:1px solid rgba(200,56,79,.22);flex:none">Pendente</div>
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
  renderWeekStrip();
  renderDia();
  renderSemana();

  const shown = filter==='due' ? list.filter(s=>counts(s) && !s.pago) : list;
  $('#list-count').textContent = filter==='due' ? 'Pendentes de pagamento' : 'Plantões';

  const el = $('#shift-list');
  if(!shown.length){
    el.innerHTML = list.length
      ? `<div class="empty">Tudo recebido neste mês.</div>`
      : `<div class="empty">Mês em branco.<br>Toque em + ou em um dia do calendário para lançar.</div>`;
    return;
  }
  const t = iso(hoje());
  // Agrupar por período: Hoje / Ontem / Esta semana / + antigos por data
  const hj = iso(hoje());
  const ant = iso(new Date(Date.now()-86400000));
  const semAtr = iso(new Date(Date.now()-7*86400000));
  function grupoData(s){
    if(s.data === hj)  return 'Hoje';
    if(s.data === ant) return 'Ontem';
    if(s.data > semAtr) return 'Esta semana';
    return pad2(parseDate(s.data).getDate())+'/'+pad2(parseDate(s.data).getMonth()+1);
  }
  // montar html com separadores de grupo
  let grupoAtual = null;
  let shiftIdx = 0;
  // anima a entrada só ao trocar de mês/filtro — não a cada toque em "Pago"
  const listKey = cursor.getFullYear()+'-'+cursor.getMonth()+'-'+filter;
  const animar = el.dataset.k !== listKey; el.dataset.k = listKey;
  el.innerHTML = shown.map(s=>{
    const grupo = grupoData(s);
    const sep = grupo !== grupoAtual
      ? `<div class="list-sep">${grupo}</div>`
      : '';
    grupoAtual = grupo;
    const d = parseDate(s.data), off = !counts(s), l = getLocal(s.localId);
    const cid = l && l.cidade ? ` · ${esc(l.cidade)}` : '';
    let tag = '';
    if(s.tipo==='peguei') tag = `<div class="tag">Peguei de ${esc(s.colega||'colega')}</div>`;
    if(s.tipo==='passei') tag = `<div class="tag">Passei para ${esc(s.colega||'colega')}</div>`;
    if(!tag && s.urgente && !ehResid(s) && !ehBolsa(s)) tag = `<div class="chip-urg">⚠️ Atenção</div>`;
    else if(!tag && s.obs) tag = `<div class="tag">${esc(s.obs.slice(0,42))}</div>`;
    const resid = ehResid(s), bloq = ehBloq(s);
    if(resid) tag = `<div class="tag">Residência · sem remuneração</div>`;
    if(bloq){
      const icos={'ferias':'🏖️','viagem':'✈️','sobreaviso':'📟','compromisso':'📌','outro':'📋'};
      tag = `<div class="chip-bl">${icos[s.blTipo]||'📋'} ${s.blTipo||'bloqueio'}${s.blFim?' até '+pad2(parseDate(s.blFim).getDate())+'/'+pad2(parseDate(s.blFim).getMonth()+1):''}</div>`;
    }
    if(ehBolsa(s) && s.obs) tag = `<div class="tag">${esc(s.obs)}</div>`;
    const pill = (off || resid) ? '' : `<div class="pill ${s.pago?'pago':'pend'}" data-pay="${s.id}">${s.pago?'Pago':'Pendente'}</div>`;
    const dinheiro = (resid||bloq) ? `<div class="money" style="color:var(--dim-2);font-size:12.5px">${bloq?'—':'bloqueado'}</div>` : `<div class="money">${brl(liq(s))}</div>`;
    const animDelay = `animation-delay:${Math.min(shiftIdx++, 8) * 35}ms`;
    return sep + `<div class="shift ${animar?'animate-in':''} ${off?'off':''} ${resid?'resid':''} ${(!off&&s.urgente)?'urgente':''}" data-id="${s.id}" data-date="${s.data}" style="--c:${localCor(s.localId)};${animDelay}">
        <div class="daycol ${s.data===t?'is-today':''}"><div class="d">${d.getDate()}</div><div class="w">${WD[d.getDay()]}</div></div>
        <div class="info">
          <div class="place">${ehBolsa(s)?'':(s.turno==='noturno'?ICON_MOON:ICON_SUN)}<span>${esc(localName(s.localId))}</span>${(s.notas||[]).length?`<span class="note-ind" title="Anotações">📝${s.notas.length}</span>`:''}</div>
          <div class="meta">${metaLinha(s, cid)}</div>
          ${tag}
        </div>
        <div class="right">${dinheiro}${pill}</div>
      </div>`;
  }).join('');
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
          const icone = resid ? '' : (s.turno==='noturno' ? ICON_MOON : ICON_SUN);
          const icos={'ferias':'🏖️','viagem':'✈️','sobreaviso':'📟','compromisso':'📌','outro':'📋'};
          const nomesBloq={ferias:'Férias',viagem:'Viagem',sobreaviso:'Sobreaviso',compromisso:'Compromisso',outro:'Bloqueio'};
          const nome = bloq
            ? `${icos[s.blTipo]||'📋'} ${nomesBloq[s.blTipo]||'Bloqueio'}`
            : esc(localName(s.localId));
          let meta = '';
          if(bolsa) meta = 'Entrada mensal fixa';
          else if(resid) meta = `${s.hora||'--:--'} → ${fim(s.hora,s.duracao)} · ${s.duracao}h · Residência`;
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
          if(resid) tags.push(`<span class="tag">Residência · sem remuneração</span>`);
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

function renderCal(list){
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y,m,1).getDay();
  const dim = new Date(y,m+1,0).getDate();
  const byDay = {};
  list.forEach(s=>{ const k = parseDate(s.data).getDate(); (byDay[k] = byDay[k] || []).push(s); });
  const t = new Date(); const isThis = t.getMonth()===m && t.getFullYear()===y;

  // heatmap: valor por dia
  const valPorDia = {};
  list.filter(counts).forEach(s=>{ const k=parseDate(s.data).getDate(); valPorDia[k]=(valPorDia[k]||0)+liq(s); });
  const maxVal = Math.max(...Object.values(valPorDia), 1);

  // Marcar dias de S.bloqueios (objeto separado dos shifts)
  const bloqDias = new Set();
  const bloqMotivosDia = {};
  S.bloqueios.forEach(b=>{
    if(!b.ini) return;
    const cur = new Date(parseDate(b.ini));
    const fim2 = parseDate(b.fim||b.ini);
    while(cur <= fim2){
      if(cur.getMonth()===m && cur.getFullYear()===y){
        const dd = cur.getDate();
        bloqDias.add(dd);
        bloqMotivosDia[dd] = b.motivo||'ferias';
      }
      cur.setDate(cur.getDate()+1);
    }
  });

  const emojisBloq = {ferias:'🏖️',viagem:'✈️',sobreaviso:'📟',compromisso:'📌',outro:'🔒'};

  let html = '';
  for(let i=0;i<first;i++) html += '<button class="void"></button>';
  for(let d=1;d<=dim;d++){
    const arr = byDay[d] || [];
    const val = valPorDia[d] || 0;
    const alpha = val>0 ? Math.max(0.10, Math.min(0.70, val/maxVal)) : 0;
    const bg = val>0 ? `color-mix(in srgb, var(--accent) ${Math.round(alpha*60)}%, transparent)` : '';
    const temBloq = bloqDias.has(d);
    const bloqBg = temBloq ? 'var(--due-soft)' : '';
    const dotsRes = arr.filter(s=>ehResid(s)).slice(0,2).map(()=>'<i class="oca"></i>').join('');
    const bloqIcon = temBloq ? `<span style="font-size:9px;line-height:1">${emojisBloq[bloqMotivosDia[d]]||'🔒'}</span>` : '';
    // ícone de turno: noturno > diurno (prioridade)
    const plantoesDia = arr.filter(s => counts(s));
    const temNoturno = plantoesDia.some(s => s.turno === 'noturno');
    const temDiurno  = plantoesDia.some(s => s.turno !== 'noturno');
    const turnoIcon  = plantoesDia.length
      ? `<span style="font-size:8px;line-height:1;opacity:.85">${temNoturno ? '🌙' : '☀️'}</span>`
      : '';
    html += `<button data-day="${d}" class="${(arr.length||temBloq)?'has':''} ${isThis&&t.getDate()===d?'today':''}"
      style="${bg?`background:${bg};`:bloqBg?`background:${bloqBg};`:''}">
      <span>${d}</span><span class="dots">${dotsRes}${turnoIcon}${bloqIcon}</span></button>`;
  }
  $('#cal-grid').innerHTML = html;
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

function renderResumo(){
  const periodo = document.querySelector('#res-periodo .on')?.dataset.rp || 'mes';
  const hj = hoje();
  const filtro = s => {
    if(!counts(s)) return false;
    const d = parseDate(s.data);
    if(periodo==='mes')  return d.getMonth()===hj.getMonth() && d.getFullYear()===hj.getFullYear();
    if(periodo==='3m'){  const lim=new Date(hj); lim.setMonth(lim.getMonth()-3); return d>=lim && d<=hj; }
    if(periodo==='ano')  return d.getFullYear()===hj.getFullYear();
    return true;
  };
  const arr = S.shifts.filter(filtro);
  const fat  = arr.reduce((a,s)=>a+liq(s),0);
  const rec  = arr.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0);
  const pend = fat - rec;
  const h    = arr.reduce((a,s)=>a+(+s.duracao||0),0);
  const nomes= {mes:'Este mês','3m':'Últimos 3 meses',ano:'Este ano',tudo:'Todo o período'};
  $('#res-lbl').textContent = 'Resumo · ' + (nomes[periodo]||'');
  $('#res-total').textContent = brl(fat);
  $('#res-sub').textContent = `${arr.length} lançamento${arr.length!==1?'s':''} · ${h}h`;
  $('#res-bar').style.width = (fat ? Math.min(100,rec/fat*100) : 0)+'%';
  $('#res-rec').textContent  = brl(rec);
  $('#res-pend').textContent = brl(pend);

  // por local
  const porLocal = {};
  arr.forEach(s=>{ porLocal[s.localId] = (porLocal[s.localId]||{fat:0,rec:0,n:0}); porLocal[s.localId].fat+=liq(s); porLocal[s.localId].rec+=s.pago?liq(s):0; porLocal[s.localId].n++; });
  const maxFat = Math.max(...Object.values(porLocal).map(x=>x.fat),1);
  $('#res-locais').innerHTML = Object.entries(porLocal).sort((a,b)=>b[1].fat-a[1].fat).map(([lid,d])=>{
    const l = getLocal(lid)||{nome:'Desconhecido',cor:'#ccc'};
    return `<div class="row" style="flex-direction:column;align-items:stretch;padding:12px 0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div class="swatch" style="background:${l.cor}"></div>
        <div class="txt"><b>${esc(l.nome)}</b><small>${d.n} lançamento${d.n!==1?'s':''}</small></div>
        <div class="val">${brl(d.fat)}</div>
      </div>
      <div class="hist-bar"><i style="width:${Math.round(d.fat/maxFat*100)}%;background:var(--accent)"></i></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px">
        <span style="font-size:11.5px;color:var(--dim)">Recebido ${brl(d.rec)}</span>
        <span style="font-size:11.5px;color:var(--dim)">${fat?Math.round(d.fat/fat*100):0}% do total</span>
      </div></div>`;
  }).join('') || '<div class="empty">Nenhum lançamento no período.</div>';

  // ── Ranking R$/h por local ──
  (function(){
    const el = $('#res-rank-hora');
    if(!el) return;
    // só plantões com duração registrada (exclui bolsa/ambulatório sem horas)
    const comHora = arr.filter(s => !ehBolsa(s) && !ehAmb(s) && (+s.duracao||0) > 0);
    if(!comHora.length){ el.innerHTML=''; return; }
    const porLoc = {};
    comHora.forEach(s=>{
      const k = s.localId||'_';
      porLoc[k] = porLoc[k] || { fat:0, h:0, n:0 };
      porLoc[k].fat += liq(s);
      porLoc[k].h   += +s.duracao||0;
      porLoc[k].n++;
    });
    const ranking = Object.entries(porLoc)
      .map(([lid,d]) => ({ lid, ...d, vph: d.h ? Math.round(d.fat/d.h) : 0 }))
      .filter(x => x.vph > 0)
      .sort((a,b) => b.vph - a.vph);
    if(!ranking.length){ el.innerHTML=''; return; }
    const maxVph = ranking[0].vph;
    el.innerHTML = ranking.map((r,i) => {
      const l = getLocal(r.lid)||{nome:'Desconhecido',cor:'#ccc'};
      const medal = i===0 ? '🥇' : i===1 ? '🥈' : i===2 ? '🥉' : `${i+1}º`;
      const pct = Math.round(r.vph/maxVph*100);
      return `<div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
          <div style="font-size:16px;line-height:1;flex:none">${medal}</div>
          <div class="swatch" style="background:${l.cor};flex:none"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.nome)}</div>
            <div style="font-size:11.5px;color:var(--dim)">${r.n} ${r.n!==1?'plantões':'plantão'} · ${r.h}h</div>
          </div>
          <div style="text-align:right;flex:none">
            <div style="font-size:15px;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums">${brl(r.vph)}<span style="font-size:10px;font-weight:500;color:var(--dim)">/h</span></div>
            <div style="font-size:11px;color:var(--dim)">${brl(r.fat)} total</div>
          </div>
        </div>
        <div style="height:4px;background:var(--line);border-radius:99px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${l.cor};border-radius:99px;transition:width .5s cubic-bezier(.4,0,.2,1)"></div>
        </div>
      </div>`;
    }).join('');
  })();

  // por turno — exclui renda fixa (bolsa), que não tem turno real
  const porTurno = {diurno:{fat:0,n:0},noturno:{fat:0,n:0}};
  arr.filter(s=>!ehBolsa(s)).forEach(s=>{ const t=s.turno==='noturno'?'noturno':'diurno'; porTurno[t].fat+=liq(s); porTurno[t].n++; });
  $('#res-turnos').innerHTML = Object.entries(porTurno).filter(([,d])=>d.n>0).map(([t,d])=>`
    <div class="row"><div class="txt"><b>${t==='diurno'?'☀️ Diurno':'🌙 Noturno'}</b><small>${d.n} ${d.n!==1?'plantões':'plantão'}</small></div><div class="val">${brl(d.fat)}</div></div>`).join('') || '<div class="empty">—</div>';

  // gráfico 6 meses (reutilizar chartPanel mas direcionado para res-chart)
  const meses=mesesRetroativos(6);
  const dados=meses.map(m=>{
    const sub=S.shifts.filter(s=>counts(s)&&parseDate(dataCaixa(s)).getMonth()===m.m&&parseDate(dataCaixa(s)).getFullYear()===m.y);
    return{label:m.label,fat:sub.reduce((a,s)=>a+liq(s),0),rec:sub.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0)};
  });
  const maxV=Math.max(...dados.map(d=>d.fat),1);
  const W=320,H=140,pad={t:8,r:12,b:28,l:44};
  const gW=W-pad.l-pad.r,gH=H-pad.t-pad.b;
  const x=i=>pad.l+i*(gW/dados.length)+gW/dados.length/2;
  const y=v=>pad.t+gH*(1-v/maxV);
  const bW=Math.floor(gW/dados.length*0.55);
  let bars='',pts=[],ptsFat=[];
  dados.forEach((d,i)=>{
    bars+=`<rect x="${x(i)-bW/2}" y="${y(d.fat)}" width="${bW}" height="${gH*(d.fat/maxV)}" rx="3" fill="var(--accent)" opacity=".2"/>`;
    bars+=`<rect x="${x(i)-bW/2}" y="${y(d.rec)}" width="${bW}" height="${gH*(d.rec/maxV)}" rx="3" fill="var(--accent)" opacity=".7"/>`;
    pts.push([x(i),y(d.rec)]); ptsFat.push([x(i),y(d.fat)]);
    bars+=`<text x="${x(i)}" y="${H-pad.b+14}" text-anchor="middle" font-size="10" fill="var(--dim)">${d.label}</text>`;
    const ticks=3;
    if(i===0) for(let t=0;t<=ticks;t++){const vv=maxV*t/ticks;const yy=y(vv);bars+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${pad.l-4}" y="${yy+4}" text-anchor="end" font-size="9" fill="var(--dim)">${vv>=1000?(vv/1000).toFixed(0)+'k':Math.round(vv)}</text>`;}
  });
  const linha=(arr,op)=>arr.length<2?'':'<path d="M'+arr.map(p=>p.join(',')).join('L')+'" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" opacity="'+op+'"/>';
  $('#res-chart').innerHTML=`<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}">${bars}${linha(ptsFat,.3)}${linha(pts,1)}${pts.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="var(--accent)"/>`).join('')}</svg><div class="chart-leg"><span><i style="background:var(--accent);opacity:.3"></i>Faturado</span><span><i style="background:var(--accent)"></i>Recebido</span></div></div>`;

  // plantões de colegas
  const colegas = S.shifts.filter(s=>counts(s)&&s.tipo==='peguei').sort((a,b)=>b.data.localeCompare(a.data));
  $('#res-trocas').innerHTML = colegas.length ? colegas.slice(0,8).map(s=>{
    const d=parseDate(s.data);
    return `<div class="row"><div class="txt"><b>${esc(localName(s.localId))}</b><small>${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()} · de ${esc(s.colega||'colega')}</small></div><div class="val">${brl(liq(s))}</div></div>`;
  }).join('') : '<div class="empty">Nenhum plantão de colega no período.</div>';
}
function renderLocais(){
  $('#loc-list').innerHTML = S.locais.length ? S.locais.map(l=>{
    const url = mapsUrl(l);
    const regra = l.pagIncerto
      ? `paga ${PAGMES[typeof l.pagMes==='number'?l.pagMes:1]}, dia a confirmar`
      : `paga dia ${l.pagDia||10} ${PAGMES[typeof l.pagMes==='number'?l.pagMes:1]}`;
    // só mostra valores preenchidos (consultório e renda fixa não têm valor de plantão)
    const sub = [l.cidade, l.vDia ? `dia ${brl(l.vDia)}/12h` : '', l.vNoite ? `noite ${brl(l.vNoite)}/12h` : '', regra].filter(Boolean).join(' · ');
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
  renderTax();
  renderBackupInfo();
}

// bloco "Ano de…" — fica na aba Resumo (antes era desenhado pela função de Ajustes;
// com a renderização só da aba visível, ele ficaria vazio no Resumo)
function renderAno(){
  const y = cursor.getFullYear();
  const ano = S.shifts.filter(s=>counts(s) && parseDate(s.data).getFullYear()===y);
  const tot = ano.reduce((a,s)=>a+liq(s),0);
  const brutoAno = ano.reduce((a,s)=>a+bru(s),0);
  const rec = ano.filter(s=>s.pago).reduce((a,s)=>a+liq(s),0);
  const h = ano.reduce((a,s)=>a+(+s.duracao||0),0);
  const hR = S.shifts.filter(s=>ehResid(s) && parseDate(s.data).getFullYear()===y)
                     .reduce((a,s)=>a+(+s.duracao||0),0);
  $('#yr').textContent = y;
  $('#year-stats').innerHTML = `
    <div class="row"><div class="txt"><b>Faturado</b><small>${ano.filter(s=>!ehBolsa(s)).length} lançamentos · ${h}h</small></div><div class="val">${brl(tot)}</div></div>
    <div class="row"><div class="txt"><b>Recebido</b><small>${tot?Math.round(rec/tot*100):0}% do faturado</small></div><div class="val" style="color:var(--ok)">${brl(rec)}</div></div>
    <div class="row"><div class="txt"><b>A receber</b><small>em aberto</small></div><div class="val" style="color:var(--due)">${brl(tot-rec)}</div></div>
    <div class="row"><div class="txt"><b>Valor médio</b><small>por hora remunerada</small></div><div class="val">${brl(h?tot/h:0)}</div></div>
    ${brutoAno!==tot?`<div class="row"><div class="txt"><b>Retido na fonte</b><small>diferença entre bruto e líquido</small></div><div class="val">${brl(brutoAno-tot)}</div></div>`:''}
    ${hR?`<div class="row"><div class="txt"><b>Residência</b><small>horas de plantão obrigatório</small></div><div class="val">${hR}h</div></div>`:''}`;

  const byLoc = {};
  ano.forEach(s=>{ const k = s.localId||'_'; byLoc[k] = byLoc[k] || {n:0,h:0,v:0}; byLoc[k].n++; byLoc[k].h+=(+s.duracao||0); byLoc[k].v+=liq(s); });  // líquido, como o "Faturado" acima
  const ks = Object.keys(byLoc).sort((a,b)=>byLoc[b].v-byLoc[a].v);
  $('#year-loc').innerHTML = ks.length ? ks.map(k=>`
    <div class="row"><div class="swatch" style="background:${localCor(k)}"></div>
      <div class="txt"><b>${esc(localName(k))}</b><small>${byLoc[k].n} ${byLoc[k].n>1?'lançamentos':'lançamento'} · ${byLoc[k].h}h</small></div>
      <div class="val">${brl(byLoc[k].v)}</div></div>`).join('') : `<div class="empty">Sem dados no ano.</div>`;
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

function renderSemana(){
  const box=$('#week-view');
  if(viewTipo!=='semana'){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#shift-list').classList.add('hidden');
  $('#day-view').classList.add('hidden');
  $$('#filter button').forEach(b=>b.closest('.segs').classList.add('hidden'));

  const dom=domingoSemana(semanaAtual);
  const dias=Array.from({length:7},(_,i)=>{ const d=new Date(dom); d.setDate(d.getDate()+i); return d; });
  const hj=iso(hoje());
  const nomeSemana=`${pad2(dias[0].getDate())}/${pad2(dias[0].getMonth()+1)} – ${pad2(dias[6].getDate())}/${pad2(dias[6].getMonth()+1)}/${dias[6].getFullYear()}`;

  const WD_S=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const slots=[7,12,19]; // turnos visuais: manhã, tarde, noite

  const colunas=dias.map(d=>{
    const isoDia=iso(d);
    const lista=S.shifts.filter(s=>naAgenda(s)&&s.data===isoDia)
                        .sort((a,b)=>(a.hora||'').localeCompare(b.hora||''));
    return {d,isoDia,lista};
  });

  const eventosHTML=(col)=>col.lista.map(s=>{
    const cor=localCor(s.localId);
    const resid=ehResid(s), bolsa=ehBolsa(s), bloq=ehBloq(s);
    const label=bolsa?'Entrada':bloq?'🔒':resid?'Resid.':localName(s.localId).split(' ')[0];
    const bg=resid||bloq?'':cor;
    return `<div class="wg-event ${resid?'resid':''}" style="background:${bg};top:${s.hora?Math.max(0,(parseInt(s.hora)-7)*4)+'px':'4px'};position:relative;margin-bottom:3px" data-id="${s.id}">${label}${s.hora?' '+s.hora:''}</div>`;
  }).join('');

  box.innerHTML=`
    <div class="week-nav">
      <button class="mnav" onclick="semanaAtual.setDate(semanaAtual.getDate()-7);renderSemana()" style="width:33px;height:33px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--dim);cursor:pointer;font-size:15px">‹</button>
      <h3>${nomeSemana}</h3>
      <button class="mnav" onclick="semanaAtual=new Date();renderSemana()" style="border:0;background:var(--accent-soft);color:var(--accent);font-family:inherit;font-size:12.5px;font-weight:600;padding:5px 10px;border-radius:8px;cursor:pointer">Hoje</button>
      <button class="mnav" onclick="semanaAtual.setDate(semanaAtual.getDate()+7);renderSemana()" style="width:33px;height:33px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--dim);cursor:pointer;font-size:15px">›</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:8px">
      ${dias.map((d,i)=>`<div style="text-align:center;font-size:11px;color:${iso(d)===hj?'var(--accent)':'var(--dim)'};font-weight:${iso(d)===hj?'600':'400'}">${WD_S[i]}<br><span style="font-size:15px;font-weight:600;color:${iso(d)===hj?'var(--accent)':'var(--ink)'}">${d.getDate()}</span></div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">
      ${colunas.map(col=>`
        <div class="wg-cell ${col.isoDia===hj?'wg-today':''}" data-day="${col.isoDia}" style="min-height:80px;padding:4px">
          ${eventosHTML(col)}
        </div>`).join('')}
    </div>`;

  // clicar numa célula vazia abre lançamento; clicar num evento edita
  box.querySelectorAll('[data-id]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      openSheet(S.shifts.find(x=>x.id===el.dataset.id));
    });
  });
  box.querySelectorAll('[data-day]').forEach(el=>{
    el.addEventListener('click', ()=> openSheet(null, el.dataset.day));
  });
}

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
  const ult = S.shifts.filter(s => (s.categoria||'remunerado') === cat && getLocal(s.localId))
                      .sort((a,b) => b.data.localeCompare(a.data))[0];
  return ult ? ult.localId : ((S.locais[0]||{}).id || '__new');
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
  _scrollY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_scrollY}px`;
  document.body.style.width = '100%';
}
function unlockScroll(){
  if(!_locked) return;
  _locked = false;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo({top: _scrollY, behavior: 'instant'});
}

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

  // Turno e Duração: ocultar para renda fixa e residência
  $('#f-turno-wrap').classList.toggle('hidden', bolsa || resid);
  // Origem: ocultar para renda fixa e residência
  $('#f-origem-wrap').classList.toggle('hidden', bolsa || resid);
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

  const nomes = { residencia:'compromisso de residência', ambulatorio:'dia de atendimento', remunerado:'plantão', bolsa:'renda fixa' };
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
                   vDia: turno==='diurno'?b:0, vNoite: turno==='noturno'?b:0 };
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
    vProc: parseFloat($('#l-vproc').value)||0
  };
  if(editingLocal) Object.assign(editingLocal, dados);
  else S.locais.push({ id:uid(), ...dados });
  await store.save(S); closeSheets(); render(); toast('Local salvo');
}


/* ── Wrapped: Seu Ano em Números ── */
function renderWrapped(){
  const ano = new Date().getFullYear();
  document.getElementById('wr-ano').textContent = ano + ' em números';
  const MES_SIGLA = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const todos = S.shifts.filter(counts);
  const doAno = todos.filter(s => s.data && s.data.startsWith(String(ano)));

  const totalAno = doAno.reduce((a,s)=>a+liq(s), 0);
  document.getElementById('wr-total').textContent = brl(totalAno);
  const nPl = doAno.length;
  document.getElementById('wr-sub').textContent = nPl > 0
    ? nPl + (nPl>1?' plantões':' plantão') + ' registrado' + (nPl>1?'s':'')
    : 'Nenhum lançamento no ano';

  const horas = doAno.reduce((a,s)=>a+(+s.duracao||0), 0);
  document.getElementById('wr-horas').textContent = horas > 0 ? horas + 'h' : '—';
  document.getElementById('wr-horas-sub').textContent = horas > 0
    ? 'equivale a ' + Math.round(horas/24) + ' dias trabalhados' : '';

  const porLocal = {};
  for(const s of doAno){ const k=s.localId||'outros'; porLocal[k]=(porLocal[k]||0)+liq(s); }
  const topL = Object.entries(porLocal).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('wr-top-local').textContent = topL ? localName(topL[0]) : '—';
  document.getElementById('wr-top-local-sub').textContent = topL ? brl(topL[1]) + ' recebidos' : '';

  const porMes = {};
  for(const s of doAno){ if(!s.data) continue; const m=s.data.slice(0,7); porMes[m]=(porMes[m]||0)+liq(s); }
  const topM = Object.entries(porMes).sort((a,b)=>b[1]-a[1])[0];
  if(topM){
    const [y,mm] = topM[0].split('-');
    document.getElementById('wr-mes-top').textContent = MES_SIGLA[parseInt(mm)-1] + ' ' + y;
    document.getElementById('wr-mes-top-sub').textContent = brl(topM[1]) + ' neste mês';
  } else { document.getElementById('wr-mes-top').textContent = '—'; document.getElementById('wr-mes-top-sub').textContent=''; }

  document.getElementById('wr-qtd').textContent = nPl > 0 ? nPl : '—';
  const pagosPct = nPl > 0 ? Math.round(doAno.filter(s=>s.pago).length/nPl*100) : 0;
  document.getElementById('wr-qtd-sub').textContent = nPl > 0 ? pagosPct + '% já recebidos' : '';

  const ticket = nPl > 0 ? Math.round(totalAno / nPl) : 0;
  document.getElementById('wr-ticket').textContent = ticket > 0 ? brl(ticket) : '—';
  document.getElementById('wr-ticket-sub').textContent = ticket > 0 ? 'valor líquido médio por plantão' : '';
}

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

/* ── Gera canvas do resumo anual ── */
/* icone: Image() com crossOrigin=anonymous carregada antes — null usa fallback desenhado */
function gerarCanvasAno(ano, total, horas, n, ticket, totalRendaFixa, icone){
  const W=1080, H=1350;
  const cvs = document.createElement('canvas');
  cvs.width=W; cvs.height=H;
  const ctx = cvs.getContext('2d');

  // ── Fundo gradiente escuro profundo ──
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'#0D0B1C'); grad.addColorStop(0.45,'#150F38'); grad.addColorStop(1,'#0A0818');
  ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);

  // Malha de pontos sutil
  ctx.fillStyle='rgba(255,255,255,0.022)';
  for(let x=36;x<W;x+=36) for(let y=36;y<H;y+=36){
    ctx.beginPath(); ctx.arc(x,y,1.4,0,Math.PI*2); ctx.fill();
  }

  // Glow radial central (atrás dos números)
  const rg = ctx.createRadialGradient(W/2,500,0,W/2,500,420);
  rg.addColorStop(0,'rgba(120,80,255,0.16)'); rg.addColorStop(1,'rgba(120,80,255,0)');
  ctx.fillStyle=rg; ctx.fillRect(0,180,W,680);

  // ── CABEÇALHO: ícone + "Plantaê!" ──
  ctx.save();
  const icoSz=120, icoX=W/2-230, icoY=90;
  if(icone){
    // Ícone real com máscara circular
    ctx.save();
    ctx.beginPath(); ctx.arc(icoX+icoSz/2, icoY+icoSz/2, icoSz/2, 0, Math.PI*2);
    ctx.clip();
    ctx.drawImage(icone, icoX, icoY, icoSz, icoSz);
    ctx.restore();
  } else {
    // Fallback: folha desenhada
    const lx=icoX, ly=icoY;
    ctx.strokeStyle='rgba(140,200,90,0.85)'; ctx.lineWidth=8; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(lx+50,ly+110); ctx.lineTo(lx+50,ly+30); ctx.stroke();
    ctx.fillStyle='rgba(110,200,80,0.9)';
    ctx.beginPath();
    ctx.moveTo(lx+50,ly+30);
    ctx.bezierCurveTo(lx+80,ly-10,lx+110,ly+20,lx+90,ly+70);
    ctx.bezierCurveTo(lx+70,ly+95,lx+50,ly+90,lx+50,ly+30);
    ctx.fill();
    ctx.fillStyle='rgba(80,170,60,0.75)';
    ctx.beginPath();
    ctx.moveTo(lx+50,ly+55);
    ctx.bezierCurveTo(lx+20,ly+20,lx-8,ly+42,lx+18,ly+82);
    ctx.bezierCurveTo(lx+34,ly+95,lx+50,ly+85,lx+50,ly+55);
    ctx.fill();
  }
  ctx.restore();

  // "Plantaê!" wordmark
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillStyle='#FFFFFF';
  ctx.font='800 108px system-ui,-apple-system,sans-serif';
  ctx.fillText('Plantaê!', W/2-160, 150);

  // Linha accent abaixo do wordmark
  const ulX=W/2-160;
  const ulG=ctx.createLinearGradient(ulX,0,ulX+450,0);
  ulG.addColorStop(0,'rgba(130,100,255,0.95)');
  ulG.addColorStop(0.65,'rgba(170,145,255,0.4)');
  ulG.addColorStop(1,'rgba(170,145,255,0)');
  ctx.fillStyle=ulG; ctx.fillRect(ulX,208,450,5);

  // Subtítulo
  ctx.fillStyle='rgba(255,255,255,0.42)';
  ctx.font='400 28px system-ui,-apple-system,sans-serif';
  ctx.fillText('Seu ano em números · '+ano, W/2-160, 248);

  // Linha divisória
  ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.fillRect(60,284,W-120,1);

  // ── TOTAL ──
  const totalStr=brl(total);
  const fs=totalStr.length>14?72:totalStr.length>11?86:100;
  ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  ctx.fillStyle='#FFFFFF';
  ctx.font='800 '+fs+'px system-ui,-apple-system,sans-serif';
  ctx.fillText(totalStr, W/2, 396);
  ctx.fillStyle='rgba(255,255,255,0.38)';
  ctx.font='400 28px system-ui,-apple-system,sans-serif';
  ctx.fillText('receita bruta de plantões · '+ano, W/2, 440);

  // ── CARDS MÉTRICAS ──
  const cards=[
    {ico:'⏱',lbl:'HORAS TRABALHADAS',  val:horas>0?horas+'h':'—', sub:horas>0?'equivale a '+Math.round(horas/24)+' dia'+(Math.round(horas/24)!==1?'s':''):''},
    {ico:'🏥',lbl:'PLANTÕES REALIZADOS',val:n>0?String(n):'—',     sub:n>0?(n>1?'plantões':'plantão')+' no ano':''},
    {ico:'💰',lbl:'TICKET MÉDIO',       val:ticket>0?brl(ticket):'—',sub:ticket>0?'valor líquido médio':''},
  ];
  const cH=160, cW=W-80, cX=40;
  cards.forEach((c,i)=>{
    const cy=476+i*(cH+18);
    // Fundo do card
    ctx.fillStyle='rgba(255,255,255,0.05)';
    roundRect(ctx,cX,cy,cW,cH,22); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.09)'; ctx.lineWidth=1.5;
    roundRect(ctx,cX,cy,cW,cH,22); ctx.stroke();
    // Emoji
    ctx.font='44px system-ui,sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillStyle='rgba(255,255,255,0.88)'; ctx.fillText(c.ico,cX+26,cy+cH/2);
    // Label
    ctx.fillStyle='rgba(255,255,255,0.36)';
    ctx.font='600 19px system-ui,-apple-system,sans-serif';
    ctx.fillText(c.lbl,cX+96,cy+42);
    // Valor
    ctx.fillStyle='#FFFFFF';
    ctx.font='700 42px system-ui,-apple-system,sans-serif';
    ctx.fillText(c.val,cX+96,cy+98);
    // Sub
    if(c.sub){
      ctx.fillStyle='rgba(255,255,255,0.36)';
      ctx.font='400 20px system-ui,-apple-system,sans-serif';
      ctx.fillText(c.sub,cX+96,cy+130);
    }
  });

  // ── RENDA FIXA (se houver) ──
  if(totalRendaFixa>0){
    const rfY=476+3*(cH+18)+10;
    ctx.fillStyle='rgba(130,100,255,0.10)';
    roundRect(ctx,40,rfY,W-80,76,16); ctx.fill();
    ctx.strokeStyle='rgba(130,100,255,0.30)'; ctx.lineWidth=1.5;
    roundRect(ctx,40,rfY,W-80,76,16); ctx.stroke();
    ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.fillStyle='rgba(255,255,255,0.42)';
    ctx.font='500 20px system-ui,-apple-system,sans-serif';
    ctx.fillText('🏦  Bolsa-Residência + Auxílio-Moradia', 68, rfY+26);
    ctx.fillStyle='rgba(170,148,255,0.95)';
    ctx.font='700 32px system-ui,-apple-system,sans-serif';
    ctx.fillText(brl(totalRendaFixa), 68, rfY+56);
  }

  // ── RODAPÉ ──
  const wg=ctx.createLinearGradient(0,H-120,0,H);
  wg.addColorStop(0,'rgba(0,0,0,0)'); wg.addColorStop(1,'rgba(0,0,0,0.6)');
  ctx.fillStyle=wg; ctx.fillRect(0,H-120,W,120);
  ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.fillRect(0,H-80,W,1);
  ctx.fillStyle='rgba(255,255,255,0.52)';
  ctx.font='700 26px system-ui,-apple-system,sans-serif'; ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  ctx.fillText('Plantaê!', 48, H-42);
  ctx.fillStyle='rgba(255,255,255,0.26)';
  ctx.font='400 20px system-ui,-apple-system,sans-serif';
  ctx.fillText('plantoes-asevedo.vercel.app', 48, H-16);

  // Marca d'água: ícone pequeno no canto inferior direito
  const wmSz=64, wmX=W-wmSz-44, wmY=H-wmSz-22;
  if(icone){
    ctx.save();
    ctx.globalAlpha=0.72;
    ctx.beginPath(); ctx.arc(wmX+wmSz/2, wmY+wmSz/2, wmSz/2, 0, Math.PI*2);
    ctx.clip();
    ctx.drawImage(icone, wmX, wmY, wmSz, wmSz);
    ctx.restore();
  } else {
    // Fallback: folha mini
    ctx.save(); ctx.globalAlpha=0.55;
    ctx.translate(wmX+wmSz/2, wmY+wmSz/2);
    ctx.fillStyle='rgba(140,200,90,0.9)';
    ctx.beginPath(); ctx.ellipse(0,-4,13,20,0.2,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  return cvs;
}

/* ── Overlay para mostrar imagem no iOS PWA (window.open bloqueado) ── */
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
  btn.onclick = ()=>ov.remove();

  ov.appendChild(img);
  ov.appendChild(hint);
  ov.appendChild(btn);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  document.body.appendChild(ov);
}

/* ── Compartilha o resumo anual ── */
function compartilharAno(){
  const ano = new Date().getFullYear();
  const doAno = S.shifts.filter(counts).filter(s=>s.data&&s.data.startsWith(String(ano)));
  const total = doAno.reduce((a,s)=>a+liq(s),0);
  const horas = doAno.reduce((a,s)=>a+(+s.duracao||0),0);
  const n = doAno.length;
  const ticket = n > 0 ? Math.round(total/n) : 0;
  const rendaFixaAno = S.shifts.filter(ehBolsa).filter(s=>s.data&&s.data.startsWith(String(ano)));
  const totalRendaFixa = rendaFixaAno.reduce((a,s)=>a+(s.liquido||s.valor||0),0);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);

  function gerarECompartilhar(icone){
    let dataUrl;
    try {
      const cvs = gerarCanvasAno(ano, total, horas, n, ticket, totalRendaFixa, icone);
      dataUrl = cvs.toDataURL('image/png');
    } catch(e){
      toast('Erro ao gerar imagem: ' + e.message);
      return;
    }
    if(isIOS){
      mostrarImagemOverlay(dataUrl, ano);
      return;
    }
    const byteStr=atob(dataUrl.split(',')[1]);
    const ab=new Uint8Array(byteStr.length);
    for(let i=0;i<byteStr.length;i++) ab[i]=byteStr.charCodeAt(i);
    const blob=new Blob([ab],{type:'image/png'});
    const file=new File([blob],'plantae-'+ano+'.png',{type:'image/png'});
    if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){
      navigator.share({files:[file],title:'Plantaê! '+ano}).catch(err=>{
        if(err?.name==='AbortError') return;
        const a=document.createElement('a');a.href=dataUrl;a.download='plantae-'+ano+'.png';
        document.body.appendChild(a);a.click();document.body.removeChild(a);
      });
    } else {
      const a=document.createElement('a');a.href=dataUrl;a.download='plantae-'+ano+'.png';
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      toast('Imagem salva ✓');
    }
  }

  // Carrega o ícone com crossOrigin=anonymous para não contaminar o canvas
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => gerarECompartilhar(img);
  img.onerror = () => gerarECompartilhar(null); // fallback sem ícone
  img.src = './icon-512.png?' + Date.now(); // cache-bust garante que o header CORS seja aplicado
}

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
    <button id="fab-b"  style="${itemStyle}">🔒 <span>Bloqueio de agenda</span></button>`;
  menu.style.animation = 'fabIn .18s cubic-bezier(.32,.72,0,1)';
  document.body.appendChild(menu);
  haptic(6);
  // um único listener, sempre removido — antes ficava pendurado quando se escolhia um item
  function fechar(){ menu.remove(); document.removeEventListener('click', fora, true); }
  function fora(e){ if(!menu.contains(e.target) && !e.target.closest('#fab, #add-top')) fechar(); }
  setTimeout(()=>document.addEventListener('click', fora, true), 0);
  menu.querySelector('#fab-p') .onclick = ()=>{ fechar(); openSheet(null, null, 'remunerado'); };
  menu.querySelector('#fab-am').onclick = ()=>{ fechar(); openSheet(null, null, 'ambulatorio'); };
  menu.querySelector('#fab-b') .onclick = ()=>{ fechar(); openBloqueio(null); };
  menu.querySelectorAll('[data-fab-mod]').forEach(b=> b.onclick = ()=>{
    fechar(); openSheet(null, iso(new Date()), freq[+b.dataset.fabMod].categoria); aplicarModelo(freq[+b.dataset.fabMod]);
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
    if(box.id==='f-turno') autoValor();
    if(box.id==='l-pagmes') return;
    if(box.id==='f-dur'){ $('#f-durc-wrap').classList.toggle('hidden', chip.dataset.v!=='custom'); autoValor(); }
    if(box.id==='f-tipo'){ $('#troca-wrap').classList.toggle('hidden', chip.dataset.v==='meu'); contraHint(); }
    if(box.id==='f-contra') contraHint();
    return;
  }
  const tog = e.target.closest('.toggle');
  if(tog){
    tog.classList.toggle('on');
    if(tog.id.startsWith('av-')){
      const p = avisoPrefs(); p[tog.id.slice(3)] = tog.classList.contains('on');
      lsSet('plantoes:avisos', JSON.stringify(p));
      if(p[tog.id.slice(3)] && !notifAtiva()) pedirPermissaoNotif();
      agendarNotificacoes(); renderAvisosUI();
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

$('#f-local').onchange = ()=>{ $('#f-newlocal-wrap').classList.toggle('hidden', $('#f-local').value!=='__new'); autoValor(); atualizarVenc(); };
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
  if(pay){
    e.stopPropagation();
    const s = S.shifts.find(x=>x.id===pay.dataset.pay);
    if(!s) return;
    s.pago = !s.pago;
    haptic(s.pago ? 12 : 6);
    s.pagoEm = s.pago ? (s.pagoEm || iso(new Date())) : '';
    await store.save(S); render();
    if(s.pago){ confettiPay(liq(s)); toast('💰 '+brl(liq(s))+' confirmado'); }
    else { toast('Desmarcado'); }
    return;
  }
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
  haptic(5);
  const btnBl = e.target.closest('button[data-day]');
  if(btnBl){
    const dBl = +btnBl.dataset.day;
    const dStr = iso(new Date(cursor.getFullYear(), cursor.getMonth(), dBl));
    const blEncontrado = S.bloqueios.find(b=>dStr>=b.ini && dStr<=(b.fim||b.ini));
    if(blEncontrado){ openBloqueio(blEncontrado); return; }
  }
  const b = e.target.closest('[data-day]'); if(!b) return;
  const d = new Date(cursor.getFullYear(), cursor.getMonth(), +b.dataset.day);
  if(viewTipo === 'dia'){
    diaAtual = new Date(d); renderDia();
  } else {
    const alvo = document.querySelector(`.shift[data-date="${iso(d)}"]`);
    if(alvo){
      alvo.scrollIntoView({behavior:'smooth',block:'center'});
      alvo.classList.add('flash'); setTimeout(()=>alvo.classList.remove('flash'),1400);
    }else openSheet(null, iso(d));
  }
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
$('#file').onchange = e=>{
  const f = e.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = async ()=>{
    try{
      const d = JSON.parse(r.result);
      if(!Array.isArray(d.shifts)) throw 0;
      S = normalize(d); // inclui bloqueios e metas do backup
      await store.save(S); render(); toast('Backup restaurado');
    }catch(err){ toast('Arquivo inválido'); }
  };
  r.readAsText(f); e.target.value = '';
};

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
    <div class="wl-alt"><button id="wl-restore">Tenho um backup</button><button id="wl-skip">Explorar primeiro</button></div>
  </div>`;
  document.body.appendChild(ov);
  lockScroll();
  const fechar = ()=>{ lsSet('plantoes:boasVindas','1'); ov.classList.add('out'); setTimeout(()=>ov.remove(), 300); unlockScroll(); };
  ov.querySelector('#wl-skip').onclick = fechar;
  ov.querySelector('#wl-restore').onclick = ()=>{ fechar(); $('#file').click(); };
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
  { id:'',          nome:'Clássico',     desc:'Índigo original',                 sw:['#F8F9FA','#6366F1','#059669','#D97706'], bg:['#F8F9FA','#09090B'] },
  { id:'diaenoite', nome:'Dia e Noite',  desc:'Âmbar de dia, índigo à noite',    sw:['#FAF8F5','#D97706','#4F46E5','#0284C7'], bg:['#FAF8F5','#0F1115'] },
  { id:'cirurgico', nome:'Cirúrgico',    desc:'Verde-azulado sobre grafite',     sw:['#F3F7F7','#0D9488','#0E1B1D','#15803D'], bg:['#F3F7F7','#0A1213'] },
  { id:'fintech',   nome:'Fintech',      desc:'Preto, branco e verde-limão',     sw:['#F5F5F2','#0A0A0A','#C6F432','#3F7D0B'], bg:['#F5F5F2','#0A0A0A'] },
];
function aplicarPaleta(){
  const id = lsGet('plantoes:paleta'), r = document.documentElement;
  if(id) r.dataset.paleta = id; else delete r.dataset.paleta;
  const h = new Date().getHours();
  r.dataset.fase = (h >= 6 && h < 18) ? 'dia' : 'noite';
  // cor da barra de status acompanha o fundo da paleta
  const pal = PALETAS.find(p => p.id === id) || PALETAS[0];
  THEME_META.forEach(par => {
    const escuro = (par[0].getAttribute('media')||'').includes('dark');
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

/* ================= faixa da semana =================
   Substitui o mês inteiro na tela inicial; "Ver mês" abre a grade completa.
   Pontos: cheio = diurno, vazado = noturno, quadrado = bloqueio.          */
let wkRef = null, wkKey = '';
function renderWeekStrip(){
  const box = $('#wk-days'); if(!box) return;
  const hj = hoje(), key = cursor.getFullYear()+'-'+cursor.getMonth();
  if(!wkRef || key !== wkKey){
    wkKey = key;
    wkRef = sameMonth(iso(hj), cursor) ? new Date(hj) : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  }
  const dom = domingoSemana(wkRef);
  const dias = Array.from({length:7}, (_,i)=>{ const d = new Date(dom); d.setDate(d.getDate()+i); return d; });
  const temHoje = dias.some(d => iso(d) === iso(hj));
  $('#wk-title').textContent = temHoje ? 'Esta semana'
    : `${pad2(dias[0].getDate())}/${pad2(dias[0].getMonth()+1)} – ${pad2(dias[6].getDate())}/${pad2(dias[6].getMonth()+1)}`;
  box.innerHTML = dias.map(d => {
    const ds = iso(d);
    const sh = S.shifts.filter(s => s.data === ds && naAgenda(s) && !ehBloq(s)).slice(0,3);
    const bl = S.bloqueios.some(b => ds >= b.ini && ds <= (b.fim||b.ini));
    const dots = sh.map(s => `<i class="${s.turno==='noturno'?'noite':''}" style="--c:${localCor(s.localId)}"></i>`).join('') + (bl ? '<i class="bl"></i>' : '');
    return `<button class="wkd ${ds===iso(hj)?'hoje':''} ${d.getMonth()!==cursor.getMonth()?'fora':''}" data-wk="${ds}" aria-label="${WD_LONG[d.getDay()]} ${d.getDate()}">
      <span class="wkd-w">${WD[d.getDay()]}</span><span class="wkd-n">${d.getDate()}</span><span class="wkd-dots">${dots}</span></button>`;
  }).join('');
  const aberto = lsGet('plantoes:calMes') === '1';
  $('#cal-mes').classList.toggle('hidden', !aberto);
  $('#cal-toggle').textContent = aberto ? 'Ocultar mês' : 'Ver mês';
  $('#cal-toggle').setAttribute('aria-expanded', aberto);
}
// tocar num dia: mesmo comportamento da grade do mês (vai até o plantão ou lança)
function irParaDia(ds){
  const d = parseDate(ds);
  const bl = S.bloqueios.find(b => ds >= b.ini && ds <= (b.fim||b.ini));
  if(bl && !S.shifts.some(s => s.data === ds && naAgenda(s))){ openBloqueio(bl); return; }
  if(!sameMonth(ds, cursor)){ cursor = new Date(d.getFullYear(), d.getMonth(), 1); wkKey = cursor.getFullYear()+'-'+cursor.getMonth(); wkRef = d; render(); }
  if(viewTipo === 'dia'){ diaAtual = new Date(d); renderDia(); return; }
  if(viewTipo === 'semana'){ semanaAtual = new Date(d); renderSemana(); $('#week-view').scrollIntoView({behavior:'smooth', block:'start'}); return; }
  const alvo = document.querySelector(`.shift[data-date="${ds}"]`);
  if(alvo){ alvo.scrollIntoView({behavior:'smooth', block:'center'}); alvo.classList.add('flash'); setTimeout(()=>alvo.classList.remove('flash'), 1400); }
  else openSheet(null, ds);
}
$('#wk').addEventListener('click', e=>{
  const d = e.target.closest('[data-wk]'); if(d){ haptic(5); irParaDia(d.dataset.wk); return; }
  if(e.target.closest('#wk-prev')){ wkRef.setDate(wkRef.getDate()-7); renderWeekStrip(); return; }
  if(e.target.closest('#wk-next')){ wkRef.setDate(wkRef.getDate()+7); renderWeekStrip(); return; }
  if(e.target.closest('#cal-toggle')){ lsSet('plantoes:calMes', lsGet('plantoes:calMes') === '1' ? '' : '1'); renderWeekStrip(); haptic(5); }
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
  aplicarCategoria();
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
const AVISO_DEF = { inicio:true, fim:true, vespera:false };
const AVISO_INI_MS = 60*60000, AVISO_FIM_MS = 30*60000, AVISO_ATRASO_MS = 10*60000;
let _avisoTimers = [];

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
    const tipo = ehResid(s) ? 'Residência' : ehAmb(s) ? 'Consultório' : 'Plantão';
    if(p.inicio) out.push({ at: j.ini - AVISO_INI_MS, tag:`ini:${s.id}:${j.ini}`,
      title:`${tipo} em 1 hora`, body:`${nome} · ${hIni} → ${hFim} · ${s.duracao}h${onde}` });
    if(p.fim) out.push({ at: j.fim - AVISO_FIM_MS, tag:`fim:${s.id}:${j.fim}`,
      title:`${tipo} termina em 30 min`, body:`${nome} · até ${hFim}${counts(s) && liq(s) ? ' · '+brl(liq(s))+' a receber' : ''}` });
    if(p.vespera){
      const v = new Date(j.ini); v.setDate(v.getDate()-1); v.setHours(20,0,0,0);
      if(v.getTime() < j.ini - AVISO_INI_MS) out.push({ at: v.getTime(), tag:`vesp:${s.id}:${j.ini}`,
        title:`${tipo} amanhã`, body:`${nome} · ${hIni} · ${s.duracao}h${onde}` });
    }
  }
  return out.filter(a => a.at > now - AVISO_ATRASO_MS && a.at <= now + horizonte).sort((a,b)=>a.at - b.at);
}

async function mostrarNotificacao(title, opts){
  const o = { icon:'./icon-192.png', badge:'./icon-192.png', ...opts };
  try{
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if(reg && reg.showNotification){ await reg.showNotification(title, o); return true; }
  }catch(e){}
  try{ new Notification(title, o); return true; }catch(e){ return false; }
}

async function dispararAviso(a){
  if(avisosVistos().includes(a.tag) || !notifAtiva()) return;
  marcarAvisoVisto(a.tag);
  await mostrarNotificacao(a.title, { body:a.body, tag:a.tag, data:{ url:'./' } });
  if(!document.hidden) toast('🔔 ' + a.title);   // com o app em primeiro plano o iPhone pode não exibir o banner
}

// recria todos os timers — chamado a cada render e ao voltar para o app
function agendarNotificacoes(){
  _avisoTimers.forEach(clearTimeout); _avisoTimers = [];
  if(!notifAtiva()) return;
  const now = Date.now(), vistos = new Set(avisosVistos());
  for(const a of avisosPendentes(now)){
    if(vistos.has(a.tag)) continue;
    const ms = a.at - now;
    if(ms <= 0) dispararAviso(a);                       // perdido há pouco (app estava fechado)
    else _avisoTimers.push(setTimeout(()=>dispararAviso(a), ms));
  }
}
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) agendarNotificacoes(); });

async function pedirPermissaoNotif(){
  if(!notifSuportada()){
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    toast(ios ? 'No iPhone, instale o app na Tela de Início para ativar os avisos' : 'Este navegador não suporta notificações');
    return false;
  }
  if(Notification.permission === 'denied'){ toast('Avisos bloqueados — libere em Ajustes do iPhone → Notificações → Plantaê!'); renderAvisosUI(); return false; }
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
  ['inicio','fim','vespera'].forEach(k => $('#av-'+k).classList.toggle('on', !!p[k]));
  let txt, cor = '';
  if(!notifSuportada()){
    txt = /iP(hone|ad|od)/.test(navigator.userAgent)
      ? 'Instale o app na Tela de Início (Safari → Compartilhar → Adicionar à Tela de Início) para ativar'
      : 'Não suportado neste navegador';
    btn.classList.add('hidden');
  } else if(Notification.permission === 'denied'){
    txt = 'Bloqueados — libere em Ajustes do iPhone → Notificações'; cor = 'var(--due)';
    btn.classList.add('hidden');
  } else if(Notification.permission !== 'granted'){
    txt = 'Desativados'; btn.classList.remove('hidden'); btn.textContent = 'Ativar';
  } else {
    const prox = avisosPendentes().find(a => a.at > Date.now() && !avisosVistos().includes(a.tag));
    if(prox){
      const d = new Date(prox.at);
      txt = `Próximo: ${quandoDia(prox.at)} às ${pad2(d.getHours())}:${pad2(d.getMinutes())} — ${prox.title.toLowerCase()}`;
    } else txt = (p.inicio || p.fim || p.vespera) ? 'Ativados · nenhum plantão nos próximos dias' : 'Ativados, mas todos os tipos estão desligados';
    cor = 'var(--ok)';
    btn.classList.add('hidden');
  }
  st.textContent = txt; st.style.color = cor;
}

$('#btn-notif-teste').onclick = async ()=>{
  if(!notifAtiva() && !(await pedirPermissaoNotif())) return;
  const ok = await mostrarNotificacao('Plantaê! 🔔', { body:'Os avisos estão funcionando neste aparelho.', tag:'teste-'+Date.now() });
  toast(ok ? 'Aviso de teste enviado' : 'Não consegui mostrar o aviso');
};

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
  const tipo = ehResid(s) ? 'Residência' : ehAmb(s) ? 'Consultório' : (s.turno === 'noturno' ? 'Noturno' : 'Diurno');
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
function normalize(d){
  // ...l / ...d preservam campos que antes eram descartados a cada recarga
  // (vPart/vPlano/vProc do local; metaMensal, metaAnual, metaObjetivo, limiarHoras do app)
  const locais = (d.locais||[]).map((l,i)=>({
    ...l,
    id:l.id, nome:l.nome, cidade:l.cidade||'', endereco:l.endereco||'',
    cor:l.cor||CORES[i%CORES.length], vDia:l.vDia||0, vNoite:l.vNoite||0,
    pagDia: l.pagDia || 10,
    pagMes: typeof l.pagMes === 'number' ? l.pagMes : 1,
    pagIncerto: !!l.pagIncerto,
    retencao: +l.retencao || 0
  }));
  // migrar bloqueios antigos de shifts para S.bloqueios
  const bloqueiosAntigos = (d.shifts||[]).filter(s=>s.categoria==='bloqueio').map(s=>({
    id: s.id || uid(), motivo: s.blTipo||'ferias', ini: s.data, fim: s.blFim||s.data, obs: s.obs||''
  }));
  const bloqueios = [...(d.bloqueios||[]), ...bloqueiosAntigos]
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
(async function init(){
  const saved = await store.load();
  if(saved && Array.isArray(saved.shifts)) S = normalize(saved);
  // preferência de saldo oculto sobrevive ao fechar o app
  try{ if(localStorage.getItem('plantoes:oculto')){ saldoOculto = true; } }catch(e){}
  render();
  if(saldoOculto) aplicarOcultar();
  boasVindas();
  // pede ao navegador para não apagar os dados por falta de espaço/uso (iOS/Chrome)
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
  // dismiss splash screen — usa RAF para garantir que o elemento existe no DOM
  function dismissSplash(){
    const splash = document.getElementById('splash');
    if(!splash) return;
    setTimeout(()=>{
      splash.classList.add('out');
      setTimeout(()=>{ if(splash.parentNode) splash.parentNode.removeChild(splash); }, 380);
    }, 820);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', dismissSplash, {once:true});
  } else {
    dismissSplash();
  }
  // Safari fora do modo app não expõe Notification — antes isso lançava erro e
  // interrompia o init (atalhos ?action=novo / proximo não funcionavam)
  if('Notification' in window && Notification.permission==='granted') agendarNotificacoes();
  // App Shortcuts: tratar URL params
  const params=new URLSearchParams(location.search);
  if(params.get('action')==='novo') setTimeout(()=>openSheet(null),300);
  if(params.get('action')==='proximo'){
    const nx=S.shifts.filter(s=>naAgenda(s)&&s.data>=iso(hoje())).sort((a,b)=>a.data.localeCompare(b.data))[0];
    if(nx) setTimeout(()=>openSheet(nx),300);
  }
})();
