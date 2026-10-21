// POST /api/agendar → agenda os próximos avisos do aparelho no QStash
import { Client } from '@upstash/qstash';
import { configurado, criarAgendar, json } from './_lib.js';

export async function POST(request) {
  if (!configurado(process.env)) return json({ erro: 'servidor de avisos não configurado' }, 503);
  const qstash = new Client({ token: process.env.QSTASH_TOKEN, ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}) });
  const origem = (process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');
  return criarAgendar({ qstash, destino: origem + '/api/enviar' })(request);
}
