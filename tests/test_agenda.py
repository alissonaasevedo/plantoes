"""Agenda nova: calendário com o plantão dentro do dia, painel do dia, lista por semana,
semana em linha do tempo, siglas dos locais e métricas 2×2."""
import json

from conftest import passo, js, rodar, quando

DADOS = """
const sb = S.locais.find(l=>/São Benedito/i.test(l.nome));
S.locais.push({id:'FR', nome:'Hospital Felício Rocho', cor:'#7C8BA1', residencia:true, vDia:0, vNoite:0});
const add = (id,data,hora,dur,turno,loc,valor,extra={}) => S.shifts.push({id,categoria:'remunerado',data,hora,duracao:dur,turno,localId:loc,valor,liquido:valor,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:'',...extra});
add('A1','2026-11-05','19:00',12,'noturno',sb.id,1750);
add('A2','2026-11-12','19:00',12,'noturno','FR',0,{categoria:'residencia'});
add('A3','2026-11-20','07:00',12,'diurno',sb.id,1600);
add('A4','2026-11-20','19:00',12,'noturno',sb.id,1700);
add('A5','2026-11-20','08:00',3,'diurno',sb.id,300);
S.bloqueios.push({id:'B1', motivo:'ferias', ini:'2026-11-23', fim:'2026-11-25', obs:''});
await store.save(S); cursor = new Date(2026,10,1); render();
"""


def abrir_nov(abrir, **kw):
    pg = abrir(hora=quando(19, 10, 0, mes=11), **kw)
    rodar(pg, DADOS); passo(pg, 300)
    return pg


def celula(pg, dia):
    return f'#cal-grid [data-day="{dia}"]'


def test_siglas_automaticas_e_manual(abrir):
    pg = abrir()
    assert js(pg, "siglaLocal(S.locais.find(l=>/São Benedito/i.test(l.nome)).id)") == 'SB'
    rodar(pg, "S.locais.push({id:'X1', nome:'UPA Acrízio Menezes (Justinópolis)'},{id:'X2', nome:'Hospital Felício Rocho'},{id:'X3', nome:'Unimed'},{id:'X4', nome:'Clínica Big Doctor', sigla:'big'})")
    assert [js(pg, f"siglaLocal('{i}')") for i in ['X1', 'X2', 'X3', 'X4']] == ['AM', 'FR', 'UNI', 'BIG']


def test_calendario_mostra_sigla_turno_residencia_e_bloqueio(abrir):
    pg = abrir_nov(abrir)
    assert 'SB' in pg.inner_text(celula(pg, 5)) and js(pg, f"!!document.querySelector('{celula(pg,5)} .ev.noite')")
    assert js(pg, f"!!document.querySelector('{celula(pg,12)} .ev.resid')"), 'residência tracejada'
    assert js(pg, f"document.querySelector('{celula(pg,20)}').querySelectorAll('.ev').length") == 2, '3 no dia: 1 chip + "+2"'
    assert '+2' in pg.inner_text(celula(pg, 20))
    assert js(pg, f"document.querySelector('{celula(pg,24)}').classList.contains('bl')") and 'FÉRIAS' in pg.inner_text(celula(pg, 24)).upper()
    assert 'Hospital Felício Rocho' in js(pg, f"document.querySelector('{celula(pg,12)}').getAttribute('aria-label')")
    esperado = js(pg, "S.shifts.filter(s=>s.data.startsWith('2026-11') && naAgenda(s) && !ehBolsa(s) && !ehBloq(s) && !ehResid(s) && counts(s)).length")
    assert f'{esperado} plantões' in pg.inner_text('#ag-resumo') and '1 da residência' in pg.inner_text('#ag-resumo')


def test_tocar_no_dia_mostra_o_painel_e_segundo_toque_vazio_lanca(abrir):
    pg = abrir_nov(abrir)
    assert 'quinta, 19' in pg.inner_text('#ag-dia').lower() or 'Quinta, 19' in pg.inner_text('#ag-dia'), 'abre no dia de hoje'
    pg.click(celula(pg, 20)); passo(pg, 200)
    txt = pg.inner_text('#ag-dia')
    assert 'Sexta, 20 de novembro' in txt and txt.count('UPA São Benedito') == 3
    assert js(pg, f"document.querySelector('{celula(pg,20)}').classList.contains('sel')")
    pg.click('#ag-dia [data-pay] >> nth=0'); passo(pg, 300)
    assert js(pg, "S.shifts.find(s=>s.id==='A3').pago"), 'marca pago pelo painel (primeiro do dia: 07h)'
    pg.click(celula(pg, 24)); passo(pg, 200)
    assert 'Férias' in pg.inner_text('#ag-dia')
    pg.click(celula(pg, 27)); passo(pg, 200)
    assert 'Nenhum plantão' in pg.inner_text('#ag-dia') and not js(pg, "$('#sheet').classList.contains('open')")
    pg.click(celula(pg, 27)); passo(pg, 400)
    assert js(pg, "$('#sheet').classList.contains('open')") and js(pg, "$('#f-date').value") == '2026-11-27'


def test_lista_compacta_por_semana_sem_entradas_fixas(abrir):
    pg = abrir_nov(abrir)
    seps = js(pg, "[...document.querySelectorAll('#shift-list .list-sep')].map(x=>x.textContent)")
    assert any('Esta semana' in x for x in seps)
    assert any(x.startswith('01/11 – 07/11') and 'plant' in x and 'h' in x for x in seps), seps
    nomes = js(pg, "[...document.querySelectorAll('#shift-list .shift .place span')].map(x=>x.textContent)")
    assert not any('Bolsa' in n for n in nomes), 'bolsa fica no Caixa e no filtro A receber'
    assert js(pg, "document.querySelectorAll('#shift-list .shift[data-date=\"2026-11-20\"] .daycol .d').length") == 1, 'data só na primeira linha do dia'
    altura = js(pg, "document.querySelector('#shift-list .shift').getBoundingClientRect().height")
    assert altura < 70, f'linha compacta ({altura}px)'
    pg.click('#filter [data-f="due"]'); passo(pg, 300)
    assert 'a receber' in pg.inner_text('#shift-list .list-sep')


def test_semana_em_linha_do_tempo_com_noturno_atravessando(abrir):
    pg = abrir_nov(abrir)
    pg.click('[data-vt="semana"]'); passo(pg, 200)
    rodar(pg, "semanaAtual = new Date(2026,10,16); renderSemana()"); passo(pg, 200)
    assert '15/11 – 21/11' in pg.inner_text('#week-view')
    barras = js(pg, "[...document.querySelectorAll('#week-view .tl-bar')].map(b=>({id:b.dataset.id, cont:b.classList.contains('cont'), segue:b.classList.contains('segue'), l:parseFloat(b.style.left), w:parseFloat(b.style.width)}))")
    a4 = [b for b in barras if b['id'] == 'A4']
    assert len(a4) == 2 and a4[0]['segue'] and a4[1]['cont'], 'noturno: 19h–24h na sexta e 0h–7h no sábado'
    assert abs(a4[0]['l'] - 19/24*100) < 0.2 and abs(a4[1]['w'] - 7/24*100) < 0.2
    pg.click('#week-view .tl-bar[data-id="A3"]'); passo(pg, 400)
    assert js(pg, "editing && editing.id") == 'A3'
    rodar(pg, "closeSheets()"); passo(pg, 300)
    pg.click('#week-view [data-sem="7"]'); passo(pg, 200)
    assert 'Férias' in pg.inner_text('#week-view')


def test_metricas_em_quadrado_2x2(abrir):
    pg = abrir()
    assert js(pg, "document.querySelectorAll('#h-stat-grid .kpi').length") == 4
    cols = js(pg, "getComputedStyle(document.querySelector('.kpis')).gridTemplateColumns.split(' ').length")
    assert cols == 2
    pg.click('#sc-receb-kpi'); passo(pg, 300)
    assert 'Recebido' in pg.inner_text('#sd-title')


def test_sigla_no_cadastro_do_local(abrir):
    pg = abrir()
    pg.click('nav button[data-v="locais"]'); passo(pg, 300)
    pg.click('[data-loc] >> nth=0'); passo(pg, 300)
    assert js(pg, "$('#l-sigla').placeholder").startswith('Automática')
    pg.fill('#l-sigla', 'upa1'); pg.click('#l-save'); passo(pg, 300)
    lid = js(pg, "S.locais[0].id")
    assert js(pg, f"siglaLocal('{lid}')") == 'UPA1'


def test_galaxy_agenda_cabe_na_largura(abrir):
    pg = abrir(aparelho='galaxy_s25ultra', hora=quando(19, 10, 0, mes=11))
    rodar(pg, DADOS); passo(pg, 300)
    assert js(pg, "document.documentElement.scrollWidth") <= 385
    pg.click('[data-vt="semana"]'); passo(pg, 300)
    assert js(pg, "document.documentElement.scrollWidth") <= 385
