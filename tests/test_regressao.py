"""Bugs já corrigidos que não podem voltar (auditorias v1.14 e v1.18)."""
from conftest import BACKUP, passo, js, rodar, salvo


def test_metas_sobrevivem_a_recarga(abrir):
    dados = BACKUP | {'metaMensal': 20000, 'metaAnual': 250000}
    pg = abrir(dados=dados)
    pg.reload(); passo(pg, 2500)
    assert salvo(pg)['metaMensal'] == 20000
    assert salvo(pg)['metaAnual'] == 250000


def test_checklist_confirma_e_nao_desfaz_no_mesmo_toque(abrir):
    pg = abrir()
    item = pg.query_selector('#h-checklist [data-cxpay]')
    assert item, 'checklist deveria ter pendências com o backup de teste'
    sid = item.get_attribute('data-cxpay')
    item.click(); passo(pg, 400)
    assert js(pg, f"S.shifts.find(s=>s.id==='{sid}').pago") is True


def test_sheets_aninhados_preservam_scroll(abrir):
    pg = abrir()
    rodar(pg, "window.scrollTo(0,600)"); passo(pg)
    y0 = js(pg, "scrollY")
    rodar(pg, "openSheet(S.shifts[5]); openLocal(S.locais[0])"); passo(pg)
    pg.click('#scrim', position={'x': 10, 'y': 10}); passo(pg, 300)
    assert js(pg, "scrollY") == y0
    assert js(pg, "document.body.style.position") == ''


def test_fundo_fecha_bloqueio_e_esc_fecha_sheet(abrir):
    pg = abrir()
    rodar(pg, "openBloqueio(null)"); passo(pg)
    pg.click('#scrim', position={'x': 10, 'y': 10}); passo(pg, 300)
    assert not js(pg, "$('#sheet-bl').classList.contains('open')")
    rodar(pg, "openSheet(null)"); pg.keyboard.press('Escape'); passo(pg)
    assert not js(pg, "!!document.querySelector('.sheet.open')")


def test_csv_padrao_excel_brasileiro(abrir):
    pg = abrir()
    csv = js(pg, "gerarCSV(S.shifts)")
    assert '&amp;' not in csv
    cab, linha = csv.split('\r\n')[:2]
    assert cab.startswith('Data;Local;')
    assert ',' in linha.split(';')[5]          # vírgula decimal


def test_plurais(abrir):
    pg = abrir()
    rodar(pg, "renderWrapped()")
    assert 'plantões registrados' in pg.inner_text('#wr-sub')
    assert 'plantãoões' not in js(pg, "document.body.innerHTML")


def test_urgente_nao_vale_para_residencia(abrir):
    pg = abrir()
    rodar(pg, """openSheet(null,'2026-12-01','residencia'); $('#f-urgente').classList.add('on');
                 conflitoOk = true; await saveShift();""")
    passo(pg, 300)
    assert js(pg, "S.shifts[S.shifts.length-1].urgente") is False


def test_menu_do_mais_abre_e_fecha(abrir):
    pg = abrir()
    pg.click('#fab'); passo(pg, 300)
    assert js(pg, "!!$('#fab-menu')")
    pg.mouse.click(30, 300); passo(pg, 300)
    assert not js(pg, "!!$('#fab-menu')")


def test_compartilhar_ano_dispara_uma_vez(abrir):
    pg = abrir()
    rodar(pg, "window.__n = 0; window.compartilharAno = () => { window.__n++; };")
    pg.click('nav button[data-v="resumo"]'); passo(pg, 400)
    pg.click('#wrapped-btn'); passo(pg, 1800)
    pg.click('#wr-share'); passo(pg, 300)
    assert js(pg, "__n") == 1


def test_meta_com_centavos_nao_vira_numero_enorme(abrir):
    pg = abrir()
    pg.click('nav button[data-v="caixa"]'); passo(pg, 400)
    if not js(pg, "!!$('#cx-meta-anual-btn')"):
        return  # sem 3 meses de histórico o botão não aparece
    pg.click('#cx-meta-anual-btn'); passo(pg, 300)
    pg.fill('#fs-v', '250000.50'); pg.click('#fs-ok'); passo(pg, 400)
    assert js(pg, "S.metaAnual") == 250000.5


def test_resumo_mostra_bloco_do_ano(abrir):
    pg = abrir()
    pg.click('nav button[data-v="resumo"]'); passo(pg, 400)
    assert js(pg, "$('#yr').textContent") == '2026'
    assert js(pg, "document.querySelectorAll('#year-stats .row').length") >= 4


def test_caixa_nome_e_data_em_linhas_separadas(abrir):
    pg = abrir()
    pg.click('nav button[data-v="caixa"]'); passo(pg, 400)
    disp = js(pg, "getComputedStyle(document.querySelector('.tl-cx-top .txt small')).display")
    assert disp == 'block'


def test_banner_proxima_entrada_soma_so_a_data(abrir):
    pg = abrir()
    esperado = js(pg, """(()=>{ const t=iso(hoje()); const p=S.shifts.filter(s=>counts(s)&&!s.pago&&vencimento(s)>=t);
                      const d=p.map(vencimento).sort()[0]; return brl(p.filter(s=>vencimento(s)===d).reduce((a,s)=>a+liq(s),0)); })()""")
    assert esperado in pg.inner_text('#h-banner-prox')
