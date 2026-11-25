"""Agenda (v1.33): junção das referências — próximo plantão em destaque, calendário em
quadradinhos com o ícone do local, lista por dia com o descanso entre os plantões, folha
"Novo plantão" (os de sempre num toque) e cores dos locais seguras para daltonismo.
Sem siglas: o local aparece pelo nome completo e por um ícone."""
import itertools
import re

from conftest import passo, js, rodar, quando

DADOS = """
const sb = S.locais.find(l=>/São Benedito/i.test(l.nome));
S.locais.push({id:'FR', nome:'Hospital Felício Rocho', cor:'#9C6BFF', icone:'capelo', residencia:true, vDia:0, vNoite:0});
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


def celula(dia):
    return f'#cal-grid [data-day="{dia}"]'


def classes(pg, sel):
    return js(pg, f"document.querySelector('{sel}').className").split()


# ── cores e ícones ──

def _delta_min_daltonismo(cores):
    """Menor diferença (ΔE76) entre duas cores, na visão normal e simulando deuteranopia e
    protanopia (Machado 2009, severidade 1). Python puro, sem numpy."""
    D = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]
    P = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]
    I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    def lin(h):
        c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    def mul(M, v):
        return [max(0.0, min(1.0, sum(M[i][j] * v[j] for j in range(3)))) for i in range(3)]
    def lab(v):
        X = [0.4124 * v[0] + 0.3576 * v[1] + 0.1805 * v[2], 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2], 0.0193 * v[0] + 0.1192 * v[1] + 0.9505 * v[2]]
        X = [X[0] / 0.95047, X[1], X[2] / 1.08883]
        f = [x ** (1 / 3) if x > 0.008856 else 7.787 * x + 16 / 116 for x in X]
        return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])]
    def d(a, b, M):
        la, lb = lab(mul(M, lin(a))), lab(mul(M, lin(b)))
        return sum((x - y) ** 2 for x, y in zip(la, lb)) ** .5
    return min(d(a, b, M) for a, b in itertools.combinations(cores, 2) for M in (I, D, P))


def test_paleta_dos_locais_segura_para_daltonismo(abrir):
    pg = abrir()
    cores = js(pg, "CORES")
    assert len(cores) == 8
    assert _delta_min_daltonismo(cores) > 15, 'duas cores da paleta se confundem no daltonismo vermelho-verde'
    antigas = ['#FFC24D', '#4ECFA0', '#8B9DFF', '#FF7A93', '#5FC8EC', '#C48BF5', '#F79E5C', '#93D95F']
    assert _delta_min_daltonismo(antigas) < 5, 'referência: a paleta antiga tinha pares indistinguíveis'


def test_migracao_troca_cores_e_da_icone_a_cada_local(abrir):
    pg = abrir()
    locais = js(pg, "S.locais.map(l=>({nome:l.nome, cor:l.cor, icone:l.icone}))")
    cores = [l['cor'] for l in locais]
    assert all(c in js(pg, "CORES") for c in cores) and len(set(cores)) == len(cores), 'cores novas e sem repetir'
    por = {l['nome']: l for l in locais}
    assert por['UPA São Benedito']['cor'] == '#8B9DFF', 'quem já tinha uma cor da paleta nova continua com ela'
    assert por['UPA Acrízio Menezes (Justinópolis)']['icone'] == 'cruz' and por['UPA São Benedito']['icone'] == 'ambulancia', 'duas UPAs, dois ícones'
    assert por['Clínica Big Doctor']['icone'] == 'estetoscopio' and por['Bolsa da residência']['icone'] == 'cifrao'
    assert js(pg, "JSON.parse(localStorage.getItem('plantoes:v2')).v") == 4
    assert js(pg, "typeof siglaLocal") == 'undefined', 'siglas saíram do app'


def test_icone_e_cor_no_cadastro_do_local(abrir):
    pg = abrir()
    pg.click('nav button[data-v="locais"]'); passo(pg, 300)
    assert js(pg, "document.querySelectorAll('#loc-list .loc-ic svg').length") == js(pg, "S.locais.length")
    pg.click('[data-loc] >> nth=0'); passo(pg, 300)
    assert js(pg, "document.querySelectorAll('#l-icones .ic-opt').length") == 8 and not js(pg, "!!$('#l-sigla')")
    pg.click('#l-icones [data-ico="coracao"]'); pg.click('#l-save'); passo(pg, 300)
    assert js(pg, "S.locais[0].icone") == 'coracao'
    rodar(pg, "closeSheets()"); passo(pg, 300)
    pg.click('#fab'); passo(pg, 300)
    pg.fill('#l-nome', 'Hospital Odilon Behrens'); pg.click('#l-save'); passo(pg, 300)
    novo = js(pg, "S.locais.find(l=>l.nome==='Hospital Odilon Behrens')")
    assert novo['cor'] not in [l['cor'] for l in js(pg, "S.locais.filter(l=>l.nome!=='Hospital Odilon Behrens')")], 'local novo ganha uma cor livre'
    assert novo['icone'] in ('hospital', 'coracao', 'cruz', 'sirene')


# ── calendário ──

def test_calendario_sem_siglas_com_icone_forma_e_pago(abrir):
    pg = abrir_nov(abrir)
    assert js(pg, f"document.querySelector('{celula(5)}').innerText.trim()") == '5', 'só o número do dia; o local vem pelo ícone'
    assert 't-noite' in classes(pg, celula(5)) and js(pg, f"!!document.querySelector('{celula(5)} .cd-i svg')")
    assert 't-res' in classes(pg, celula(12)), 'residência tracejada'
    assert 't-dia' in classes(pg, celula(20)) and pg.inner_text(f'{celula(20)} .cd-mais') == '3'
    assert 'bl' in classes(pg, celula(24)) and 'férias' in js(pg, f"document.querySelector('{celula(24)}').getAttribute('aria-label')").lower()
    assert 'Hospital Felício Rocho' in js(pg, f"document.querySelector('{celula(12)}').getAttribute('aria-label')")
    assert not js(pg, f"!!document.querySelector('{celula(5)} .cd-ok')")
    rodar(pg, "S.shifts.find(s=>s.id==='A1').pago = true; await store.save(S); render();"); passo(pg, 200)
    assert js(pg, f"!!document.querySelector('{celula(5)} .cd-ok')"), '✓ quando o plantão já foi pago'
    leg = pg.inner_text('#ag-leg')
    assert 'UPA São Benedito' in leg and 'Hospital Felício Rocho' in leg and 'pago' in leg
    esperado = js(pg, "S.shifts.filter(s=>s.data.startsWith('2026-11') && naAgenda(s) && !ehBolsa(s) && !ehBloq(s) && !ehResid(s) && counts(s)).length")
    assert f'{esperado} plantões' in pg.inner_text('#ag-resumo') and '1 da residência' in pg.inner_text('#ag-resumo')


def test_tocar_no_dia_mostra_o_painel_e_segundo_toque_vazio_abre_a_folha(abrir):
    pg = abrir_nov(abrir)
    assert 'Quinta, 19' in pg.inner_text('#ag-dia'), 'abre no dia de hoje'
    pg.click(celula(20)); passo(pg, 200)
    txt = pg.inner_text('#ag-dia')
    assert 'Sexta, 20 de novembro' in txt and js(pg, "document.querySelectorAll('#ag-dia .shift').length") == 3
    assert 'sel' in classes(pg, celula(20))
    pg.click('#ag-dia [data-pay] >> nth=0'); passo(pg, 300)
    assert js(pg, "S.shifts.find(s=>s.id==='A3').pago"), 'marca pago pelo painel (primeiro do dia: 07h)'
    assert '✓ Pago' in pg.inner_text('#ag-dia')
    pg.click(celula(24)); passo(pg, 200)
    assert 'Férias' in pg.inner_text('#ag-dia')
    pg.click(celula(27)); passo(pg, 200)
    assert 'Nenhum plantão neste dia' in pg.inner_text('#ag-dia') and not js(pg, "$('#sheet-novo').classList.contains('open')")
    pg.click(celula(27)); passo(pg, 400)
    assert js(pg, "$('#sheet-novo').classList.contains('open')") and js(pg, "_qs.data") == '2026-11-27'


def test_painel_mostra_emenda_e_descanso_curto(abrir):
    pg = abrir_nov(abrir)
    pg.click(celula(20)); passo(pg, 200)
    txt = pg.inner_text('#ag-dia')
    assert 'h seguidas' in txt and 'plantões emendados' in txt, 'A3 07–19 + A4 19–07 (+ clínica às 8h) emendados'
    assert js(pg, "emendaComAnterior(S.shifts.find(s=>s.id==='A4'))") is True
    assert js(pg, "document.querySelectorAll('#shift-list .shift[data-id=\"A4\"] .emd').length") == 1
    rodar(pg, """const sb=S.locais.find(l=>/São Benedito/i.test(l.nome)); S.shifts.push({id:'A6',categoria:'remunerado',data:'2026-11-21',hora:'13:00',duracao:6,turno:'diurno',localId:sb.id,valor:700,liquido:700,pago:false,tipo:'meu'}); await store.save(S); render();""")
    pg.click(celula(20)); passo(pg, 200)
    assert re.search(r'Só \dh de descanso até o próximo \(UPA São Benedito', pg.inner_text('#ag-dia'))
    assert 'amanhã' in pg.inner_text('#ag-dia')


# ── lista do mês ──

def test_lista_por_dia_com_descanso_entre_os_plantoes(abrir):
    pg = abrir_nov(abrir)
    rodar(pg, """const sb=S.locais.find(l=>/São Benedito/i.test(l.nome));
      S.shifts = S.shifts.filter(s => !s.data.startsWith('2026-11') || s.categoria === 'bolsa' || /^A[0-9]$/.test(s.id));
      S.shifts.push({id:'A7',categoria:'remunerado',data:'2026-11-07',hora:'13:00',duracao:6,turno:'diurno',localId:sb.id,valor:700,liquido:700,pago:false,tipo:'meu'});
      S.shifts.push({id:'A8',categoria:'remunerado',data:'2026-11-08',hora:'01:00',duracao:6,turno:'noturno',localId:sb.id,valor:700,liquido:700,pago:false,tipo:'meu'});
      await store.save(S); render();"""); passo(pg, 200)
    dias = js(pg, "[...document.querySelectorAll('#shift-list .dia2 .dc b')].map(b=>b.textContent)")
    assert dias == ['5', '7', '8', '12', '20'], 'um bloco por dia, sem entradas fixas'
    assert js(pg, "document.querySelectorAll('#shift-list .dia2')[4].querySelectorAll('.shift').length") == 3, 'data grande uma vez só'
    seps = js(pg, "[...document.querySelectorAll('#shift-list .desc span')].map(x=>x.textContent)")
    assert seps == ['Descanso de 30h', '⚠ Só 6h de descanso', '4 dias livres', '7 dias livres'], seps
    assert 'curto' in classes(pg, '#shift-list .desc:nth-of-type(2)') or js(pg, "document.querySelectorAll('#shift-list .desc.curto').length") == 1
    nomes = js(pg, "[...document.querySelectorAll('#shift-list .shift .place span')].map(x=>x.textContent)")
    assert 'Plantão noturno da residência' in nomes and not any('Bolsa' in n for n in nomes)
    assert 'Hospital Felício Rocho' in pg.inner_text('#shift-list .shift.resid')
    pg.click('#filter [data-f="due"]'); passo(pg, 300)
    assert js(pg, "document.querySelectorAll('#shift-list .desc').length") == 0, 'no filtro A receber não há descanso'


def test_status_com_simbolo_e_texto(abrir):
    pg = abrir_nov(abrir)
    a1 = '#shift-list .shift[data-id="A1"] [data-pay]'
    assert re.match(r'(cai|venceu) \d\d/\d\d|cai em \w+', pg.inner_text(a1)), pg.inner_text(a1)
    assert js(pg, f"!!document.querySelector('{a1} svg')"), 'relógio + data, não só cor'
    pg.click(a1); passo(pg, 300)
    assert pg.inner_text('#shift-list .shift[data-id="A1"] [data-pay]') == '✓ Pago'
    assert not js(pg, "!!document.querySelector('#shift-list .shift.resid [data-pay]')"), 'residência não tem pagamento'


def test_proximo_plantao_em_destaque(abrir):
    pg = abrir_nov(abrir)
    txt = pg.inner_text('#next-card')
    assert 'amanhã' in txt.lower() and 'UPA São Benedito' in txt and '07:00 → 19:00' in txt
    assert js(pg, "brl(1600)") in txt and 'cai' in txt
    assert not any(c in txt for c in '🔴🟢🟡🟠'), 'sem bolinhas vermelho/verde'
    assert js(pg, "!!document.querySelector('#next-card .nx-ic svg')")
    pg.click('#next-card .next2 h3'); passo(pg, 400)
    assert js(pg, "editing && editing.id") == 'A3'


# ── folha Novo plantão ──

def test_seus_de_sempre_lancam_num_toque_com_desfazer(abrir):
    pg = abrir_nov(abrir)
    m = js(pg, "modelosFrequentes(3)[0]")
    assert m, 'o histórico tem modelos'
    n0 = js(pg, "S.shifts.length")
    rodar(pg, "abrirNovoRapido('2026-11-27')"); passo(pg, 400)
    assert pg.is_visible('#sheet-novo [data-qmod="0"]')
    pg.click('#sheet-novo [data-qmod="0"]'); passo(pg, 400)
    novo = js(pg, "S.shifts[S.shifts.length-1]")
    assert js(pg, "S.shifts.length") == n0 + 1 and novo['data'] == '2026-11-27'
    assert (novo['localId'], novo['hora'], novo['duracao']) == (m['localId'], m['hora'], m['duracao'])
    assert not novo['pago'] and novo['tipo'] == 'meu'
    assert not js(pg, "$('#sheet-novo').classList.contains('open')") and 'Lançado' in pg.inner_text('#toast')
    pg.click('#toast .toast-act'); passo(pg, 400)
    assert js(pg, "S.shifts.length") == n0, 'Desfazer remove'


def test_escolher_local_e_turno_mostra_quanto_vai_receber(abrir):
    pg = abrir_nov(abrir)
    am = js(pg, "S.locais.find(l=>/Acrízio/.test(l.nome)).id")
    rodar(pg, "abrirNovoRapido('2026-11-26')"); passo(pg, 400)
    pg.click(f'#sheet-novo [data-qloc="{am}"]'); passo(pg, 100)
    pg.click('#sheet-novo [data-qtn="noturno"]'); passo(pg, 100)
    p = js(pg, "plantaoDaFolha()")
    assert (p['localId'], p['turno'], p['duracao']) == (am, 'noturno', 12) and p['valor'] > 0
    res = pg.inner_text('#sheet-novo .qs-res')
    assert 'Você vai receber' in res and js(pg, f"brl({p['liquido']})") in res and 'cai em' in res
    assert 'na quinta, 26' in pg.inner_text('#qs-go')
    pg.click('#qs-go'); passo(pg, 400)
    novo = js(pg, "S.shifts[S.shifts.length-1]")
    assert (novo['localId'], novo['data'], novo['turno'], novo['hora'], novo['categoria']) == (am, '2026-11-26', 'noturno', p['hora'], 'remunerado')
    rodar(pg, "abrirNovoRapido('2026-11-28')"); passo(pg, 400)
    pg.click('#sheet-novo [data-qtn="h24"]'); passo(pg, 100)
    assert js(pg, "plantaoDaFolha().duracao") == 24 and 'no sábado, 28' in pg.inner_text('#qs-go')
    pg.click('#sheet-novo [data-qloc="FR"]'); passo(pg, 100)
    assert 'Plantão da residência' in pg.inner_text('#sheet-novo .qs-res')
    pg.click('#qs-go'); passo(pg, 400)
    novo = js(pg, "S.shifts[S.shifts.length-1]")
    assert (novo['categoria'], novo['valor'], novo['localId']) == ('residencia', 0, 'FR')


def test_folha_avisa_choque_e_dia_bloqueado(abrir):
    pg = abrir_nov(abrir)
    sb = js(pg, "S.locais.find(l=>/São Benedito/i.test(l.nome)).id")
    n0 = js(pg, "S.shifts.length")
    rodar(pg, "abrirNovoRapido('2026-11-20')"); passo(pg, 400)
    pg.click(f'#sheet-novo [data-qloc="{sb}"]'); pg.click('#sheet-novo [data-qtn="diurno"]'); passo(pg, 100)
    pg.click('#qs-go'); passo(pg, 200)
    assert js(pg, "S.shifts.length") == n0 and 'Choca com UPA São Benedito em 20/11' in pg.inner_text('#sheet-novo .qs-aviso')
    assert pg.inner_text('#qs-go') == 'Lançar mesmo assim'
    pg.click('#qs-go'); passo(pg, 400)
    assert js(pg, "S.shifts.length") == n0 + 1
    rodar(pg, "abrirNovoRapido('2026-11-24')"); passo(pg, 400)
    pg.click('#qs-go'); passo(pg, 200)
    assert 'Dia marcado como férias' in pg.inner_text('#sheet-novo .qs-aviso')
    pg.click('#sheet-novo [data-qdia]:not(.on)'); passo(pg, 100)
    assert not js(pg, "!!$('#sheet-novo .qs-aviso')"), 'mudar a escolha limpa o aviso'


def test_mais_detalhes_abre_o_formulario_preenchido(abrir):
    pg = abrir_nov(abrir)
    am = js(pg, "S.locais.find(l=>/Acrízio/.test(l.nome)).id")
    rodar(pg, "abrirNovoRapido('2026-11-26')"); passo(pg, 400)
    pg.click(f'#sheet-novo [data-qloc="{am}"]'); pg.click('#sheet-novo [data-qtn="noturno"]'); passo(pg, 100)
    pg.click('#qs-mais'); passo(pg, 600)
    assert js(pg, "$('#sheet').classList.contains('open')") and not js(pg, "$('#sheet-novo').classList.contains('open')")
    assert (js(pg, "$('#f-date').value"), js(pg, "$('#f-local').value"), js(pg, "chipGet('#f-turno')")) == ('2026-11-26', am, 'noturno')


def test_menu_do_mais_abre_a_folha(abrir):
    pg = abrir_nov(abrir)
    pg.click('#fab'); passo(pg, 300)
    pg.click('#fab-p'); passo(pg, 400)
    assert js(pg, "$('#sheet-novo').classList.contains('open')") and js(pg, "_qs.data") == '2026-11-19'
    rodar(pg, "closeSheets()"); passo(pg, 400)
    pg.click('#fab'); passo(pg, 300)
    pg.click('#fab-r'); passo(pg, 400)
    assert js(pg, "_qs.localId") == 'FR' and js(pg, "_qs.turno") == 'noturno'


# ── semana, métricas, largura ──

def test_semana_em_linha_do_tempo_com_noturno_atravessando(abrir):
    pg = abrir_nov(abrir)
    pg.click('[data-vt="semana"]'); passo(pg, 200)
    rodar(pg, "semanaAtual = new Date(2026,10,16); renderSemana()"); passo(pg, 200)
    assert '15/11 – 21/11' in pg.inner_text('#week-view')
    barras = js(pg, "[...document.querySelectorAll('#week-view .tl-bar')].map(b=>({id:b.dataset.id, cont:b.classList.contains('cont'), segue:b.classList.contains('segue'), l:parseFloat(b.style.left), w:parseFloat(b.style.width)}))")
    a4 = [b for b in barras if b['id'] == 'A4']
    assert len(a4) == 2 and a4[0]['segue'] and a4[1]['cont'], 'noturno: 19h–24h na sexta e 0h–7h no sábado'
    assert abs(a4[0]['l'] - 19/24*100) < 0.2 and abs(a4[1]['w'] - 7/24*100) < 0.2
    assert js(pg, "!!document.querySelector('#week-view .tl-bar[data-id=\"A3\"] .il')"), 'ícone do local no lugar da sigla'
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


def test_galaxy_agenda_e_folha_cabem_na_largura(abrir):
    pg = abrir(aparelho='galaxy_s25ultra', hora=quando(19, 10, 0, mes=11))
    rodar(pg, DADOS); passo(pg, 300)
    assert js(pg, "document.documentElement.scrollWidth") <= 385
    lado = js(pg, "(c => c.getBoundingClientRect().width - c.getBoundingClientRect().height)(document.querySelector('#cal-grid [data-day=\"20\"]'))")
    assert abs(lado) < 1.5, 'quadradinho'
    pg.click('[data-vt="semana"]'); passo(pg, 300)
    assert js(pg, "document.documentElement.scrollWidth") <= 385
    rodar(pg, "abrirNovoRapido('2026-11-26')"); passo(pg, 400)
    assert js(pg, "(s => s.scrollWidth <= s.clientWidth + 1)(document.querySelector('#sheet-novo'))")
    assert js(pg, "(b => b.getBoundingClientRect().bottom <= innerHeight + 1)(document.querySelector('#qs-go'))") or \
        js(pg, "getComputedStyle(document.querySelector('#sheet-novo')).overflowY") in ('auto', 'scroll'), 'botão Lançar alcançável'


def test_linha_do_agora_na_semana(abrir):
    pg = abrir_nov(abrir)
    pg.click('[data-vt="semana"]'); passo(pg, 300)
    left = js(pg, "parseFloat(document.querySelector('.tl-row.hoje .tl-agora').style.left)")
    assert abs(left - 10/24*100) < 0.5, '10h da manhã'


def test_deslizar_troca_mes_e_semana(abrir):
    pg = abrir_nov(abrir, aparelho='galaxy_s25ultra')
    def deslizar(sel, dx):
        rodar(pg, f"""const el=document.querySelector('{sel}'); const r=el.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+60;
          const t=(tx)=>new Touch({{identifier:1,target:el,clientX:tx,clientY:y}});
          el.dispatchEvent(new TouchEvent('touchstart',{{touches:[t(x)],changedTouches:[t(x)],bubbles:true}}));
          el.dispatchEvent(new TouchEvent('touchend',{{touches:[],changedTouches:[t(x+({dx}))],bubbles:true}}));""")
        passo(pg, 300)
    deslizar('#cal-mes', -120)
    assert 'Dezembro' in pg.inner_text('#title')
    deslizar('#cal-mes', 120); deslizar('#cal-mes', 120)
    assert 'Outubro' in pg.inner_text('#title')
    deslizar('#cal-mes', 20)
    assert 'Outubro' in pg.inner_text('#title'), 'toque curto não troca'
    pg.click('[data-vt="semana"]'); passo(pg, 300)
    antes = pg.inner_text('.tl-nav b')
    deslizar('#week-view', -120)
    assert pg.inner_text('.tl-nav b') != antes
