// backup.js
// ---------------------------------------------------------------------------
// Backup automático diário do banco — a rede de proteção do histórico.
// Todo dia (e também a cada vez que o serviço sobe) faz uma cópia consistente
// do banco dentro de DATA_DIR/backups/ (o Volume permanente do Railway),
// guardando os últimos BACKUP_MANTER_DIAS dias (padrão: 7). Se o banco
// corromper ou um deploy der errado, existe de onde voltar.
//
// Usa "VACUUM INTO", que gera uma cópia íntegra do banco mesmo com o sistema
// em uso (não é um copy-paste do arquivo no meio de uma escrita).
// ---------------------------------------------------------------------------

const db = require('./db');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MANTER_DIAS = Math.max(1, Number(process.env.BACKUP_MANTER_DIAS || 7));
const UM_DIA_MS = 24 * 60 * 60 * 1000;

function garantirPasta() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function dataHoje() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Apaga os backups mais antigos, mantendo só os últimos MANTER_DIAS.
function podar() {
  const arquivos = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.sqlite'))
    .sort(); // nome tem a data no formato ISO, então ordem alfabética = ordem cronológica
  while (arquivos.length > MANTER_DIAS) {
    const velho = arquivos.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, velho)); } catch (e) { /* ignora */ }
  }
}

// Gera (ou regrava) o backup do dia e devolve o caminho do arquivo.
function fazerBackup() {
  garantirPasta();
  const alvo = path.join(BACKUP_DIR, `backup-${dataHoje()}.sqlite`);
  try { if (fs.existsSync(alvo)) fs.unlinkSync(alvo); } catch (e) { /* ignora */ }
  // Escapa aspas simples no caminho por segurança (VACUUM INTO não aceita
  // parâmetro vinculado, é string literal no SQL).
  db.exec(`VACUUM INTO '${alvo.replace(/'/g, "''")}'`);
  podar();
  return alvo;
}

// Roda um backup agora (na subida) e agenda os próximos, um por dia.
function agendar() {
  const rodar = () => {
    try {
      const arq = fazerBackup();
      console.log(`>> Backup diário salvo em ${arq} (mantendo os últimos ${MANTER_DIAS} dias).`);
    } catch (e) {
      console.error('>> Falha ao gerar backup automático:', e.message);
    }
  };
  rodar();
  setInterval(rodar, UM_DIA_MS);
}

module.exports = { fazerBackup, agendar, BACKUP_DIR };
