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
