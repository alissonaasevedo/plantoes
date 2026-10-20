"""Recursos: frequentes, desfazer, saúde dos dados, busca, escala fixa, boas-vindas, paletas."""
from conftest import passo, js, rodar, salvo


def test_frequentes_aparecem_e_preenchem(abrir):
    pg = abrir()
    rodar(pg, "openSheet(null,'2026-10-25')"); passo(pg, 400)
    assert js(pg, "document.querySelectorAll('#f-mod-row .mod').length") >= 1
    pg.click('#f-mod-row .mod >> nth=0'); passo(pg)
    m = js(pg, "modelosFrequentes()[0]")
    assert js(pg, "$('#f-local').value") == m['localId']
    assert js(pg, "$('#f-hora').value") == m['hora']
    assert js(pg, "duracaoAtual()") == m['duracao']
    rodar(pg, "openSheet(S.shifts[0])"); passo(pg)
    assert js(pg, "$('#f-modelos').classList.contains('hidden')"), 'editar não mostra frequentes'


def test_excluir_e_desfazer(abrir):
    pg = abrir()
    n0 = js(pg, "S.shifts.length")
    rodar(pg, "openSheet(S.shifts[3])"); passo(pg)
    pg.click('#sh-del'); passo(pg, 300)
    assert js(pg, "S.shifts.length") == n0 - 1
    pg.click('.toast-act'); passo(pg, 300)
    assert js(pg, "S.shifts.length") == n0
    assert len(salvo(pg)['shifts']) == n0


def test_saude_dos_dados_detecta_e_ignora(abrir):
    pg = abrir()
    rodar(pg, """const a = S.shifts.find(s=>counts(s) && s.hora && s.data>='2026-09-01');
        S.shifts.push({...a, id:'DUP1'});
        S.shifts.push({...a, id:'SV1', data:'2026-10-27', valor:0, liquido:0});
        S.shifts.push({...a, id:'SOB1', hora: a.hora==='19:00'?'23:00':'10:00', localId:S.locais[1].id});
        await store.save(S); render();""")
    passo(pg, 300)
    tipos = js(pg, "problemasDados().map(p=>p.tag)")
    for t in ['Duplicado', 'Conflito', 'Sem valor']:
        assert t in tipos
    n = len(tipos)
    pg.click('#saude-open'); passo(pg, 300)
    pg.click('[data-saude-ign] >> nth=0'); passo(pg, 300)
    pg.reload(); passo(pg, 2500)
    assert len(js(pg, "problemasDados()")) == n - 1


def test_busca(abrir):
    pg = abrir()
    pg.click('#btn-busca'); passo(pg, 300)
    pg.fill('#busca-q', 'acrizio noturno'); passo(pg)
    assert js(pg, "document.querySelectorAll('#busca-res .busca-item').length") > 0
    pg.fill('#busca-q', 'xyzinexistente'); passo(pg)
    assert 'Nada encontrado' in pg.inner_text('#busca-res')


def _repeticao(pg, modo, ate, dias_semana=()):
    rodar(pg, "openSheet(null,'2026-11-14','remunerado')"); passo(pg)   # sábado, 2º do mês
    pg.select_option('#f-rep', modo); passo(pg, 100)
    pg.fill('#f-rep-ate', ate); pg.dispatch_event('#f-rep-ate', 'input')
    for w in dias_semana:
        pg.click(f'#f-wd .chip[data-v="{w}"]')
    datas = js(pg, "datasRepeticao('2026-11-14')")
    pg.keyboard.press('Escape'); passo(pg, 200)
    return datas


def test_escala_fixa_todos_os_modos(abrir):
    pg = abrir()
    assert _repeticao(pg, 'sem', '2026-12-12') == ['2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12']
    assert _repeticao(pg, 'quinz', '2026-12-31', (2, 6)) == ['2026-11-24', '2026-11-28', '2026-12-08', '2026-12-12', '2026-12-22', '2026-12-26']
    assert _repeticao(pg, 'mesnth', '2027-03-31') == ['2026-12-12', '2027-01-09', '2027-02-13', '2027-03-13']
    assert _repeticao(pg, 'mesdia', '2027-02-28') == ['2026-12-14', '2027-01-14', '2027-02-14']


def test_boas_vindas_na_primeira_abertura(abrir):
    pg = abrir(dados=None)
    assert js(pg, "!!$('#welcome')")
    pg.fill('#wl-nome', 'UPA Centro'); pg.fill('#wl-dia', '1200')
    pg.click('#wl-ok'); passo(pg, 800)
    assert js(pg, "S.locais.length") == 1
    assert js(pg, "$('#sheet').classList.contains('open')")
    pg.click('#sh-save'); passo(pg, 400)
    assert js(pg, "S.shifts.length") == 1
    assert js(pg, "S.shifts[0].valor") == 1200


def test_boas_vindas_nao_aparece_com_dados(abrir):
    pg = abrir()
    assert not js(pg, "!!$('#welcome')")


def test_paletas_trocam_tokens(abrir):
    pg = abrir()
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    vistos = set()
    for pid in ['diaenoite', 'cirurgico', 'fintech', '']:
        pg.click(f'[data-pal="{pid}"]'); passo(pg, 150)
        vistos.add(js(pg, "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"))
    assert len(vistos) == 4
    assert js(pg, "localStorage.getItem('plantoes:paleta')") is None   # Clássico = sem preferência gravada


def test_saldo_oculto_persiste(abrir):
    pg = abrir()
    pg.click('#btn-ocultar'); pg.reload(); passo(pg, 2500)
    assert '•••' in pg.inner_text('#h-total')


def test_local_padrao_e_o_ultimo_usado(abrir):
    pg = abrir()
    esperado = js(pg, "S.shifts.filter(s=>s.categoria==='remunerado'&&getLocal(s.localId)).sort((a,b)=>b.data.localeCompare(a.data))[0].localId")
    rodar(pg, "openSheet(null,'2026-12-20','remunerado')"); passo(pg)
    assert js(pg, "$('#f-local').value") == esperado
