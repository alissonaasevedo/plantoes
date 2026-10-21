"""Galaxy S25+ (Android/Chrome): layout, gesto Voltar, vibração, atalhos, avisos, ícones, migração."""
import json
import pathlib

import pytest
from PIL import Image

from conftest import RAIZ, passo, js, rodar

GALAXY = 'galaxy_s25plus'
ABAS = ['mes', 'caixa', 'resumo', 'locais', 'ajustes']


@pytest.mark.parametrize('tema,paleta', [('light', None), ('dark', None), ('dark', 'fintech'), ('light', 'diaenoite')])
def test_galaxy_nenhuma_aba_rola_para_o_lado(abrir, tema, paleta):
    pg = abrir(aparelho=GALAXY, tema=tema, paleta=paleta)
    assert js(pg, "SO") == 'android'
    for aba in ABAS:
        pg.click(f'nav button[data-v="{aba}"]'); passo(pg, 300)
        assert js(pg, "document.documentElement.scrollWidth") <= 385, f'aba {aba} rola para o lado'


def test_voltar_fecha_sheet_sem_sair_do_app(abrir):
    pg = abrir(aparelho=GALAXY)
    pg.click('#shift-list .shift >> nth=0')
    pg.wait_for_timeout(700)   # a transição card → sheet roda no ritmo real da tela, não no relógio simulado
    assert js(pg, "$('#sheet').classList.contains('open')")
    pg.go_back(); passo(pg, 400)
    assert not js(pg, "!!document.querySelector('.sheet.open')")
    assert 'index.html' in pg.url and js(pg, "!!$('#h-total')"), 'o app continua aberto'
    assert js(pg, "document.body.style.position") == '', 'rolagem destravada'


def test_fechar_pela_tela_nao_deixa_entrada_no_historico(abrir):
    pg = abrir(aparelho=GALAXY)
    pg.click('#shift-list .shift >> nth=0'); pg.wait_for_timeout(700)
    assert js(pg, "$('#sheet').classList.contains('open')")
    pg.click('#sh-close'); passo(pg, 400)
    assert js(pg, "history.state") is None


def test_voltar_fecha_menu_do_mais_e_volta_para_mes(abrir):
    pg = abrir(aparelho=GALAXY)
    pg.click('#fab'); passo(pg, 300)
    pg.go_back(); passo(pg, 300)
    assert not js(pg, "!!$('#fab-menu')")
    pg.click('nav button[data-v="caixa"]'); passo(pg, 300)
    pg.go_back(); passo(pg, 400)
    assert js(pg, "view") == 'mes'


def test_voltar_fecha_uma_camada_por_vez(abrir):
    pg = abrir(aparelho=GALAXY)
    pg.click('nav button[data-v="resumo"]'); passo(pg, 300)
    pg.click('#wrapped-btn'); passo(pg, 1800)
    rodar(pg, "mostrarImagemOverlay('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 2026)"); passo(pg, 200)
    pg.go_back(); passo(pg, 300)
    assert not js(pg, "!!$('#img-overlay')") and js(pg, "$('#wrapped-sheet').classList.contains('open')")
    pg.go_back(); passo(pg, 300)
    assert not js(pg, "$('#wrapped-sheet').classList.contains('open')")


def test_vibracao_funciona_e_pode_desligar(abrir):
    pg = abrir(aparelho=GALAXY)
    rodar(pg, "window.__vib = []; navigator.vibrate = ms => { window.__vib.push(ms); return true; };")
    pg.click('#shift-list [data-pay] >> nth=0'); passo(pg, 400)
    assert js(pg, "__vib.length") >= 1 and min(js(pg, "__vib")) >= 10
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#pref-vibrar'); passo(pg, 100)
    rodar(pg, "window.__vib = []; haptic(12)")
    assert js(pg, "__vib.length") == 0


@pytest.mark.parametrize('acao,checar', [
    ('?action=buscar', "$('#sheet-detail').classList.contains('open') && !!$('#busca-q')"),
    ('?action=novo', "$('#sheet').classList.contains('open') && !editing"),
])
def test_atalhos_do_icone(abrir, acao, checar):
    pg = abrir(aparelho=GALAXY, query=acao)
    passo(pg, 500)
    assert js(pg, checar)
    assert 'action=' not in pg.url, 'a URL é limpa: recarregar não reabre'


def test_aviso_tocado_abre_o_plantao(abrir):
    from conftest import BACKUP
    sid = BACKUP['shifts'][5]['id']
    pg = abrir(aparelho=GALAXY, query=f'?action=plantao&id={sid}')
    passo(pg, 500)
    assert js(pg, f"$('#sheet').classList.contains('open') && editing && editing.id === '{sid}'")


def test_aviso_usa_icone_monocromatico_e_aponta_o_plantao(abrir):
    pg = abrir(aparelho=GALAXY, notificacoes=True)
    rodar(pg, """window.__o = null;
        Object.defineProperty(navigator, 'serviceWorker', { configurable:true, value: {
          getRegistration: async () => ({ showNotification: async (t, o) => { window.__o = o; } }),
          addEventListener(){} } });""")
    rodar(pg, "await dispararAviso({ tag:'ini:ABC:1', title:'Plantão em 1 hora', body:'teste' })")
    o = js(pg, "__o")
    assert o['badge'].endswith('icons/badge-96.png')
    assert o['vibrate'] == [120, 60, 120]
    assert o['data']['sid'] == 'ABC' and 'action=plantao' in o['data']['url']


def test_textos_e_caminhos_do_android(abrir):
    pg = abrir(aparelho=GALAXY)
    assert 'Aplicativos' in js(pg, "caminhoNotif()")
    rodar(pg, "openCal(S.shifts.find(s=>s.hora))"); passo(pg, 300)
    assert 'Samsung' in pg.inner_text('#c-apple')
    assert 'interactive-widget=resizes-content' in js(pg, "document.querySelector('meta[name=viewport]').content")


def test_iphone_continua_com_textos_do_iphone(abrir):
    pg = abrir(aparelho='iphone')
    assert js(pg, "SO") == 'ios' and 'iPhone' in js(pg, "caminhoNotif()")


def test_enviar_backup_pelo_compartilhamento(abrir):
    pg = abrir(aparelho=GALAXY)
    rodar(pg, """window.__arq = null; navigator.canShare = () => true;
                 navigator.share = async d => { window.__arq = { nome: d.files[0].name, tipo: d.files[0].type, texto: await d.files[0].text() }; };""")
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#export-share'); passo(pg, 500)
    arq = js(pg, "__arq")
    assert arq['nome'].endswith('.json') and arq['tipo'] == 'application/json'
    assert len(json.loads(arq['texto'])['shifts']) == js(pg, "S.shifts.length")


def test_restaurar_aceita_backup_vindo_do_whatsapp(abrir):
    pg = abrir(aparelho=GALAXY)
    aceita = js(pg, "$('#file').accept")
    for tipo in ['.json', 'application/octet-stream', 'text/plain']:
        assert tipo in aceita


def test_manifesto_e_icones_para_android():
    m = json.loads((RAIZ / 'manifest.json').read_text(encoding='utf-8'))
    assert m['background_color'].upper() == '#F8F9FA'
    propositos = {i['purpose'] for i in m['icons']}
    assert {'any', 'maskable', 'monochrome'} <= propositos
    for ic in m['icons'] + [s for s in m.get('screenshots', [])]:
        arq = RAIZ / ic['src']
        assert arq.exists(), f'{ic["src"]} não existe'
        w, h = map(int, ic['sizes'].split('x'))
        assert Image.open(arq).size == (w, h), f'{ic["src"]} com tamanho diferente do declarado'
    for ic in m['icons']:
        im = Image.open(RAIZ / ic['src']).convert('RGBA')
        if ic['purpose'] == 'maskable':
            assert im.getpixel((2, 2))[3] == 255, 'ícone adaptativo precisa de fundo sólido (sem canto transparente)'
        if ic['purpose'] == 'monochrome':
            cores = {c[:3] for _, c in im.getcolors(maxcolors=1 << 20) if c[3] > 200}
            assert cores <= {(255, 255, 255)}, 'ícone monocromático deve ser só branco'
    for atalho in m['shortcuts']:
        assert atalho['url'].startswith('./?action=')


def test_botao_mais_some_ao_rolar_e_volta(abrir):
    pg = abrir(aparelho=GALAXY)
    pg.mouse.wheel(0, 900); pg.wait_for_timeout(300)
    assert js(pg, "$('#fab').classList.contains('fab-oculto')")
    pg.mouse.wheel(0, -400); pg.wait_for_timeout(300)
    assert not js(pg, "$('#fab').classList.contains('fab-oculto')")
