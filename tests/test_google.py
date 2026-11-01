"""Conta Google: agenda Plantaê! sem duplicar, edições/exclusões refletidas, backup no Drive,
renovação do acesso. O Google e o servidor do app são simulados (tests/google_falso.py)."""
import json

from conftest import passo, js, rodar, salvo
from google_falso import GoogleFalso, GIS_FALSO


def espera(pg, ms=1500):
    """Rede simulada corre no tempo real; timers do app no relógio simulado."""
    pg.wait_for_timeout(ms); passo(pg, 100); pg.wait_for_timeout(200)


def conectar(abrir, g=None, **kw):
    g = g or GoogleFalso()
    pg = abrir(rotas=g.rotas(**{k: kw.pop(k) for k in list(kw) if k in ('refresh', 'google_cfg')}), init=GIS_FALSO, **kw)
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300); pg.wait_for_timeout(300)
    assert pg.is_visible('#g-conectar')
    pg.click('#g-conectar'); espera(pg, 2500)
    return pg, g


def esperado(pg):
    return js(pg, "S.shifts.filter(naAgenda).length + (S.bloqueios||[]).filter(b=>b&&b.ini).length")


def test_conectar_cria_agenda_e_envia_tudo_uma_vez(abrir):
    pg, g = conectar(abrir)
    conta = js(pg, "gConta()")
    assert conta['email'] == 'medico@gmail.com' and conta['refresh'] == 'rt1'
    assert len(g.agendas) == 1
    cal = next(iter(g.agendas))
    assert g.agendas[cal]['summary'] == 'Plantaê!'
    eventos = g.eventos_ativos()
    assert len(eventos) == esperado(pg) > 0
    ev = next(e for e in eventos.values() if e['id'].startswith('pl'))
    assert ev['reminders'] == {'useDefault': False, 'overrides': []}, 'sem lembrete dobrado com os avisos do app'
    assert ev['start']['timeZone'] == 'America/Sao_Paulo'
    assert 'Conectado como medico@gmail.com' in pg.inner_text('#g-status')
    assert 'evento' in pg.inner_text('#g-agenda-st')
    # sincronizar de novo não reenvia nem duplica nada
    n = len(g.escritas_agenda())
    pg.click('#g-sync'); espera(pg, 2500)
    assert len(g.escritas_agenda()) == n
    assert len(g.eventos_ativos()) == esperado(pg)


def test_editar_e_excluir_atualizam_o_evento(abrir):
    pg, g = conectar(abrir)
    alvo = js(pg, "S.shifts.filter(s=>naAgenda(s) && s.hora)[0].id")
    eid = js(pg, f"gEvId(S.shifts.find(s=>s.id==={json.dumps(alvo)}))")
    n = len(g.escritas_agenda())
    rodar(pg, f"const s=S.shifts.find(s=>s.id==={json.dumps(alvo)}); s.hora = s.hora==='19:00' ? '20:00' : '19:00'; await store.save(S); render();")
    passo(pg, 4500); espera(pg)
    novas = g.escritas_agenda()[n:]
    assert novas == [('PUT', f'/calendar/v3/calendars/{next(iter(g.agendas))}/events/{eid}'.replace('@', '%40'))] or \
        [c[0] for c in novas] == ['PUT'], novas
    assert g.eventos_ativos()[eid]['start']['dateTime'][11:16] == js(pg, f"S.shifts.find(s=>s.id==={json.dumps(alvo)}).hora")
    rodar(pg, f"S.shifts = S.shifts.filter(s=>s.id!=={json.dumps(alvo)}); await store.save(S); render();")
    passo(pg, 4500); espera(pg)
    assert eid not in g.eventos_ativos()
    assert len(g.eventos_ativos()) == esperado(pg)


def test_celular_novo_confere_a_agenda_sem_duplicar(abrir):
    pg, g = conectar(abrir)
    cal = next(iter(g.agendas))
    # evento que ficou na agenda de um plantão apagado em outro aparelho
    g.agendas[cal]['eventos']['pl' + 'XYZ'.encode().hex()] = {'id': 'pl' + 'XYZ'.encode().hex(), 'status': 'confirmed', 'extendedProperties': {'private': {'plantae': '1', 'h': 'x'}}}
    n = len(g.escritas_agenda())
    rodar(pg, "lsSet('plantoes:gcalMap', ''); await gSincronizarAgenda();")
    espera(pg)
    escritas = g.escritas_agenda()[n:]
    assert [c[0] for c in escritas] == ['DELETE'], 'só remove o evento órfão; o resto já estava igual'
    assert len(g.eventos_ativos()) == esperado(pg)


def test_agenda_apagada_no_google_e_recriada(abrir):
    pg, g = conectar(abrir)
    g.agendas.clear()
    rodar(pg, "await gSincronizarAgenda({ completo:true });"); espera(pg, 2500)
    assert len(g.agendas) == 1 and len(g.eventos_ativos()) == esperado(pg)


def test_backup_no_drive_e_restaurar(abrir):
    pg, g = conectar(abrir)
    espera(pg, 1000)
    arqs = list(g.arquivos.values())
    assert len(arqs) == 1 and arqs[0]['name'] == 'plantae-2026-10-19.json' and arqs[0]['parents'] == ['appDataFolder']
    assert len(json.loads(arqs[0]['conteudo'])['shifts']) == js(pg, "S.shifts.length")
    # novas edições no mesmo dia atualizam o mesmo arquivo
    rodar(pg, "S.shifts[0].obs = 'editado'; await store.save(S); render();")
    passo(pg, 46000); espera(pg)
    assert len(g.arquivos) == 1 and '"editado"' in next(iter(g.arquivos.values()))['conteudo']
    # restaurar: lista no Drive → toque duplo → dados de volta, cópia do que havia guardada
    n0 = js(pg, "S.shifts.length")
    rodar(pg, "S.shifts = S.shifts.slice(0, 2); await store.save(S); render();")
    pg.click('#g-restaurar'); espera(pg, 800)
    assert js(pg, "$('#sheet-detail').classList.contains('open')") and 'Backups no Drive' in pg.inner_text('#sd-title')
    pg.click('[data-gbk] >> nth=0'); pg.click('[data-gbk] >> nth=0'); espera(pg, 1200)
    assert js(pg, "S.shifts.length") == n0 and len(salvo(pg)['shifts']) == n0
    assert len(js(pg, "JSON.parse(localStorage.getItem('plantoes:pre-restauracao')).shifts")) == 2


def test_backup_nunca_envia_dados_vazios(abrir):
    pg, g = conectar(abrir)
    espera(pg, 800)
    antes = next(iter(g.arquivos.values()))['conteudo']
    rodar(pg, "S.shifts = []; S.locais = []; await gBackupDrive({ forcar:true });"); espera(pg, 800)
    assert next(iter(g.arquivos.values()))['conteudo'] == antes


def test_token_vencido_renova_sozinho_e_expirado_pede_conectar(abrir):
    pg, g = conectar(abrir)
    rodar(pg, "_gAcesso = { t:'velho', exp: Date.now() - 1000 }; S.shifts[0].obs='x'; await store.save(S);")
    passo(pg, 4500); espera(pg)
    assert ('POST', '/api/google/renovar') in g.chamadas
    assert js(pg, "_gAcesso.t") == g.token_valido
    # acesso revogado na conta Google: para de tentar e pede para conectar de novo
    g.renovar_status = 401
    rodar(pg, "_gAcesso = null; S.shifts[0].obs='y'; await store.save(S);")
    passo(pg, 4500); espera(pg)
    assert js(pg, "gConta().expirado") is True
    assert 'expirou' in pg.inner_text('#g-status') and pg.is_visible('#g-conectar')


def test_celular_vazio_oferece_trazer_o_backup(abrir):
    g = GoogleFalso()
    g.arquivos['velho'] = {'name': 'plantae-2026-10-18.json', 'parents': ['appDataFolder'],
                           'conteudo': json.dumps({'v': 3, 'shifts': [{'id': 'Z1', 'data': '2026-10-25', 'hora': '19:00', 'duracao': 12, 'categoria': 'remunerado', 'localId': 'L1', 'valor': 900, 'liquido': 900, 'tipo': 'meu'}], 'locais': [{'id': 'L1', 'nome': 'UPA Teste'}]}),
                           'modifiedTime': '2026-10-18T10:00:00Z'}
    pg = abrir(dados=None, rotas=g.rotas(), init=GIS_FALSO)
    rodar(pg, "document.getElementById('welcome') && document.getElementById('welcome').remove(); gConectar();")
    espera(pg, 2500)
    assert 'Backups no Drive' in pg.inner_text('#sd-title')
    pg.click('[data-gbk] >> nth=0'); pg.click('[data-gbk] >> nth=0'); espera(pg, 2500)
    assert js(pg, "S.shifts.map(s=>s.id)") == ['Z1']
    assert len(g.eventos_ativos()) == 1, 'depois de restaurar, a agenda é montada'


def test_desconectar_revoga_e_limpa(abrir):
    pg, g = conectar(abrir)
    pg.click('#g-sair'); pg.click('#g-sair'); espera(pg, 800)
    assert ('POST', '/api/google/sair') in g.chamadas
    assert js(pg, "gConta()") is None and pg.is_visible('#g-conectar')


def test_sem_configuracao_no_servidor_mostra_o_motivo(abrir):
    g = GoogleFalso()
    pg = abrir(rotas=g.rotas(google_cfg=None))
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300); pg.wait_for_timeout(400)
    assert 'não configurado' in pg.inner_text('#g-status') and not pg.is_visible('#g-conectar')


def test_google_pedindo_calma_espera_e_tenta_de_novo(abrir):
    g = GoogleFalso()
    original = g.api
    estado = {'recusas': 0}
    def api(route):
        if route.request.method == 'POST' and '/events' in route.request.url and estado['recusas'] < 2:
            estado['recusas'] += 1
            g.chamadas.append(('POST-recusado', ''))
            return route.fulfill(status=403, content_type='application/json',
                                 body=json.dumps({'error': {'errors': [{'reason': 'rateLimitExceeded'}]}}), headers={'access-control-allow-origin': '*'})
        return original(route)
    g.api = api
    pg = abrir(rotas=g.rotas(), init=GIS_FALSO)
    rodar(pg, "gConectar()")
    for _ in range(8):
        pg.wait_for_timeout(700); passo(pg, 2500)
    assert estado['recusas'] == 2
    assert len(g.eventos_ativos()) == esperado(pg)
