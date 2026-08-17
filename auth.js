// auth.js
// Autenticação simples, sem dependências externas de criptografia —
// usa o módulo `crypto` nativo do Node (scrypt) pra gerar hash de senha.
// Sessões ficam em memória (Map). Limitação: se o servidor reiniciar,
// todo mundo precisa logar de novo — aceitável pro uso local de hoje.
// Se um dia isso for pra nuvem/produção, trocamos por um store
// persistente (tabela no banco, Redis, etc), sem mudar o resto do app.

const crypto = require('crypto');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarSenha(senha, armazenado) {
  if (!armazenado || !armazenado.includes(':')) return false;
  const [salt, hash] = armazenado.split(':');
  const tentativa = crypto.scryptSync(senha, salt, 64).toString('hex');
  const bufA = Buffer.from(hash, 'hex');
  const bufB = Buffer.from(tentativa, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// token -> { id, nome, role, login, setoresPermitidos }
const sessoes = new Map();

function criarSessao(usuario, setoresPermitidos = []) {
  const token = crypto.randomUUID();
  sessoes.set(token, {
    id: usuario.id,
    nome: usuario.nome,
    role: usuario.role,
    login: usuario.login,
    setoresPermitidos, // array de slugs, ex: ['vendas'] — admin ignora isso e vê tudo
  });
  return token;
}

function pegarSessao(token) {
  return sessoes.get(token) || null;
}

function destruirSessao(token) {
  sessoes.delete(token);
}

module.exports = { hashSenha, verificarSenha, criarSessao, pegarSessao, destruirSessao };
