// POST /api/enviar → chamado pelo QStash na hora do aviso; envia o Web Push
import { Receiver } from '@upstash/qstash';
import webpush from 'web-push';
import { configurado, criarEnviar, json } from './_lib.js';

export async function POST(request) {
  if (!configurado(process.env)) return json({ erro: 'servidor de avisos não configurado' }, 503);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:avisos@plantoes.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  return criarEnviar({ receiver, webpush })(request);
}
