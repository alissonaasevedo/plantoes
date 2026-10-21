// GET /api/config → diz ao app se o servidor de avisos está configurado
import { configurado, json } from './_lib.js';

export function GET() {
  const ativo = configurado(process.env);
  return json({ ativo, vapidPublica: ativo ? process.env.VAPID_PUBLIC_KEY : null });
}
