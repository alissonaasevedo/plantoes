// GET /api/config → diz ao app o que está configurado no servidor
import { configurado, json } from './_lib.js';
import { googleConfigurado } from './_google.js';

export function GET() {
  const ativo = configurado(process.env);
  return json({
    ativo,
    vapidPublica: ativo ? process.env.VAPID_PUBLIC_KEY : null,
    google: googleConfigurado(process.env) ? process.env.GOOGLE_CLIENT_ID : null,
  });
}
