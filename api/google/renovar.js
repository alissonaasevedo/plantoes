// POST /api/google/renovar → novo token de acesso a partir do token de renovação
import { criarRenovar } from '../_google.js';
export const POST = request => criarRenovar({ env: process.env })(request);
