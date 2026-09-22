// midia.js
// ---------------------------------------------------------------------------
// Mídia como ARQUIVO (não mais base64 dentro do banco). Cada foto, documento,
// áudio ou vídeo é gravado como arquivo em DATA_DIR/midia/, e o banco guarda
// só uma referência curta (ex: "/midia/ab12....jpg"). Isso mantém o banco
// pequeno e rápido, e a mídia continua abrindo igual (servida pela rota
// /midia/:arquivo no server.js).
//
// Compatível com o formato antigo: mensagens que ainda tiverem "data:..."
// (base64) no banco continuam funcionando; a migração converte elas em
// arquivo depois.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const MIDIA_DIR = path.join(DATA_DIR, 'midia');
const PREFIXO_URL = '/midia/';

function garantirPasta() {
  if (!fs.existsSync(MIDIA_DIR)) fs.mkdirSync(MIDIA_DIR, { recursive: true });
}

// Descobre uma extensão de arquivo segura a partir do mime, do tipo interno
// (imagem/audio/video/documento/sticker) e/ou do nome original.
function extensaoDe({ mime, tipo, nome }) {
  const porMime = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/amr': 'amr', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
    'audio/opus': 'ogg', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  };
  if (mime && porMime[mime.toLowerCase()]) return porMime[mime.toLowerCase()];
  if (nome && nome.includes('.')) {
    const ext = nome.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
    if (ext) return ext;
  }
  const porTipo = { imagem: 'jpg', audio: 'ogg', video: 'mp4', documento: 'pdf', sticker: 'webp' };
  return porTipo[tipo] || 'bin';
}

// Formato REAL de um áudio pelos primeiros bytes. A Z-API às vezes entrega
// áudio com content-type genérico (application/octet-stream) ou de um tipo
// que não estava no mapa acima, e ele acabava gravado como ".ogg" mesmo sendo
// AAC/MP3/WebM — o Chrome até adivinha e toca, mas o Safari/iPhone confia no
// tipo declarado e não toca (fica mudo). Devolve { ext, mime } ou null.
function formatoAudioPorBytes(b) {
  if (!b || b.length < 12) return null;
  const txt = (ini, fim) => b.subarray(ini, fim).toString('latin1');
  if (txt(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { ext: 'webm', mime: 'audio/webm' };
  if (txt(4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (txt(0, 4) === 'RIFF' && txt(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (txt(0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE6) === 0xE2)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return { ext: 'aac', mime: 'audio/aac' };
  if (txt(0, 6) === '#!AMR\n') return { ext: 'amr', mime: 'audio/amr' };
  return null;
}

// Tipo real de um arquivo de áudio já salvo (lê só o começo do arquivo).
// Usado pela rota /midia pra servir áudios ANTIGOS com o Content-Type certo,
// sem precisar renomear nada nem mexer no banco.
function mimeRealDoAudio(caminho) {
  try {
    const fd = fs.openSync(caminho, 'r');
    const b = Buffer.alloc(16);
    const lidos = fs.readSync(fd, b, 0, 16, 0);
    fs.closeSync(fd);
    const f = formatoAudioPorBytes(b.subarray(0, lidos));
    return f ? f.mime : null;
  } catch (e) {
    return null;
  }
}

function nomeNovo(ext) {
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
}

// Grava um Buffer como arquivo de mídia e devolve a referência ("/midia/...").
function salvarBuffer(buffer, { mime, tipo, nome } = {}) {
  garantirPasta();
  const ehAudio = tipo === 'audio' || (mime || '').toLowerCase().startsWith('audio/');
  const real = ehAudio ? formatoAudioPorBytes(buffer) : null;
  const ext = real ? real.ext : extensaoDe({ mime, tipo, nome });
  const arquivo = nomeNovo(ext);
  fs.writeFileSync(path.join(MIDIA_DIR, arquivo), buffer);
  return PREFIXO_URL + arquivo;
}

// Recebe um data URI ("data:image/jpeg;base64,....") e grava como arquivo.
// Se não for um data URI (já é referência ou URL), devolve como veio.
function salvarDataUri(dataUri, { tipo, nome } = {}) {
  if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:')) return dataUri || null;
  const m = dataUri.match(/^data:([^;,]*)?(;base64)?,(.*)$/s);
  if (!m) return dataUri;
  const mime = m[1] || '';
  const base64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64');
  const buffer = Buffer.from(base64, 'base64');
  return salvarBuffer(buffer, { mime, tipo, nome });
}

// Baixa uma mídia de uma URL (ex: link da Z-API que chega no webhook) e grava
// como arquivo local permanente. Se der qualquer erro, devolve a URL original
// (melhor mostrar o link do que perder a mídia). É assíncrona.
async function salvarDeUrl(url, { tipo, nome } = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url || null;
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const mime = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    return salvarBuffer(buffer, { mime: mime.split(';')[0], tipo, nome });
  } catch (e) {
    console.error('>> Falha ao baixar mídia da URL (mantendo o link original):', e.message);
    return url;
  }
}

// Lê uma referência de mídia local ("/midia/...") de volta como data URI —
// necessário pra reenviar pela Z-API (encaminhar), que precisa do conteúdo.
// Se não for referência local, devolve como veio (já é URL ou data URI).
function refParaDataUri(ref, { tipo } = {}) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith(PREFIXO_URL)) return ref;
  try {
    const arquivo = path.basename(ref); // evita path traversal
    const caminho = path.join(MIDIA_DIR, arquivo);
    if (!fs.existsSync(caminho)) return ref;
    const ext = (arquivo.split('.').pop() || '').toLowerCase();
    const mimePorExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', pdf: 'application/pdf',
      webm: 'audio/webm', wav: 'audio/wav', aac: 'audio/aac', amr: 'audio/amr' };
    const conteudo = fs.readFileSync(caminho);
    const real = tipo === 'audio' ? formatoAudioPorBytes(conteudo) : null;
    const mime = real ? real.mime : (mimePorExt[ext] || 'application/octet-stream');
    const base64 = conteudo.toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch (e) {
    return ref;
  }
}

// Caminho absoluto do arquivo pra rota de servir (com proteção contra
// path traversal). Devolve null se o nome for inválido ou não existir.
function caminhoDoArquivo(nomeArquivo) {
  const base = path.basename(nomeArquivo || '');
  if (!base || base.includes('..')) return null;
  const caminho = path.join(MIDIA_DIR, base);
  return fs.existsSync(caminho) ? caminho : null;
}

module.exports = {
  MIDIA_DIR, PREFIXO_URL, garantirPasta,
  salvarBuffer, salvarDataUri, salvarDeUrl, refParaDataUri, caminhoDoArquivo, extensaoDe,
  formatoAudioPorBytes, mimeRealDoAudio,
};
