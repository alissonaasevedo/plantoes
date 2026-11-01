"""Avisos com botões (Android): Recebi no dia do pagamento, Anotar perto do fim, Como chegar."""
import json

from conftest import passo, js, rodar, salvo, quando
from test_push import SW_FALSO, servidor, sincroniza

PAGAR = """const l = S.locais.find(x=>/São Benedito/i.test(x.nome)) || S.locais[0];
  S.shifts.push({id:'P1',categoria:'remunerado',data:'2026-09-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
    valor:1350,liquido:1350,pago:false,pagoEm:'',venc:'2026-10-21',tipo:'meu',colega:'',contra:'',quitado:false,obs:''});
  S.shifts.push({id:'P2',categoria:'remunerado',data:'2026-09-27',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
    valor:1350,liquido:1350,pago:false,pagoEm:'',venc:'2026-10-21',tipo:'meu',colega:'',contra:'',quitado:false,obs:''});
  await store.save(S); render();"""


def test_aviso_de_pagamento_agrupa_por_local_e_dia(abrir):
    pg = abrir()
    rodar(pg, PAGAR)
    pags = js(pg, "avisosPendentes(Date.now()).filter(a=>a.tag.startsWith('pag:') && a.acoes[0].url.includes('P1'))")
    assert len(pags) == 1
    a = pags[0]
    assert a['title'] == 'Pagamento previsto hoje' and '2 plantões' in a['body'] and '2.700' in a['body']
    assert js(pg, f"new Date({a['at']}).getHours()") == 10 and js(pg, f"iso(new Date({a['at']}))") == '2026-10-21'
    assert a['acoes'][0]['acao'] == 'recebi' and 'ids=P1,P2' in a['acoes'][0]['url']
    # pago ou desligado: sem aviso
    rodar(pg, "S.shifts.find(s=>s.id==='P1').pago = true; S.shifts.find(s=>s.id==='P2').pago = true;")
    assert js(pg, "avisosPendentes(Date.now()).filter(a=>a.tag.includes('2026-10-21')).length") == 0


def test_botao_recebi_da_baixa_com_desfazer(abrir):
    pg = abrir()
    rodar(pg, PAGAR)
    rodar(pg, "tratarAcao(new URLSearchParams('action=recebi&ids=P1,P2'))"); passo(pg, 300)
    s = {x['id']: x for x in salvo(pg)['shifts']}
    assert s['P1']['pago'] and s['P2']['pago'] and s['P1']['pagoEm'] == '2026-10-19'
    assert 'recebido' in pg.inner_text('#toast')
    pg.click('.toast-act'); passo(pg, 300)
    assert not js(pg, "S.shifts.find(s=>s.id==='P1').pago")
    rodar(pg, "S.shifts.find(s=>s.id==='P1').pago = true; S.shifts.find(s=>s.id==='P2').pago = true; tratarAcao(new URLSearchParams('action=recebi&ids=P1'))"); passo(pg, 200)
    assert 'Já estava' in pg.inner_text('#toast')


def test_recebi_pelo_endereco_ao_abrir_o_app(abrir):
    from conftest import BACKUP
    pendente = next(s for s in BACKUP['shifts'] if s.get('categoria') == 'remunerado' and not s.get('pago') and s.get('valor'))
    pg = abrir(query=f"?action=recebi&ids={pendente['id']}")
    passo(pg, 500)
    assert js(pg, f"S.shifts.find(s=>s.id==={json.dumps(pendente['id'])}).pago") is True
    assert 'action=' not in pg.url


def test_aviso_local_leva_os_botoes(abrir):
    pg = abrir(notificacoes=True)
    rodar(pg, """window.__o = null;
        Object.defineProperty(navigator, 'serviceWorker', { configurable:true, value: {
          getRegistration: async () => ({ showNotification: async (t, o) => { window.__o = o; } }), addEventListener(){} } });""")
    rodar(pg, "await dispararAviso({ tag:'fim:ABC:1', sid:'ABC', title:'Plantão termina em 30 min', body:'x', url:'./?action=plantao&id=ABC', acoes:[{acao:'anotar',titulo:'Anotar',url:'./?action=anotar&id=ABC'},{acao:'ver',titulo:'Ver plantão',url:'./?action=plantao&id=ABC'}] })")
    o = js(pg, "__o")
    assert [x['action'] for x in o['actions']] == ['anotar', 'ver']
    assert o['data']['acoes'][0]['url'] == './?action=anotar&id=ABC'


def test_sem_service_worker_o_aviso_sai_sem_botoes(abrir):
    pg = abrir(notificacoes=True)
    rodar(pg, """window.__n = null; Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration: async()=>null, addEventListener(){}}});
        window.Notification = function(t, o){ if(o.actions) throw new TypeError('Actions are only supported for persistent notifications'); window.__n = o; };
        Object.defineProperty(Notification,'permission',{get:()=>'granted'});""")
    assert js(pg, "1") == 1
    rodar(pg, "window.__ok = await mostrarNotificacao('t', { body:'b', actions:[{action:'ver', title:'Ver'}] })")
    assert js(pg, "__ok") is True and js(pg, "__n.body") == 'b'


def test_botao_anotar_abre_o_painel_e_foca(abrir):
    pg = abrir(hora=quando(20, 22, 0))
    rodar(pg, """const l=S.locais[0]; S.shifts.push({id:'AT',categoria:'remunerado',data:'2026-10-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
        valor:1000,liquido:1000,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''}); lsSet('plantoes:liveMin','AT'); await store.save(S); render();""")
    pg.click('nav button[data-v="caixa"]'); passo(pg, 300)
    rodar(pg, "tratarAcao(new URLSearchParams('action=anotar&id=AT'))"); passo(pg, 600)
    assert js(pg, "view") == 'mes'
    assert js(pg, "document.activeElement && document.activeElement.id") == 'ln-input'


def test_aviso_de_inicio_tem_rota_quando_o_local_tem_endereco(abrir):
    pg = abrir(hora=quando(20, 17, 30))
    rodar(pg, """const l=S.locais[0]; l.endereco='Rua Teste, 100'; l.cidade='Belo Horizonte';
        S.shifts.push({id:'R1',categoria:'remunerado',data:'2026-10-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
        valor:1000,liquido:1000,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''}); await store.save(S);""")
    ini = js(pg, "avisosPendentes(Date.now()).find(a=>a.tag.startsWith('ini:R1'))")
    assert ini['acoes'][0]['acao'] == 'rota' and ini['acoes'][0]['url'].startswith('https://www.google.com/maps/')
    assert ini['acoes'][1]['acao'] == 'ver'


def test_servidor_recebe_os_botoes(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas))
    rodar(pg, """const l=S.locais[0]; S.shifts.push({id:'S1',categoria:'remunerado',data:'2026-10-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
        valor:1000,liquido:1000,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''}); await store.save(S); render();""")
    sincroniza(pg)
    fim = next(a for a in chamadas[-1]['avisos'] if a['tag'].startswith('fim:S1'))
    assert [x['acao'] for x in fim['acoes']] == ['anotar', 'ver']
