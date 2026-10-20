"""Base dos testes do Plantaê!

Sobe um servidor local com o app, abre o Chromium via Playwright e entrega a
fixture `abrir(...)`, que cria uma aba com dados, relógio, tema e paleta
controlados. Qualquer erro de JavaScript na página reprova o teste.

Rodar:  pip install -r tests/requirements.txt
        python -m playwright install chromium
        pytest -q tests
"""
import datetime as dt
import functools
import http.server
import json
import pathlib
import threading
from zoneinfo import ZoneInfo

import pytest
from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parent.parent
BACKUP = json.loads((RAIZ / 'tests' / 'fixtures' / 'backup.json').read_text(encoding='utf-8'))
SP = ZoneInfo('America/Sao_Paulo')
HOJE_14H = dt.datetime(2026, 10, 19, 14, 0, tzinfo=SP)


def quando(dia, hora, minuto=0, mes=10):
    return dt.datetime(2026, mes, dia, hora, minuto, tzinfo=SP)


class _Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope='session')
def base_url():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(_Silencioso, directory=str(RAIZ)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_address[1]}'
    srv.shutdown()


@pytest.fixture(scope='session')
def navegador():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def abrir(navegador, base_url):
    """abrir(dados=BACKUP, hora=HOJE_14H, largura=390, altura=844, tema='light',
    paleta=None, sw=False, notificacoes=False, relogio=True, ls=None) -> page"""
    contextos, erros = [], []

    def _abrir(dados=BACKUP, hora=HOJE_14H, largura=390, altura=844, tema='light', paleta=None,
               sw=False, notificacoes=False, relogio=True, ls=None):
        movel = largura < 900
        ctx = navegador.new_context(viewport={'width': largura, 'height': altura}, is_mobile=movel, has_touch=movel,
                                    timezone_id='America/Sao_Paulo', color_scheme=tema,
                                    service_workers='allow' if sw else 'block')
        if notificacoes:
            # o Chromium sem tela sempre nega notificações; simula a permissão concedida
            ctx.add_init_script("Object.defineProperty(Notification,'permission',{get:()=>'granted'});")
        if dados is not None:
            ctx.add_init_script(
                f"if(!localStorage.getItem('plantoes:v2')) localStorage.setItem('plantoes:v2', {json.dumps(json.dumps(dados))});")
        if paleta:
            ctx.add_init_script(f"localStorage.setItem('plantoes:paleta', {json.dumps(paleta)});")
        for k, v in (ls or {}).items():
            ctx.add_init_script(f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)});")
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: erros.append(str(e)))
        if relogio:
            pg.clock.install(time=hora)
        pg.goto(base_url + '/index.html')
        if relogio:
            pg.clock.run_for(2500)
        else:
            pg.wait_for_timeout(2500)
        contextos.append(ctx)
        return pg

    yield _abrir
    for c in contextos:
        c.close()
    assert not erros, f'Erros de JavaScript na página: {erros}'


def passo(pg, ms=250):
    """Avança o relógio simulado (timers e animações por JS)."""
    pg.clock.run_for(ms)


def js(pg, expr):
    """Avalia uma expressão sem o Playwright executar funções retornadas por engano."""
    return pg.evaluate(f"(()=>{{ return ({expr}); }})()")


def rodar(pg, codigo):
    """Executa comandos JS (sem valor de retorno)."""
    pg.evaluate(f"(async ()=>{{ {codigo} }})()")


def salvo(pg):
    """Dados como estão gravados no aparelho."""
    return js(pg, "JSON.parse(localStorage.getItem('plantoes:v2'))")
