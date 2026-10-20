"""Versão dos dados e migrações, histórico de alterações, diagnóstico."""
import json

from conftest import BACKUP, passo, js, rodar, salvo

LEGADO = {   # formato antigo: sem "v", bloqueio dentro de shifts, números como texto
    'shifts': [
        {'id': 'blq', 'categoria': 'bloqueio', 'data': '2026-01-05', 'blTipo': 'viagem', 'blFim': '2026-01-07'},
        {'id': 'b', 'data': '2026-01-10', 'hora': '07:00', 'duracao': '12', 'valor': '1200', 'liquido': '',
         'localId': 'L', 'turno': 'diurno', 'tipo': 'meu', 'notas': 'texto inválido'},
        {'id': 'c', 'data': '2026-01-11', 'hora': '19:00', 'duracao': 12, 'valor': 1350, 'localId': 'L',
         'turno': 'noturno', 'tipo': 'meu', 'notas': [{'h': '20:00', 'txt': 'ok'}, {'txt': ''}, None]},
    ],
    'locais': [{'id': 'L', 'nome': 'Hospital X', 'vDia': '1200', 'vNoite': '1350'}],
    'metaMensal': '9000',
}


def test_migracao_do_formato_antigo(abrir):
    pg = abrir(dados=LEGADO)
    s = salvo(pg)
    assert s['v'] == js(pg, "SCHEMA")
    assert [b['id'] for b in s['bloqueios']] == ['blq'] and s['bloqueios'][0]['motivo'] == 'viagem'
    assert all(x['categoria'] != 'bloqueio' for x in s['shifts'])
    b = next(x for x in s['shifts'] if x['id'] == 'b')
    assert b['valor'] == 1200 and b['duracao'] == 12 and b['liquido'] == '' and b['notas'] == []
    c = next(x for x in s['shifts'] if x['id'] == 'c')
    assert [n['txt'] for n in c['notas']] == ['ok']
    assert s['locais'][0]['vDia'] == 1200 and s['metaMensal'] == 9000
    copia = js(pg, "localStorage.getItem('plantoes:pre-migracao-v0')")
    assert copia and json.loads(copia)['metaMensal'] == '9000', 'cópia de segurança do original'


def test_migracao_e_idempotente(abrir):
    pg = abrir(dados=LEGADO)
    antes = salvo(pg)
    pg.reload(); passo(pg, 2500)
    assert salvo(pg) == antes


def test_dados_de_versao_mais_nova_nao_sao_alterados(abrir):
    pg = abrir(dados=BACKUP | {'v': 99})
    assert js(pg, "S.v") == 99


def test_backup_de_versao_mais_nova_e_recusado(abrir, tmp_path):
    pg = abrir()
    n0 = js(pg, "S.shifts.length")
    f = tmp_path / 'futuro.json'
    f.write_text(json.dumps({'v': 99, 'shifts': [], 'locais': []}), encoding='utf-8')
    pg.set_input_files('#file', str(f)); passo(pg, 500)
    assert js(pg, "S.shifts.length") == n0


def test_historico_registra_e_desfaz(abrir):
    pg = abrir()
    sid = js(pg, "S.shifts.find(s=>counts(s) && !s.pago).id")
    rodar(pg, f"const s = S.shifts.find(x=>x.id==='{sid}'); s.pago = true; s.pagoEm = '2026-10-19'; await store.save(S); render();")
    passo(pg, 300)
    hist = js(pg, "histLer()")
    assert hist[-1]['desc'].startswith('Confirmou recebimento')
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 400)
    pg.click('#hist-lista [data-hist-undo] >> nth=0'); passo(pg, 400)
    assert js(pg, f"S.shifts.find(x=>x.id==='{sid}').pago") is False
    assert js(pg, "histLer().slice(-1)[0].desc").startswith('Desfez')


def test_historico_agrupa_lote_e_desfaz_tudo(abrir):
    pg = abrir()
    n0 = js(pg, "S.shifts.length")
    rodar(pg, "openSheet(null,'2026-11-14','remunerado')"); passo(pg)
    pg.select_option('#f-rep', 'sem'); pg.fill('#f-rep-ate', '2026-12-12'); pg.dispatch_event('#f-rep-ate', 'input')
    rodar(pg, "conflitoOk = true"); pg.click('#sh-save'); passo(pg, 500)
    assert js(pg, "S.shifts.length") == n0 + 5
    ult = js(pg, "histLer().slice(-1)[0]")
    assert ult['desc'].startswith('Lançou 5 lançamentos') and len(ult['ops']) == 5
    rodar(pg, f"await desfazerHistorico('{ult['id']}')"); passo(pg, 300)
    assert js(pg, "S.shifts.length") == n0


def test_abrir_o_app_nao_gera_historico(abrir):
    pg = abrir()
    pg.reload(); passo(pg, 2500)
    assert js(pg, "histLer().length") == 0


def test_diagnostico_captura_e_relata_sem_dados_pessoais(abrir):
    pg = abrir()
    rodar(pg, "window.dispatchEvent(new ErrorEvent('error', { error: new Error('falha de teste'), message:'falha de teste', filename:'app.js', lineno:42 }));")
    rodar(pg, "registrarErro(new Error('falha de teste'), 'app.js:42')")   # repetido → conta 2×
    lista = js(pg, "JSON.parse(localStorage.getItem('plantoes:diag'))")
    assert len(lista) == 1 and lista[0]['n'] == 2 and lista[0]['msg'] == 'falha de teste'
    rel = js(pg, "relatorioDiagnostico()")
    assert 'falha de teste' in rel and f"v{js(pg, 'APP_VERSAO')}" in rel
    for nome in ['São Benedito', 'Acrízio', 'R$']:
        assert nome not in rel, f'relatório não deve conter "{nome}"'
    pg.click('nav button[data-v="ajustes"]'); passo(pg, 300)
    assert 'erro' in pg.inner_text('#diag-status')
    pg.click('#diag-limpar'); passo(pg, 200)
    assert 'Nenhum erro' in pg.inner_text('#diag-status')
