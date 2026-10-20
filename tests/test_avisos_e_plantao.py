"""Avisos (1h antes / 30 min antes do fim) e modo plantão em andamento."""
import datetime as dt

from conftest import passo, js, rodar, quando

CAPTURA = "window.__n = []; window.mostrarNotificacao = async (t, o) => { window.__n.push(t + ' | ' + ((o && o.body) || '')); return true; };"
NOTURNO_DIA_20 = """const l = S.locais.find(x=>/São Benedito/i.test(x.nome)) || S.locais[0];
  S.shifts = S.shifts.filter(s=>s.id!=='N1');
  S.shifts.push({id:'N1',categoria:'remunerado',data:'2026-10-20',hora:'19:00',duracao:12,turno:'noturno',localId:l.id,
    valor:1350,liquido:1350,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''});
  await store.save(S); render();"""


def test_avisos_inicio_e_fim_sem_duplicar(abrir):
    pg = abrir(hora=quando(20, 17, 30), notificacoes=True)
    rodar(pg, CAPTURA); rodar(pg, NOTURNO_DIA_20); passo(pg, 300)
    passo(pg, 29 * 60_000)
    assert js(pg, "__n.length") == 0                       # 17:59
    passo(pg, 2 * 60_000)
    assert js(pg, "__n")[0].startswith('Plantão em 1 hora')  # 18:01
    for _ in range(3):
        rodar(pg, "render()")
    passo(pg, 60_000)
    assert js(pg, "__n.length") == 1
    passo(pg, (12 * 60 + 29) * 60_000)                     # 06:31 do dia 21
    assert js(pg, "__n")[1].startswith('Plantão termina em 30 min')


def test_aviso_perdido_sai_ao_reabrir_ate_10_min(abrir):
    pg = abrir(hora=quando(20, 18, 5), notificacoes=True)
    rodar(pg, CAPTURA); rodar(pg, NOTURNO_DIA_20); passo(pg, 500)
    assert js(pg, "__n.length") == 1
    pg2 = abrir(hora=quando(20, 18, 30), notificacoes=True)
    rodar(pg2, CAPTURA); rodar(pg2, NOTURNO_DIA_20); passo(pg2, 500)
    assert js(pg2, "__n.length") == 0


def test_ics_tem_os_dois_alarmes(abrir):
    pg = abrir()
    rodar(pg, NOTURNO_DIA_20)
    gatilhos = [l for l in js(pg, "vevento(S.shifts.find(s=>s.id==='N1'))").split('\r\n') if l.startswith('TRIGGER')]
    assert gatilhos == ['TRIGGER:-PT1H', 'TRIGGER;VALUE=DATE-TIME:20261021T093000Z']   # 06:30 em Brasília


def _plantao_em_curso(pg, inicio_ha_min=312):
    rodar(pg, f"""const ini = new Date(Date.now() - {inicio_ha_min}*60000);
      const l = S.locais.find(x=>/São Benedito/i.test(x.nome)) || S.locais[0];
      S.shifts = S.shifts.filter(s=>s.id!=='LIVE1');
      S.shifts.push({{id:'LIVE1',categoria:'remunerado',data:iso(ini),hora:pad2(ini.getHours())+':'+pad2(ini.getMinutes()),
        duracao:12,turno:'noturno',localId:l.id,valor:1350,liquido:1350,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''}});
      localStorage.removeItem('plantoes:liveMin'); localStorage.removeItem('plantoes:liveDone');
      cursor = new Date(); render();""")
    passo(pg, 1500)


def test_modo_plantao_painel_tema_e_minutos(abrir):
    pg = abrir(hora=quando(20, 23, 59))
    _plantao_em_curso(pg)
    assert js(pg, "!!document.querySelector('#live-panel .live:not(.live-done)')")
    assert js(pg, "document.documentElement.classList.contains('modo-plantao')")
    assert pg.inner_text('#lr-big').replace('\n', '') == '5h12'
    assert 'Faltam 6h48' in pg.inner_text('#live-falta')    # 5h12 + 6h48 = 12h


def test_modo_plantao_anotacao_nao_perde_digitacao(abrir):
    pg = abrir(hora=quando(20, 23, 0))
    _plantao_em_curso(pg)
    pg.fill('#ln-input', 'Repor material'); pg.press('#ln-input', 'Enter'); passo(pg)
    pg.fill('#ln-input', 'texto pela metade'); rodar(pg, "renderLive()")
    assert pg.input_value('#ln-input') == 'texto pela metade'
    assert js(pg, "S.shifts.find(s=>s.id==='LIVE1').notas.length") == 1


def test_modo_plantao_minimizar_e_concluido(abrir):
    pg = abrir(hora=quando(20, 23, 0))
    _plantao_em_curso(pg)
    pg.click('#live-min'); passo(pg, 400)
    assert js(pg, "!!$('.live-bar')")
    assert not js(pg, "document.documentElement.classList.contains('modo-plantao')")
    pg.click('#live-expand'); passo(pg, 400)
    _plantao_em_curso(pg, inicio_ha_min=13 * 60)
    assert js(pg, "!!$('.live-done')")
    pg.click('#ld-ok'); passo(pg, 300)
    assert js(pg, "$('#live-panel').innerHTML") == ''
