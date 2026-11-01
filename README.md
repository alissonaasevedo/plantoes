# Plantoes

App de organizacao de plantoes medicos: escala, valores, pagamentos e trocas.

## Avisos com o app fechado (servidor de avisos)

Sem configuração, o app avisa só enquanto está aberto. Para os avisos chegarem com o app fechado:

1. **Upstash QStash** — no painel da Vercel: projeto → *Integrations* → *Upstash* → criar um **QStash**
   e ligar ao projeto. Isso cria `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
   (e `QSTASH_URL`). Alternativa: copiar esses valores do console em upstash.com → QStash.
2. **Chaves VAPID** — gere com `npx web-push generate-vapid-keys` e cadastre em
   *Settings → Environment Variables*: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e
   `VAPID_SUBJECT` (`mailto:seu-email`). Opcional: `APP_URL` (endereço público do app).
3. **Redeploy** do projeto.
4. No celular: Ajustes → Avisos deve mostrar **"Entrega pelo servidor ✓"**; toque em *Enviar aviso de teste* e feche o app.

Como funciona: o app envia a agenda dos próximos ~6 dias para `/api/agendar`, que agenda cada aviso no QStash;
na hora certa o QStash chama `/api/enviar` (assinatura verificada), que entrega o push. Não há banco de dados:
o próprio app guarda os ids e cancela os anteriores quando a agenda muda. Abrir o app ao menos 1×/semana mantém a agenda em dia.

Testes: `pytest -q tests` (app) e `npm ci && npm run test:api` (servidor).

## Conta Google (Agenda + backup no Drive)

O app cria uma agenda **Plantaê!** na conta Google do usuário (escopo `calendar.app.created`: só mexe nas agendas que ele criou)
e guarda backups na pasta oculta do app no Drive (escopo `drive.appdata`). O login usa o modelo de código do Google:
o segredo do cliente fica só na Vercel (`/api/google/*`), e o token de renovação fica no aparelho.

1. [console.cloud.google.com](https://console.cloud.google.com) → criar um projeto (ex.: Plantaê).
2. *APIs e serviços → Biblioteca*: ativar **Google Calendar API** e **Google Drive API**.
3. *Google Auth Platform* (tela de consentimento): tipo **Externo**, nome *Plantaê!*, seu e-mail de suporte.
   Em *Acesso a dados*, adicionar os escopos `openid`, `email`, `.../auth/calendar.app.created` e `.../auth/drive.appdata`.
   Em *Público-alvo*, adicionar seu e-mail como usuário de teste — ou **Publicar app**: em modo de teste o Google faz o
   acesso expirar a cada 7 dias; publicado (sem verificação) ele não expira, mas mostra "O Google não verificou este app"
   no primeiro login (*Avançado → Acessar Plantaê!*).
4. *Clientes → Criar cliente → Aplicativo da Web*. Em **Origens JavaScript autorizadas** e em **URIs de redirecionamento**,
   coloque o endereço do app (ex.: `https://plantoes-asevedo.vercel.app`).
5. Na Vercel, *Settings → Environment Variables*: `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` → **Redeploy**.
6. No app: Ajustes → Conta Google → **Conectar** (marque as caixas da Agenda e do Drive).

Sem estas variáveis o app funciona normalmente; a seção só mostra "não configurado".
