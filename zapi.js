// zapi.js
// Camada de comunicação com a Z-API (BSP não-oficial de WhatsApp).
// Duas responsabilidades: (1) mandar mensagem de verdade pro WhatsApp do
// cliente quando o vendedor ou a IA responde, e (2) ajudar a interpretar
// o payload que a Z-API manda pro nosso webhook quando chega mensagem nova.
//
// EDIÇÃO DE SETOR ÚNICO: este sistema atende UM setor só (Vendas OU
// Financeiro OU Expedição). Uma única instância da Z-API, configurada por
// variáveis de ambiente genéricas (definidas no .env local ou nas
// "Variables" do Railway deste projeto):
//
//     ZAPI_INSTANCE_ID / ZAPI_TOKEN / ZAPI_CLIENT_TOKEN
//
// Se não estiverem definidas, o sistema continua funcionando (modo
// demo/local) — só não manda nada de verdade pro WhatsApp, e avisa no log.

const CRED = {
  instanceId: process.env.ZAPI_INSTANCE_ID,
  token: process.env.ZAPI_TOKEN,
  clientToken: process.env.ZAPI_CLIENT_TOKEN,
};

const configurado = Boolean(CRED.instanceId && CRED.token);

// TRAVA DE ISOLAMENTO: este sistema só aceita mensagens da SUA própria
// instância da Z-API. Se por engano chegar um webhook de outra instância
// (ex: um link "Ao receber" apontado pra cá por erro), a mensagem é
// recusada na porta — nunca é gravada. É isso que torna impossível uma
// conversa de outro setor cair aqui: não depende da configuração estar
// certa, e sim de uma regra do próprio sistema.
// Se a instância local não estiver configurada (modo demo), não trava nada.
function instanciaPropria(instanceId) {
  if (!CRED.instanceId) return true; // modo demo/local: aceita tudo
  return instanceId === CRED.instanceId;
}

if (!configurado) {
  console.log('>> Z-API não configurada (ZAPI_INSTANCE_ID/ZAPI_TOKEN) — mensagens de saída só serão salvas no banco, não enviadas de verdade.');
}

// Dedupe simples em memória — a Z-API avisa que a mesma mensagem pode
// chegar duplicada no webhook. Guardamos os últimos IDs vistos.
// (Limitação: reinicia o servidor, a lista zera — aceitável, o pior caso
// é processar de novo uma mensagem antiga logo após um restart.)
const mensagensVistas = new Set();
const LIMITE_MEMORIA = 500;

function jaProcessada(messageId) {
  if (!messageId) return false;
  return mensagensVistas.has(messageId);
}

function marcarProcessada(messageId) {
  if (!messageId) return;
  mensagensVistas.add(messageId);
  if (mensagensVistas.size > LIMITE_MEMORIA) {
    const primeiro = mensagensVistas.values().next().value;
    mensagensVistas.delete(primeiro);
  }
}

// Extrai {telefone, nomeCliente, texto, messageId, fromMe} de um payload
// de webhook "ao receber" da Z-API. O texto pode vir em formatos diferentes
// dependendo do tipo de mensagem (texto simples, botão, lista, etc) —
// tentamos os campos mais comuns e caímos num fallback genérico.
// Extrai {telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe}
// de um payload de webhook "ao receber" da Z-API. Baseado na documentação
// oficial (developer.z-api.io/webhooks/on-message-received-examples).
function interpretarWebhook(body) {
  // Em grupo, o "telefone" (phone) é o ID do próprio grupo — é isso que
  // queremos usar como identificador da conversa (1 conversa por grupo,
  // não 1 por pessoa dentro dele). chatName é o nome do grupo; senderName
  // é quem escreveu essa mensagem especificamente dentro do grupo.
  const telefone = body.phone || body.connectedPhone || null;
  const nomeCliente = body.isGroup ? (body.chatName || 'Grupo') : (body.senderName || body.chatName || null);
  const messageId = body.messageId || null;
  const fromMe = Boolean(body.fromMe);
  // Quando alguém responde ("cita") uma mensagem direto pelo WhatsApp (não
  // pelo nosso sistema), a Z-API manda o ID da mensagem original aqui —
  // é isso que permite a citação aparecer certinho mesmo quando a
  // resposta não veio de dentro do nosso painel.
  const referenceMessageId = body.referenceMessageId || null;

  let texto = null;
  let midiaUrl = null;
  let midiaTipo = null;

  if (body.text && body.text.message) {
    // Cobre texto simples E mensagem com link/preview (a Z-API manda os dois
    // no mesmo formato text.message, só com description/url/thumbnailUrl extras)
    texto = body.text.message;
  } else if (body.buttonsResponseMessage && body.buttonsResponseMessage.message) {
    texto = body.buttonsResponseMessage.message;
  } else if (body.listResponseMessage && body.listResponseMessage.message) {
    texto = body.listResponseMessage.message;
  } else if (body.image) {
    texto = body.image.caption || '[Imagem]';
    midiaUrl = body.image.imageUrl;
    midiaTipo = 'imagem';
  } else if (body.audio) {
    texto = body.audio.ptt ? '[Áudio]' : '[Áudio]';
    midiaUrl = body.audio.audioUrl;
    midiaTipo = 'audio';
  } else if (body.video) {
    texto = body.video.caption || '[Vídeo]';
    midiaUrl = body.video.videoUrl;
    midiaTipo = 'video';
  } else if (body.document) {
    texto = `[Documento] ${body.document.fileName || body.document.title || ''}`.trim();
    midiaUrl = body.document.documentUrl;
    midiaTipo = 'documento';
  } else if (body.sticker) {
    texto = '[Sticker]';
    midiaUrl = body.sticker.stickerUrl;
    midiaTipo = 'sticker';
  } else if (body.product) {
    // Cliente compartilhou um produto do catálogo (ex: link de produto do site/catálogo)
    texto = `[Produto] ${body.product.title || ''}`.trim();
    if (body.product.productImage) { midiaUrl = body.product.productImage; midiaTipo = 'imagem'; }
  } else if (body.location) {
    texto = `[Localização] ${body.location.address || `${body.location.latitude}, ${body.location.longitude}`}`;
  } else if (body.contact) {
    texto = `[Contato] ${body.contact.displayName || ''}`;
  }

  // Formato não reconhecido — loga o payload inteiro pra investigar depois
  // em vez de simplesmente perder a mensagem em silêncio.
  if (!texto && !fromMe) {
    console.log('>> Webhook Z-API com formato não reconhecido, payload completo:', JSON.stringify(body));
  }

  // Numa conversa de grupo, várias pessoas diferentes escrevem na MESMA
  // conversa — sem identificar quem é quem, fica impossível saber quem
  // pediu o quê. senderName é o participante que mandou essa mensagem
  // específica (diferente de chatName, que é o nome do grupo todo).
  if (body.isGroup && texto && !fromMe && body.senderName) {
    texto = `*${body.senderName}:*\n${texto}`;
  }

  return { telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe, isGrupo: Boolean(body.isGroup), referenceMessageId };
}

// Rastreia messageIds das mensagens que NÓS mandamos via API — assim,
// quando a Z-API notifica um evento "fromMe: true", conseguimos distinguir
// entre (a) eco da nossa própria mensagem enviada pela API e (b) o vendedor
// respondendo manualmente direto pelo WhatsApp no celular conectado.
const mensagensEnviadasPorNos = new Set();
function foiEnviadaPorNos(messageId) {
  if (!messageId) return false;
  return mensagensEnviadasPorNos.has(messageId);
}
function registrarComoEnviadaPorNos(messageId) {
  if (!messageId) return;
  mensagensEnviadasPorNos.add(messageId);
  if (mensagensEnviadasPorNos.size > LIMITE_MEMORIA) {
    const primeiro = mensagensEnviadasPorNos.values().next().value;
    mensagensEnviadasPorNos.delete(primeiro);
  }
}

// Manda uma mensagem de texto de verdade pro WhatsApp do cliente.
// Não lança erro pro chamador — só loga — pra nunca travar o fluxo interno
// (salvar no banco) por causa de uma falha externa da Z-API.
async function enviarMensagemWhatsapp(telefone, texto, setor = null, citarMessageId = null) {
  const cred = CRED;
  if (!configurado) {
    console.log(`>> [Z-API não configurada] mensagem NÃO enviada de verdade pra ${telefone}: "${texto}"`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const url = `https://api.z-api.io/instances/${cred.instanceId}/token/${cred.token}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (cred.clientToken) headers['Client-Token'] = cred.clientToken;
  const body = { phone: telefone, message: texto };
  if (citarMessageId) body.messageId = citarMessageId; // "responder" de verdade no WhatsApp

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mensagem via Z-API (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (data && data.messageId) registrarComoEnviadaPorNos(data.messageId);
    return { enviado: true, messageId: data ? data.messageId : null };
  } catch (err) {
    console.error(`>> Erro de rede ao chamar a Z-API:`, err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

// Manda mídia (imagem, áudio, vídeo ou documento) de verdade pro WhatsApp
// do cliente. Aceita tanto link quanto Base64 (a Z-API aceita os dois —
// usamos Base64 aqui porque o arquivo vem direto do navegador do vendedor,
// sem precisar hospedar em lugar nenhum antes).
async function enviarMidiaWhatsapp(telefone, midiaTipo, dataUri, nomeArquivo, legenda, setor = null, citarMessageId = null) {
  const cred = CRED;
  if (!configurado) {
    console.log(`>> [Z-API não configurada] mídia (${midiaTipo}) NÃO enviada de verdade pra ${telefone}`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cred.clientToken) headers['Client-Token'] = cred.clientToken;
  const base = `https://api.z-api.io/instances/${cred.instanceId}/token/${cred.token}`;

  let url;
  let body;
  if (midiaTipo === 'imagem') {
    url = `${base}/send-image`;
    body = { phone: telefone, image: dataUri, caption: legenda || '' };
  } else if (midiaTipo === 'audio') {
    url = `${base}/send-audio`;
    body = { phone: telefone, audio: dataUri };
  } else if (midiaTipo === 'video') {
    url = `${base}/send-video`;
    body = { phone: telefone, video: dataUri, caption: legenda || '' };
  } else {
    const extensao = (nomeArquivo && nomeArquivo.includes('.')) ? nomeArquivo.split('.').pop().toLowerCase().trim() : 'pdf';
    url = `${base}/send-document/${extensao}`;
    body = { phone: telefone, document: dataUri, fileName: nomeArquivo || `arquivo.${extensao}`, caption: legenda || '' };
  }
  if (citarMessageId) body.messageId = citarMessageId;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mídia via Z-API (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (data && data.messageId) registrarComoEnviadaPorNos(data.messageId);
    return { enviado: true, messageId: data ? data.messageId : null };
  } catch (err) {
    console.error(`>> Erro de rede ao enviar mídia pela Z-API:`, err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

// Manda uma figurinha (sticker) de verdade pro WhatsApp do cliente via o
// endpoint send-sticker da Z-API. `imagem` pode ser um link ou um data URI
// (base64) — usamos data URI, já que a figurinha vem da nossa biblioteca.
async function enviarFigurinhaWhatsapp(telefone, imagem, setor = null) {
  const cred = CRED;
  if (!configurado) {
    console.log(`>> [Z-API não configurada] figurinha NÃO enviada de verdade pra ${telefone}`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }
  const url = `https://api.z-api.io/instances/${cred.instanceId}/token/${cred.token}/send-sticker`;
  const headers = { 'Content-Type': 'application/json' };
  if (cred.clientToken) headers['Client-Token'] = cred.clientToken;
  const body = { phone: telefone, sticker: imagem };
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar figurinha via Z-API (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (data && data.messageId) registrarComoEnviadaPorNos(data.messageId);
    return { enviado: true, messageId: data ? data.messageId : null };
  } catch (err) {
    console.error(`>> Erro de rede ao enviar figurinha pela Z-API:`, err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

// Interpreta o webhook de STATUS da mensagem (confirmação de entrega/leitura).
// A Z-API manda, quando o status de uma mensagem NOSSA muda, um payload de
// "MessageStatusCallback" com o novo status e o(s) id(s) afetado(s). O nome
// exato do campo varia um pouco entre versões, então tentamos os mais comuns.
function interpretarStatus(body) {
  if (!body) return { status: null, ids: [] };
  const status = body.status || body.ack || body.messageStatus || null;
  let ids = [];
  if (Array.isArray(body.ids)) ids = body.ids;
  else if (body.messageId) ids = [body.messageId];
  else if (body.id) ids = [body.id];
  else if (body.referenceMessageId) ids = [body.referenceMessageId];
  return { status: status ? String(status).toUpperCase() : null, ids: ids.filter(Boolean) };
}

// Traduz o status cru da Z-API pro nosso vocabulário interno.
// (a Z-API usa SENT/RECEIVED/READ/PLAYED; algumas versões DELIVERY/DELIVERED)
function mapearStatusEntrega(statusCru) {
  const s = String(statusCru || '').toUpperCase();
  if (s === 'SENT') return 'enviado';
  if (s === 'RECEIVED' || s === 'DELIVERY' || s === 'DELIVERED' || s === 'DELIVERY_ACK') return 'entregue';
  if (s === 'READ' || s === 'PLAYED' || s === 'READ_SELF' || s === 'READ-SELF') return 'lido';
  return null;
}

module.exports = { interpretarWebhook, enviarMensagemWhatsapp, enviarMidiaWhatsapp, enviarFigurinhaWhatsapp, jaProcessada, marcarProcessada, foiEnviadaPorNos, configurado, interpretarStatus, mapearStatusEntrega, instanciaPropria, instanceIdConfigurada: CRED.instanceId };
