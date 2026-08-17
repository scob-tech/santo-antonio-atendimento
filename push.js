// push.js
// Camada de notificação push (protocolo Web Push / VAPID). Avisa o
// vendedor de mensagem nova ou lead novo mesmo com o app fechado —
// funciona em Android/Chrome/desktop direto; no iPhone só depois do
// vendedor "Adicionar à Tela de Início" pelo Safari (limitação da Apple,
// não tem contorno).
//
// Sem dependência de variável de ambiente: as chaves VAPID são geradas
// sozinhas na primeira vez que o servidor sobe (ver db.js) e ficam
// guardadas no banco, no Volume persistente.

const webpush = require('web-push');
const db = require('./db');

const { publicKey, privateKey } = db.getOuCriarChavesVapid();

// O "subject" do VAPID pode ser uma URL https ou um "mailto:" — usamos a
// própria URL de produção, só serve pra identificar quem está mandando o
// push caso o Google/Apple precisem entrar em contato por abuso.
webpush.setVapidDetails(
  'https://santo-antonio-production-9f5d.up.railway.app',
  publicKey,
  privateKey
);

function salvarInscricao(vendedorId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('inscrição de push incompleta');
  }
  // Mesmo endpoint pode já existir (ex: vendedor desativou e ativou de
  // novo no mesmo aparelho) — troca o dono em vez de duplicar.
  db.prepare(`
    INSERT INTO push_subscriptions (vendedor_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET vendedor_id = excluded.vendedor_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(vendedorId, endpoint, keys.p256dh, keys.auth);
}

function removerInscricao(endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

// Manda o push de verdade pra UMA inscrição específica. Se o navegador
// informar que a inscrição não existe mais (410/404 — vendedor desinstalou,
// trocou de aparelho, etc), apaga ela do banco sozinho, pra não ficar
// tentando mandar pra um endereço morto pra sempre.
async function enviarParaInscricao(inscricao, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      removerInscricao(inscricao.endpoint);
    } else {
      console.error('>> Falha ao mandar push:', err.statusCode, err.body || err.message);
    }
    return false;
  }
}

// Notifica UM vendedor específico (ex: cliente respondeu numa conversa
// que já é dele) — manda pra todos os aparelhos que ele tiver ativado.
async function notificarVendedor(vendedorId, payload) {
  const inscricoes = db.prepare(`SELECT * FROM push_subscriptions WHERE vendedor_id = ?`).all(vendedorId);
  await Promise.all(inscricoes.map((i) => enviarParaInscricao(i, payload)));
}

// Notifica TODOS os vendedores de uma vez (ex: lead novo chegou, ninguém
// puxou ainda) — todo mundo com notificação ativada recebe, quem responder
// primeiro pega o lead.
async function notificarTodosVendedores(payload) {
  const inscricoes = db.prepare(`SELECT * FROM push_subscriptions`).all();
  await Promise.all(inscricoes.map((i) => enviarParaInscricao(i, payload)));
}

module.exports = { publicKey, salvarInscricao, removerInscricao, notificarVendedor, notificarTodosVendedores };
