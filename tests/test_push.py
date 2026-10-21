"""Avisos pelo servidor (Web Push): sincronia da agenda, recuo para avisos locais, botão de teste.
O servidor e a inscrição de push do aparelho são simulados (o Chromium de teste não tem serviço de push)."""
import json

from conftest import passo, js, rodar, quando

SW_FALSO = """
const subFalsa = { endpoint:'https://fcm.googleapis.com/fcm/send/TESTE',
  toJSON(){ return { endpoint:this.endpoint, keys:{ p256dh:'BPx', auth:'aut' } }; }, unsubscribe: async () => true };
const regFalso = { pushManager: { getSubscription: async () => window.__sub || null,
    subscribe: async () => { window.__sub = subFalsa; window.__inscricoes = (window.__inscricoes||0) + 1; return subFalsa; } },
  showNotification: async () => {}, update(){}, addEventListener(){} };
Object.defineProperty(navigator, 'serviceWorker', { configurable:true, value: { ready: Promise.resolve(regFalso),
  getRegistration: async () => regFalso, getRegistrations: async () => [regFalso], register: async () => regFalso, addEventListener(){}, controller: null } });
"""
NOTURNO = """const l = S.locais.find(x=>/São Benedito/i.test(x.nome)) || S.locais[0];
  S.shifts = S.shifts.filter(s=>s.id!=='N1');
  S.shifts.push({id:'N1',categoria:'remunerado',data:'2026-10-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
    valor:1350,liquido:1350,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''});
  await store.save(S); render();"""


def sincroniza(pg):
    """Deixa o adiamento de 2,5 s vencer e a resposta do servidor simulado chegar (rede corre no tempo real)."""
    passo(pg, 3000); pg.wait_for_timeout(400); passo(pg, 100)


def servidor(chamadas, ativo=True, status_agendar=200):
    def config(route):
        route.fulfill(status=200, content_type='application/json',
                      body=json.dumps({'ativo': ativo, 'vapidPublica': 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' if ativo else None}))
    def agendar(route):
        corpo = route.request.post_data_json
        chamadas.append(corpo)
        ids = [f'msg_{len(chamadas)}_{i}' for i, _ in enumerate(corpo['avisos'])]
        route.fulfill(status=status_agendar, content_type='application/json', body=json.dumps({'ids': ids}))
    return {'**/api/config': config, '**/api/agendar': agendar}


def test_sem_servidor_continua_com_avisos_locais(abrir):
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO)   # /api não existe no servidor de teste
    rodar(pg, NOTURNO); sincroniza(pg)
    assert js(pg, "pushAtivo()") is False
    assert js(pg, "_avisoTimers.length") >= 2
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    assert 'só com o app aberto' in pg.inner_text('#push-status')


def test_com_servidor_agenda_e_desliga_timers_locais(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas))
    rodar(pg, NOTURNO); sincroniza(pg)
    assert js(pg, "pushAtivo()") is True
    ultimo = chamadas[-1]
    assert ultimo['sub']['endpoint'].startswith('https://fcm.googleapis.com/')
    tags = [a['tag'].split(':')[0] + ':' + a['tag'].split(':')[1] for a in ultimo['avisos']]
    assert 'ini:N1' in tags and 'fim:N1' in tags
    ini = next(a for a in ultimo['avisos'] if a['tag'].startswith('ini:N1'))
    assert ini['url'] == './?action=plantao&id=N1' and ini['sid'] == 'N1'
    assert js(pg, "_avisoTimers.length") == 0, 'sem timers locais duplicando o servidor'
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    assert 'servidor ✓' in pg.inner_text('#push-status')


def test_reagenda_so_quando_muda_e_cancela_os_anteriores(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas))
    rodar(pg, NOTURNO); sincroniza(pg)
    n = len(chamadas)
    ids_antes = js(pg, "JSON.parse(localStorage.getItem('plantoes:pushSync')).ids")
    for _ in range(3):
        rodar(pg, "render()")
    sincroniza(pg)
    assert len(chamadas) == n, 're-render sem mudança não chama o servidor'
    rodar(pg, "S.shifts.find(s=>s.id==='N1').hora = '20:00'; await store.save(S); render();"); sincroniza(pg)
    assert len(chamadas) == n + 1
    assert chamadas[-1]['cancelar'] == ids_antes
    assert js(pg, "window.__inscricoes") == 1, 'a inscrição do aparelho é reaproveitada'


def test_servidor_falhando_volta_para_avisos_locais(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas, status_agendar=500))
    rodar(pg, NOTURNO); sincroniza(pg)
    assert js(pg, "pushAtivo()") is False
    rodar(pg, "render()"); passo(pg, 300)
    assert js(pg, "_avisoTimers.length") >= 2
    assert any(e['onde'] == 'push' for e in js(pg, "JSON.parse(localStorage.getItem('plantoes:diag'))"))


def test_desligar_todos_os_avisos_cancela_no_servidor(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas))
    rodar(pg, NOTURNO); sincroniza(pg)
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    for k in ['av-inicio', 'av-fim']:
        pg.click(f'#{k}'); passo(pg, 100)
    sincroniza(pg)
    assert chamadas[-1]['avisos'] == [] and len(chamadas[-1]['cancelar']) >= 1


def test_botao_de_teste_usa_o_servidor(abrir):
    chamadas = []
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True, init=SW_FALSO, rotas=servidor(chamadas))
    rodar(pg, NOTURNO); sincroniza(pg)
    n = len(chamadas)
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#btn-notif-teste'); passo(pg, 500)
    teste = chamadas[n]
    assert teste['cancelar'] == [] and len(teste['avisos']) == 1 and teste['avisos'][0]['tag'].startswith('teste-')
    assert 'servidor' in pg.inner_text('#toast')
