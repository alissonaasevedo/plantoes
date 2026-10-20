"""Layout sem rolagem lateral em celular e computador, duas colunas no desktop, e modo offline."""
import pytest

from conftest import passo, js

ABAS = ['mes', 'caixa', 'resumo', 'locais', 'ajustes']


@pytest.mark.parametrize('largura,altura,tema,paleta', [
    (390, 844, 'light', None), (390, 844, 'dark', 'fintech'), (360, 740, 'light', 'diaenoite'), (1280, 860, 'light', 'cirurgico'),
])
def test_nenhuma_aba_rola_para_o_lado(abrir, largura, altura, tema, paleta):
    pg = abrir(largura=largura, altura=altura, tema=tema, paleta=paleta)
    for aba in ABAS:
        pg.click(f'nav button[data-v="{aba}"]'); passo(pg, 300)
        larg = js(pg, "document.documentElement.scrollWidth")
        assert larg <= largura + 1, f'aba {aba} rola para o lado ({larg}px > {largura}px)'


def test_desktop_em_duas_colunas(abrir):
    pg = abrir(largura=1280, altura=860)
    a, b = js(pg, "[...document.querySelectorAll('#v-mes > .pane')].map(p=>Math.round(p.getBoundingClientRect().left))")
    assert b > a + 300


def test_abre_offline_com_service_worker(abrir):
    pg = abrir(sw=True, relogio=False)
    pg.reload(); pg.wait_for_timeout(2500)
    assert js(pg, "!!navigator.serviceWorker.controller")
    pg.context.set_offline(True)
    pg.reload(); pg.wait_for_timeout(2500)
    assert 'R$' in pg.inner_text('#h-total')
    assert js(pg, "document.fonts.check('700 20px Geist')")
    assert len(js(pg, "caches.keys()")) == 1
