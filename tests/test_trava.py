"""Trava com digital/rosto (WebAuthn com autenticador virtual do Chromium).
WebAuthn não aceita endereço IP: estes testes abrem o app por "localhost"."""
from conftest import passo, js, rodar


def leitor(pg, aprova=True):
    cdp = pg.context.new_cdp_session(pg)
    cdp.send('WebAuthn.enable')
    r = cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {
        'protocol': 'ctap2', 'transport': 'internal', 'hasResidentKey': True, 'hasUserVerification': True,
        'isUserVerified': aprova, 'automaticPresenceSimulation': True}})
    return cdp, r['authenticatorId']


def esconder(pg, oculto):
    rodar(pg, f"Object.defineProperty(document,'hidden',{{configurable:true,get:()=>{str(oculto).lower()}}}); document.dispatchEvent(new Event('visibilitychange'));")


def espera(pg, ms=900):
    passo(pg, 400); pg.wait_for_timeout(ms); passo(pg, 100)


def ligar(abrir):
    pg = abrir(host='localhost')
    cdp, aid = leitor(pg)
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    pg.click('#trava-on'); espera(pg)
    assert js(pg, "!!travaCfg()") and js(pg, "$('#trava-on').classList.contains('on')")
    return pg, cdp, aid


def test_ligar_a_trava_cadastra_e_pede_ao_abrir(abrir):
    pg, cdp, aid = ligar(abrir)
    pg.reload(); passo(pg, 100)
    assert js(pg, "document.documentElement.classList.contains('travado')"), 'trava antes de mostrar qualquer valor'
    assert pg.is_visible('#trava') and not pg.is_visible('#h-total')
    espera(pg, 1200)
    assert not js(pg, "document.documentElement.classList.contains('travado')"), 'digital aprovada destrava'
    assert pg.is_visible('#h-total')


def test_voltar_rapido_nao_pede_e_demorar_pede(abrir):
    pg, cdp, aid = ligar(abrir)
    rodar(pg, "window.__pedidos = 0; const g = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = o => { __pedidos++; return g(o); };")
    esconder(pg, True)
    assert js(pg, "document.documentElement.classList.contains('travado')"), 'esconde ao sair (miniatura dos recentes)'
    esconder(pg, False); espera(pg, 300)
    assert not js(pg, "document.documentElement.classList.contains('travado')") and js(pg, "__pedidos") == 0
    rodar(pg, "gGravar(TRAVA_KEY, { ...travaCfg(), tempo: 0 })")
    esconder(pg, True); esconder(pg, False); espera(pg)
    assert js(pg, "__pedidos") == 1 and not js(pg, "document.documentElement.classList.contains('travado')")


def test_sem_confirmar_continua_travado_mesmo_saindo_e_voltando(abrir):
    pg, cdp, aid = ligar(abrir)
    cdp.send('WebAuthn.setUserVerified', {'authenticatorId': aid, 'isUserVerified': False})
    pg.reload(); espera(pg, 1500)
    assert js(pg, "document.documentElement.classList.contains('travado')")
    pg.click('#trava-btn'); espera(pg, 1200)
    assert pg.is_visible('#trava-recad'), 'depois de um toque sem sucesso, oferece cadastrar de novo'
    esconder(pg, True); esconder(pg, False); espera(pg, 600)
    assert js(pg, "document.documentElement.classList.contains('travado')"), 'sair e voltar rápido não fura a trava'


def test_desligar_exige_confirmacao(abrir):
    pg, cdp, aid = ligar(abrir)
    cdp.send('WebAuthn.setUserVerified', {'authenticatorId': aid, 'isUserVerified': False})
    pg.click('#trava-on'); espera(pg, 1200)
    assert js(pg, "!!travaCfg()") and js(pg, "$('#trava-on').classList.contains('on')")
    cdp.send('WebAuthn.setUserVerified', {'authenticatorId': aid, 'isUserVerified': True})
    pg.click('#trava-on'); espera(pg, 1200)
    assert not js(pg, "!!travaCfg()") and not js(pg, "$('#trava-on').classList.contains('on')")


def test_trava_fora_do_backup_e_sem_suporte_avisa(abrir):
    pg = abrir()   # 127.0.0.1: sem WebAuthn válido para IP, mas a tela não quebra
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    assert pg.inner_text('#trava-hint')
    assert 'trava' not in js(pg, "JSON.stringify(S)").lower()
