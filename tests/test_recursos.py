import json
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
    for pid in ['diaenoite', 'cirurgico', 'fintech', 'daltonico', '']:
        pg.click(f'[data-pal="{pid}"]'); passo(pg, 150)
        vistos.add(js(pg, "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"))
    assert len(vistos) == 5
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


def _fundo(pg):
    return js(pg, "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toUpperCase()")


def test_tema_automatico_claro_e_escuro(abrir):
    pg = abrir(tema='light')
    assert _fundo(pg) == '#F8F9FA'
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    assert js(pg, "$('#tema-segs [data-tema=\"\"]').classList.contains('on')")
    pg.click('#tema-segs [data-tema="escuro"]'); passo(pg, 200)
    assert _fundo(pg) == '#18181B' and js(pg, "temaEscuro()")
    assert js(pg, "document.querySelector('meta[name=theme-color][data-tema=dark]').media") == 'all'
    pg.reload(); passo(pg, 2500)
    assert _fundo(pg) == '#18181B', 'a escolha fica gravada'
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#tema-segs [data-tema=""]'); passo(pg, 200)
    assert _fundo(pg) == '#F8F9FA', 'automático volta a seguir o celular'


def test_tema_claro_com_celular_escuro_e_paleta(abrir):
    pg = abrir(tema='dark', paleta='daltonico')
    assert _fundo(pg) == '#111318'
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#tema-segs [data-tema="claro"]'); passo(pg, 200)
    assert _fundo(pg) == '#F7F8FA' and not js(pg, "temaEscuro()")


def test_plantao_noturno_da_residencia(abrir):
    from conftest import quando
    pg = abrir(hora=quando(19, 14, 0))
    total = js(pg, "$('#h-total').textContent")
    pg.click('#fab'); passo(pg, 300)
    pg.click('#fab-r'); passo(pg, 400)
    assert js(pg, "chipGet('#f-cat')") == 'residencia' and js(pg, "chipGet('#f-turno')") == 'noturno'
    assert js(pg, "$('#f-hora').value") == '19:00' and js(pg, "duracaoAtual()") == 12
    assert not js(pg, "$('#f-turno-wrap').classList.contains('hidden')"), 'turno e duração editáveis'
    assert js(pg, "$('#f-valor-wrap').classList.contains('hidden')"), 'sem campos de valor'
    assert js(pg, "$('#f-newlocal').value") == 'Hospital Felício Rocho'
    pg.fill('#f-date', '2026-10-22'); pg.dispatch_event('#f-date', 'change')
    pg.click('#sh-save'); passo(pg, 400)
    s = js(pg, "S.shifts.find(s=>s.categoria==='residencia')")
    assert (s['turno'], s['hora'], s['duracao'], s['valor']) == ('noturno', '19:00', 12, 0)
    assert js(pg, f"localName({json.dumps(s['localId'])})") == 'Hospital Felício Rocho'
    assert js(pg, "$('#h-total').textContent") == total, 'fora das contas'
    avisos = js(pg, "avisosPendentes(Date.now()).filter(a=>a.sid===S.shifts.find(s=>s.categoria==='residencia').id).map(a=>a.title)")
    assert 'Plantão noturno da residência em 1 hora' in avisos
    assert 'Plantão noturno da residência · Hospital Felício Rocho' in [c.get('summary') for c in js(pg, "[...gDesejado().values()].map(x=>x.corpo)")]
    assert js(pg, f"evTitulo({{...S.shifts.find(s=>s.categoria==='residencia'), turno:'diurno'}})").startswith('Plantão diurno da residência')
    # o próximo já abre no mesmo hospital, sem criar outro
    rodar(pg, "novoPlantaoResidencia('2026-10-29')"); passo(pg, 300)
    assert js(pg, "$('#f-local').value") == s['localId']
    # turno troca o horário padrão
    pg.click('#f-turno .chip[data-v="diurno"]'); passo(pg, 100)
    assert js(pg, "$('#f-hora').value") == '07:00'


def test_local_da_residencia_lanca_sem_remuneracao(abrir):
    pg = abrir()
    total = js(pg, "$('#h-total').textContent")
    # o usuário criou o local e lançou como plantão comum: entrou nas contas
    rodar(pg, """S.locais.push({id:'FR', nome:'Hospital Felício Rocho', cor:'#888', vDia:0, vNoite:0});
        S.shifts.push({id:'R1',categoria:'remunerado',data:'2026-10-21',hora:'19:00',duracao:12,turno:'noturno',localId:'FR',
          valor:500,liquido:500,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:''});
        await store.save(S); render();""")
    pg.click('nav button[data-v="locais"]'); passo(pg, 300)
    pg.click('[data-loc="FR"]'); passo(pg, 400)
    assert not js(pg, "$('#l-pag-wrap').classList.contains('hidden')")
    pg.click('#l-resid'); passo(pg, 100)
    assert js(pg, "$('#l-pag-wrap').classList.contains('hidden')"), 'esconde os campos de pagamento'
    pg.click('#l-save'); passo(pg, 400)
    s = js(pg, "S.shifts.find(s=>s.id==='R1')")
    assert s['categoria'] == 'residencia' and s['valor'] == 0
    assert 'residência' in pg.inner_text('#toast')
    assert 'sem remuneração' in pg.inner_text('[data-loc="FR"]')
    pg.click('nav button[data-v="mes"]'); passo(pg, 300)
    assert js(pg, "$('#h-total').textContent") == total
    # novo plantão: o local da residência não é sugerido para plantão pago,
    # e escolhê-lo troca a categoria sozinho
    rodar(pg, "openSheet(null,'2026-10-28','remunerado')"); passo(pg, 300)
    assert js(pg, "$('#f-local').value") != 'FR'
    pg.select_option('#f-local', 'FR'); passo(pg, 100)
    assert js(pg, "chipGet('#f-cat')") == 'residencia' and js(pg, "$('#f-valor-wrap').classList.contains('hidden')")
    rodar(pg, "closeSheets(); novoPlantaoResidencia('2026-10-30')"); passo(pg, 300)
    assert js(pg, "$('#f-local').value") == 'FR'


def test_felicio_rocho_ja_cadastrado_vira_residencia_uma_vez(abrir):
    import json as _j
    from conftest import BACKUP
    dados = _j.loads(_j.dumps(BACKUP))
    dados['locais'].append({'id': 'FR', 'nome': 'Hospital Felício Rocho', 'cor': '#888', 'vDia': 0, 'vNoite': 0})
    dados['shifts'].append({'id': 'R9', 'categoria': 'remunerado', 'data': '2026-10-21', 'hora': '19:00', 'duracao': 12, 'turno': 'noturno',
                            'localId': 'FR', 'valor': 0, 'liquido': 0, 'pago': False, 'tipo': 'meu'})
    pg = abrir(dados=dados)
    passo(pg, 1500)
    assert js(pg, "getLocal('FR').residencia") is True
    assert js(pg, "S.shifts.find(s=>s.id==='R9').categoria") == 'residencia'
    pg.reload(); passo(pg, 4000)
    assert 'agora é local' not in pg.inner_text('#toast'), 'só uma vez'
