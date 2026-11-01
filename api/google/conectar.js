// POST /api/google/conectar → troca o código do login Google por tokens
import { criarConectar } from '../_google.js';
export const POST = request => criarConectar({ env: process.env })(request);
