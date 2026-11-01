// POST /api/google/sair → revoga o acesso do app à conta Google
import { criarSair } from '../_google.js';
export const POST = request => criarSair({ env: process.env })(request);
