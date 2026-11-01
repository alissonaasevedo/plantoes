"""Layout sem rolagem lateral em celular e computador, duas colunas no desktop, e modo offline."""
import json

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


def test_service_worker_nao_guarda_respostas_do_servidor_de_avisos(abrir):
    """Antes o SW guardava /api/config na primeira vez e o app nunca via o servidor ser configurado."""
    estado = {'ativo': False}
    def config(route):
        route.fulfill(status=200, content_type='application/json',
                      body=json.dumps({'ativo': estado['ativo'], 'vapidPublica': 'B' if estado['ativo'] else None}))
    pg = abrir(sw=True, relogio=False, rotas={'**/api/config': config})
    pg.reload(); pg.wait_for_timeout(2500)
    assert js(pg, "!!navigator.serviceWorker.controller")
    ler = "fetch('./api/config').then(r=>r.json()).then(d=>d.ativo)"
    assert pg.evaluate(ler) is False
    estado['ativo'] = True
    assert pg.evaluate(ler) is True
    assert not any('/api/' in u for u in pg.evaluate("caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys())))).then(l=>l.flat().map(r=>r.url))"))


def test_service_worker_nao_guarda_erro_por_cima_da_copia_boa(abrir):
    pg = abrir(sw=True, relogio=False)
    pg.reload(); pg.wait_for_timeout(2500)
    pg.context.route('**/css/app.css', lambda r: r.fulfill(status=500, body='erro'))
    pg.evaluate("fetch('./css/app.css').then(r=>r.status)")
    pg.wait_for_timeout(300)
    guardado = pg.evaluate("caches.match('./css/app.css').then(r=>r && r.text()).then(t=>t ? t.length : 0)")
    assert guardado > 1000, 'a cópia boa do CSS continua guardada'
