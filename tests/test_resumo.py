"""Resumo com gráficos e tabela, e a imagem do ano (post, stories e modo discreto).

Os números do Resumo, do "Seu ano em números" e da imagem saem da mesma conta (agregar):
plantões e entradas fixas (bolsa) separados, residência só em horas."""
from conftest import passo, js, rodar, quando


def esp(s):
    """Texto com espaços normais (o brl usa espaço não separável)."""
    return ' '.join(str(s).split())

ANO = """
const sb = S.locais.find(l=>/São Benedito/i.test(l.nome));
const am = S.locais.find(l=>/Acrízio/i.test(l.nome));
S.locais.push({id:'FR', nome:'Hospital Felício Rocho', cor:'#7C8BA1', residencia:true, vDia:0, vNoite:0});
S.shifts = S.shifts.filter(s => !s.data.startsWith('2026'));
const add = (id,data,hora,dur,turno,loc,valor,extra={}) => S.shifts.push({id,categoria:'remunerado',data,hora,duracao:dur,turno,localId:loc,valor,liquido:valor,pago:false,pagoEm:'',venc:'',tipo:'meu',colega:'',contra:'',quitado:false,obs:'',...extra});
add('P1','2026-03-02','07:00',12,'diurno',sb.id,1600,{pago:true});
add('P2','2026-03-02','19:00',12,'noturno',sb.id,1750,{pago:true});
add('P3','2026-07-10','19:00',24,'noturno',am.id,3200);
add('P4','2026-11-05','07:00',12,'diurno',am.id,1500);
add('P5','2026-11-14','19:00',12,'noturno',sb.id,1750,{tipo:'peguei', colega:'Ana'});
add('X1','2026-11-21','07:00',12,'diurno',sb.id,1600,{tipo:'passei', colega:'Bia'});
add('R1','2026-11-12','19:00',12,'noturno','FR',0,{categoria:'residencia'});
add('B1','2026-11-02','',0,'diurno',S.locais.find(l=>/Bolsa/.test(l.nome)).id,4000,{categoria:'bolsa', pago:true});
await store.save(S); render();
"""


def abrir_resumo(abrir, periodo='ano', **kw):
    pg = abrir(hora=quando(20, 21, 0, mes=11), **kw)
    rodar(pg, ANO); passo(pg, 300)
    pg.click('nav button[data-v="resumo"]'); passo(pg, 400)
    pg.click(f'[data-rp="{periodo}"]'); passo(pg, 300)
    return pg


def test_topo_separa_plantoes_e_entradas_fixas(abrir):
    pg = abrir_resumo(abrir)
    assert js(pg, "$('#res-total').textContent") == js(pg, "brl(1600+1750+3200+1500+1750+4000)")
    div = pg.inner_text('#res-div')
    assert 'Plantões' in div and js(pg, "brl(9800)") in div and 'Entradas fixas' in div and js(pg, "brl(4000)") in div
    sub = pg.inner_text('#res-sub')
    assert sub.startswith('5 plantões · 72h') and '+12h de residência' in sub, 'passei e residência não contam como plantão'
    assert js(pg, "$('#res-rec').textContent") == js(pg, "brl(1600+1750+4000)")
    kpis = [esp(k) for k in js(pg, "[...document.querySelectorAll('#res-kpis .kpi')].map(k=>k.innerText)")]
    assert len(kpis) == 4 and kpis[0].startswith('5 plantões 3 noturnos')
    assert esp(js(pg, "brl(9800/72)")) in kpis[2] and esp(js(pg, "brl(9800/5)")) in kpis[3], 'médias sem a bolsa'


def test_resumo_wrapped_e_imagem_usam_a_mesma_conta(abrir):
    pg = abrir_resumo(abrir)
    rodar(pg, "renderWrapped()")
    assert js(pg, "$('#wr-total').textContent") == js(pg, "$('#res-total').textContent")
    assert js(pg, "$('#wr-qtd').textContent") == '5'
    assert js(pg, "$('#wr-top-local').textContent") == 'UPA São Benedito', '5.100 (SB) × 4.700 (AM)'
    assert '1 plantões' not in pg.inner_text('#wr-top-local-sub')
    assert js(pg, "dadosAno(2026).locais.every(x => S.locais.find(l=>l.id===x.lid) && !/Bolsa/.test(localName(x.lid)))"), 'bolsa fora do ranking'
    assert js(pg, "$('#wr-seq').textContent") == '24h seguidas', 'plantões das 07h e 19h do mesmo dia emendam'
    assert js(pg, "$('#wr-noites').textContent") == '3'


def test_periodos_trocam_graficos(abrir):
    pg = abrir_resumo(abrir)
    assert js(pg, "document.querySelectorAll('#res-meses rect[data-mes]').length") == 12
    assert 'No ritmo atual, 2026 fecha em' in pg.inner_text('#res-proj')
    assert js(pg, "$('#res-meses-tit').textContent") == 'Mês a mês · 2026'
    for rp, n, nome in [('mes', 6, 'Este mês'), ('3m', 6, 'Últimos 3 meses'), ('tudo', 12, 'Todo o período')]:
        pg.click(f'[data-rp="{rp}"]'); passo(pg, 200)
        assert js(pg, "document.querySelectorAll('#res-meses rect[data-mes]').length") == n
        assert pg.inner_text('#res-proj').strip() == '', 'projeção só no ano'
        assert nome in js(pg, "$('#res-lbl').textContent")
    pg.click('[data-rp="mes"]'); passo(pg, 200)
    assert js(pg, "$('#res-total').textContent") == js(pg, "brl(1500+1750+4000)")


def test_tocar_no_mes_mostra_os_numeros(abrir):
    pg = abrir_resumo(abrir)
    assert 'Toque num mês' in pg.inner_text('#res-meses')
    pg.click('#res-meses rect[data-mes="2026-10"]', force=True); passo(pg, 200)
    info = pg.inner_text('#res-meses .mes-info')
    assert 'Novembro de 2026' in info and 'UPA São Benedito' in info and 'Entradas fixas' in info
    assert js(pg, "brl(1750)") in info and '2 · 24h' in info
    pg.click('#res-meses rect[data-mes="2026-10"]', force=True); passo(pg, 200)
    assert not js(pg, "!!$('#res-meses .mes-info')")


def test_horas_e_valor_da_hora(abrir):
    pg = abrir_resumo(abrir)
    rotulos = js(pg, "[...document.querySelectorAll('#res-horas text')].map(t=>t.textContent).filter(t=>/^\\d+h$/.test(t))")
    assert rotulos == ['36h', '24h'], 'escala (24h + 12h de residência) e só o primeiro mês de mais horas'
    assert js(pg, "document.querySelectorAll('#res-horas circle').length") == 3, 'R$/h nos 3 meses com plantão'
    assert 'residência' in pg.inner_text('#res-horas')


def test_mapa_de_calor_do_ano(abrir):
    pg = abrir_resumo(abrir)
    assert js(pg, "document.querySelectorAll('#res-calor rect.hm').length") == 365
    assert js(pg, "document.querySelectorAll('#res-calor rect.hm:not(.n0)').length") == 5, 'dias com plantão ou residência (passei fora)'
    assert js(pg, "$('#res-calor rect[data-hm=\"2026-03-02\"]').classList.contains('n3')"), '24h no dia'
    assert js(pg, "$('#res-calor rect[data-hm=\"2026-11-20\"]').classList.contains('hoje')")
    assert '5 dias com plantão · 84h' in pg.inner_text('#res-calor')
    pg.click('#res-calor rect[data-hm="2026-03-02"]', force=True); passo(pg, 100)
    assert '02/03: SB 12h + SB 12h' in pg.inner_text('#toast')


def test_por_local_e_turnos(abrir):
    pg = abrir_resumo(abrir)
    linhas = [esp(r) for r in js(pg, "[...document.querySelectorAll('#res-locais tbody tr')].map(r=>r.innerText)")]
    assert len(linhas) == 2 and linhas[0].startswith('SB UPA São Benedito 3 plantões · 36h')
    assert 'melhor' in linhas[0], 'maior R$/h (5100/36 > 4700/36)'
    assert js(pg, "document.querySelectorAll('#res-locais .barra100 i').length") == 2
    assert js(pg, "[...document.querySelectorAll('#res-turnos .barra100 b')].map(b=>b.textContent)") == ['32%', '68%'], 'diurno 3.100 × noturno 6.700'
    assert 'Você mais trabalha' in pg.inner_text('#res-semana')


def test_tabela_ordena_e_soma(abrir):
    pg = abrir_resumo(abrir)
    meses = lambda: js(pg, "[...document.querySelectorAll('#res-tabela tbody tr td:first-child')].map(t=>t.textContent)")
    assert meses()[0] == 'jan/26' and len(meses()) == 12
    assert js(pg, "$('#res-tabela tr.atual td').textContent") == 'nov/26'
    pg.click('#res-tabela th[data-ord="fat"]'); passo(pg, 100)
    assert meses()[:3] == ['nov/26', 'mar/26', 'jul/26'], 'maior faturado primeiro'
    pg.click('#res-tabela th[data-ord="fat"]'); passo(pg, 100)
    assert meses()[-1] == 'nov/26'
    total = js(pg, "[...document.querySelectorAll('#res-tabela tfoot td')].map(t=>t.textContent)")
    assert total[:4] == ['Total', '5', '72h', js(pg, "brl(13800)")]


def test_exportar_planilha(abrir):
    pg = abrir_resumo(abrir)
    rodar(pg, "navigator.canShare = () => true; navigator.share = async d => { window.__csv = await d.files[0].text(); window.__nome = d.files[0].name; };")
    pg.click('#res-csv'); passo(pg, 300); pg.wait_for_timeout(200)
    assert js(pg, "__nome") == 'plantae-2026-01_a_2026-12.csv'
    csv = js(pg, "__csv")
    linhas = csv.lstrip('﻿').split('\r\n')
    assert linhas[0].startswith('Mês;Plantões;Horas;Plantões (R$);Entradas fixas (R$);Faturado (R$)')
    assert linhas[11] == 'nov/2026;2;24;3250,00;4000,00;7250,00;4000,00;3250,00;135,42'
    assert any(l.startswith('12/11/2026;Hospital Felício Rocho;Residência;noturno;19:00;12;0,00') for l in linhas)
    assert any(';Entrada fixa;' in l for l in linhas) and not any('Bia' in l or '21/11/2026' in l for l in linhas), 'passei fica fora'


def test_cartao_de_trocas_abre_a_lista(abrir):
    pg = abrir_resumo(abrir)
    assert '1 pego · 1 passado · saldo 0' in pg.inner_text('#res-trocas')
    pg.click('#res-trocas-btn'); passo(pg, 300)
    txt = js(pg, "$('#sheet-detail').textContent")
    assert 'Peguei (1)' in txt and 'de Ana' in txt and 'Passei (1)' in txt and 'para Bia' in txt


def test_resumo_cabe_na_tela_do_galaxy(abrir):
    pg = abrir_resumo(abrir, aparelho='galaxy_s25ultra')
    pg.click('#res-meses rect[data-mes="2026-10"]', force=True); passo(pg, 200)
    assert js(pg, "document.scrollingElement.scrollWidth <= innerWidth")
    assert js(pg, "(w => w.scrollWidth <= w.clientWidth + 1)(document.querySelector('#res-locais .tab-wrap'))"), 'tabela por local sem rolagem lateral'
    assert js(pg, "(s => s.getBoundingClientRect().width <= s.parentElement.clientWidth + 1)(document.querySelector('#res-calor svg'))")
    vazando = js(pg, """[...document.querySelectorAll('#res-meses .mes-info span')].filter(s => s.scrollWidth > s.clientWidth + 1).map(s=>s.textContent)""")
    assert vazando == [], f'nomes cortados no detalhe do mês: {vazando}'


def test_resumo_sem_dados(abrir):
    pg = abrir()
    rodar(pg, "S.shifts = []; await store.save(S); render();"); passo(pg, 200)
    pg.click('nav button[data-v="resumo"]'); passo(pg, 300)
    for rp in ['mes', '3m', 'ano', 'tudo']:
        pg.click(f'[data-rp="{rp}"]'); passo(pg, 150)
    assert 'Nenhum plantão' in pg.inner_text('#res-locais')
    assert js(pg, "gerarCanvasAno(dadosAno(2026)).height") == 1350


def _textos_do_canvas(pg, opcoes):
    r = js(pg, f"""(() => {{ const t = [], f = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function(s, ...r){{ t.push(String(s)); return f.call(this, s, ...r); }};
        const c = gerarCanvasAno(dadosAno(2026), {opcoes});
        CanvasRenderingContext2D.prototype.fillText = f; return {{ w: c.width, h: c.height, t, fim: +c.dataset.fim, rodape: +c.dataset.rodape }}; }})()""")
    assert r['fim'] < r['rodape'], f"conteúdo encosta no rodapé ({r['fim']} ≥ {r['rodape']})"
    return r


def test_imagem_do_ano_post_stories_e_discreto(abrir):
    pg = abrir_resumo(abrir)
    post = _textos_do_canvas(pg, "{formato:'post'}")
    assert (post['w'], post['h']) == (1080, 1350)
    assert js(pg, "brl(13800)") in post['t'] and 'Onde mais trabalhei' in post['t'] and 'Dias de plantão' in post['t']
    assert any('vs 2025' in t for t in post['t'])
    st = _textos_do_canvas(pg, "{formato:'stories'}")
    assert (st['w'], st['h']) == (1080, 1920)
    disc = _textos_do_canvas(pg, "{formato:'post', discreto:true}")
    assert not [t for t in disc['t'] if 'R$' in t], 'modo discreto não mostra dinheiro'
    assert '72h' in disc['t'] and 'NOITES VIRADAS' in [t.upper() for t in disc['t']]


def test_compartilhar_respeita_formato_e_discreto(abrir):
    pg = abrir_resumo(abrir)
    rodar(pg, "navigator.canShare = () => true; navigator.share = async d => { window.__nome = d.files[0].name; };")
    pg.click('#wrapped-btn'); passo(pg, 1800); pg.wait_for_timeout(600); passo(pg, 100)
    assert js(pg, "$('#wr-previa').getAttribute('src') || ''").startswith('data:image/png')
    pg.click('#wr-formato [data-fmt="stories"]'); passo(pg, 200)
    pg.click('#wr-discreto'); passo(pg, 200); pg.wait_for_timeout(300)
    assert js(pg, "$('#wr-previa').classList.contains('stories')")
    pg.click('#wr-share'); passo(pg, 500); pg.wait_for_timeout(500); passo(pg, 300)
    assert js(pg, "window.__nome") == 'plantae-2026-stories-discreto.png'


def test_imagem_do_ano_cabe_com_tres_locais_e_nomes_longos(abrir):
    pg = abrir_resumo(abrir)
    rodar(pg, """S.locais.push({id:'L1', nome:'Hospital Universitário de Clínicas e Pronto-Socorro Regional'}, {id:'L2', nome:'Clínica Ortopédica Central'});
      ['L1','L2','L1'].forEach((l,i) => S.shifts.push({id:'Q'+i, categoria:'remunerado', data:`2026-0${i+4}-15`, hora:'07:00', duracao:12, turno:'diurno',
        localId:l, valor:2000, liquido:2000, pago:false, tipo:'meu'}));""")
    for op in ["{formato:'post'}", "{formato:'stories'}", "{formato:'post', discreto:true}", "{formato:'stories', discreto:true}"]:
        r = _textos_do_canvas(pg, op)
        assert any(t.endswith('…') for t in r['t']), 'nome longo encurtado'
