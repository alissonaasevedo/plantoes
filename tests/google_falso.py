"""Google simulado para os testes: Agenda (agendas e eventos) e Drive (pasta oculta do app),
com as mesmas respostas que importam da API real (404, 409, 410, cancelados)."""
import json
import re
from urllib.parse import urlparse, parse_qs

GIS_FALSO = """window.google = { accounts: { oauth2: { initCodeClient: cfg => ({
  requestCode(){ window.__gisCfg = cfg; setTimeout(() => cfg.callback({ code: 'codigo-teste' }), 5); } }) } } };"""

ESCOPOS = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/drive.appdata']


class GoogleFalso:
    def __init__(self):
        self.agendas = {}          # id -> {eventos: {id: corpo}}
        self.arquivos = {}         # id -> {name, conteudo, modifiedTime}
        self.chamadas = []         # (metodo, caminho)
        self.token_valido = 'at1'
        self.renovar_status = 200
        self.n = 0
        self.escopos_login = ESCOPOS        # o que /api/google/conectar devolve
        self.escopos_reais = ESCOPOS        # o que o token de fato tem (tokeninfo)

    # ---------- servidor do app ----------
    def rotas(self, google_cfg='cid.apps.googleusercontent.com', refresh='rt1'):
        def config(route):
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ativo': False, 'vapidPublica': None, 'google': google_cfg}))
        def conectar(route):
            self.chamadas.append(('POST', '/api/google/conectar'))
            route.fulfill(status=200, content_type='application/json', body=json.dumps({
                'access_token': self.token_valido, 'expires_in': 3600, 'refresh_token': refresh,
                'email': 'medico@gmail.com', 'escopos': self.escopos_login}))
        def renovar(route):
            self.chamadas.append(('POST', '/api/google/renovar'))
            if self.renovar_status != 200:
                route.fulfill(status=self.renovar_status, content_type='application/json', body=json.dumps({'expirado': True}))
                return
            self.n += 1
            self.token_valido = f'at-renovado-{self.n}'
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'access_token': self.token_valido, 'expires_in': 3600}))
        def sair(route):
            self.chamadas.append(('POST', '/api/google/sair'))
            route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
        def tokeninfo(route):
            self.chamadas.append(('GET', '/tokeninfo'))
            route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                          body=json.dumps({'scope': ' '.join(self.escopos_reais), 'expires_in': '3500'}))
        return {'https://oauth2.googleapis.com/tokeninfo**': tokeninfo, '**/api/config': config, '**/api/google/conectar': conectar, '**/api/google/renovar': renovar,
                '**/api/google/sair': sair, 'https://www.googleapis.com/**': self.api}

    # ---------- APIs do Google ----------
    def _resp(self, route, status, corpo=None):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(corpo or {}),
                      headers={'access-control-allow-origin': '*'})

    def escritas_agenda(self):
        return [c for c in self.chamadas if c[0] in ('PUT', 'POST', 'DELETE') and '/calendar/' in c[1] and not c[1].endswith('/calendars')]

    def eventos_ativos(self, cal=None):
        cal = cal or next(iter(self.agendas))
        return {i: e for i, e in self.agendas[cal]['eventos'].items() if e.get('status') != 'cancelled'}

    def api(self, route):
        req = route.request
        if req.method == 'OPTIONS':
            route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
            return
        u = urlparse(req.url); q = parse_qs(u.query); caminho = u.path
        self.chamadas.append((req.method, caminho))
        if req.headers.get('authorization') != 'Bearer ' + self.token_valido:
            return self._resp(route, 401, {'error': {'code': 401}})
        corpo = None
        if req.post_data and 'json' in (req.headers.get('content-type') or ''):
            try: corpo = json.loads(req.post_data)
            except Exception: corpo = None

        if caminho == '/calendar/v3/calendars' and req.method == 'POST':
            cid = f'cal{len(self.agendas) + 1}@group.calendar.google.com'
            self.agendas[cid] = {'eventos': {}, **corpo}
            return self._resp(route, 200, {'id': cid, 'summary': corpo['summary']})
        m = re.match(r'^/calendar/v3/calendars/([^/]+)/events(?:/([^/]+))?$', caminho)
        if m:
            cal = m.group(1).replace('%40', '@'); eid = m.group(2)
            if cal not in self.agendas:
                return self._resp(route, 404, {'error': {'code': 404}})
            ev = self.agendas[cal]['eventos']
            if req.method == 'GET' and not eid:
                itens = [e for e in ev.values() if e.get('status') != 'cancelled']
                return self._resp(route, 200, {'items': itens})
            if req.method == 'PUT':
                if eid not in ev: return self._resp(route, 404)
                ev[eid] = {**corpo, 'id': eid, 'status': 'confirmed'}
                return self._resp(route, 200, ev[eid])
            if req.method == 'POST':
                if corpo['id'] in ev: return self._resp(route, 409)
                ev[corpo['id']] = {**corpo, 'status': 'confirmed'}
                return self._resp(route, 200, ev[corpo['id']])
            if req.method == 'DELETE':
                if eid not in ev or ev[eid].get('status') == 'cancelled': return self._resp(route, 410)
                ev[eid]['status'] = 'cancelled'
                return route.fulfill(status=204, headers={'access-control-allow-origin': '*'})
        if caminho == '/drive/v3/files' and req.method == 'GET':
            lista = sorted(self.arquivos.items(), key=lambda kv: kv[1]['modifiedTime'], reverse=True)
            return self._resp(route, 200, {'files': [{'id': i, 'name': f['name'], 'modifiedTime': f['modifiedTime'], 'size': str(len(f['conteudo']))} for i, f in lista]})
        if caminho == '/upload/drive/v3/files' and req.method == 'POST':
            partes = req.post_data.split('\r\n\r\n')
            meta = json.loads(partes[1].split('\r\n')[0])
            conteudo = partes[2].rsplit('\r\n--', 1)[0]
            fid = f'arq{len(self.arquivos) + 1}'
            self.arquivos[fid] = {'name': meta['name'], 'parents': meta['parents'], 'conteudo': conteudo, 'modifiedTime': f'2026-10-19T14:{len(self.arquivos):02d}:00Z'}
            return self._resp(route, 200, {'id': fid})
        m = re.match(r'^/(upload/)?drive/v3/files/([^/]+)$', caminho)
        if m:
            fid = m.group(2)
            if fid not in self.arquivos: return self._resp(route, 404)
            if req.method == 'PATCH':
                self.arquivos[fid]['conteudo'] = req.post_data
                return self._resp(route, 200, {'id': fid})
            if req.method == 'GET' and q.get('alt') == ['media']:
                return route.fulfill(status=200, content_type='application/json', body=self.arquivos[fid]['conteudo'], headers={'access-control-allow-origin': '*'})
            if req.method == 'DELETE':
                del self.arquivos[fid]
                return route.fulfill(status=204, headers={'access-control-allow-origin': '*'})
        return self._resp(route, 400, {'error': 'rota não simulada: ' + req.method + ' ' + caminho})
