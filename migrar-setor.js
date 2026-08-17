// migrar-setor.js
// ---------------------------------------------------------------------------
// Migração NÃO-DESTRUTIVA do banco multi-setor (o sistema antigo) para um
// banco de SETOR ÚNICO (um sistema novo por setor).
//
// O que faz: COPIA o banco de origem e, na cópia, mantém apenas os dados
// daquele setor (conversas, mensagens, lembretes, relatórios) mais os dados
// compartilhados (contatos e figurinhas). Os usuários mantidos são os
// administradores + quem tinha acesso àquele setor. O banco de ORIGEM nunca
// é tocado.
//
// Uso:
//   node migrar-setor.js <banco-origem> <setor> <banco-saida>
// Exemplo:
//   node migrar-setor.js ./data.sqlite financeiro ./data-financeiro.sqlite
//
// Setores válidos: vendas | financeiro | expedicao
// ---------------------------------------------------------------------------

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function abortar(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const [origem, setorSlug, saida] = process.argv.slice(2);
if (!origem || !setorSlug || !saida) {
  abortar('Uso: node migrar-setor.js <banco-origem> <setor> <banco-saida>');
}
if (!fs.existsSync(origem)) abortar(`Banco de origem não encontrado: ${origem}`);
if (fs.existsSync(saida)) abortar(`O arquivo de saída já existe (não vou sobrescrever): ${saida}`);

console.log(`\n=== Migração para setor único: "${setorSlug}" ===`);
console.log(`Origem:  ${origem}`);
console.log(`Saída:   ${saida}\n`);

// -------- 1) Conta o que existe na ORIGEM (só leitura) --------
const src = new DatabaseSync(origem);
const setorOrigem = src.prepare(`SELECT id, slug, nome FROM setores WHERE slug = ?`).get(setorSlug);
if (!setorOrigem) abortar(`O setor "${setorSlug}" não existe no banco de origem.`);
const setorId = setorOrigem.id;

const contarOrigem = {
  leads: src.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id = ?`).get(setorId).n,
  mensagens: src.prepare(`SELECT COUNT(*) n FROM mensagens WHERE lead_id IN (SELECT id FROM leads WHERE setor_id = ?)`).get(setorId).n,
  contatos: src.prepare(`SELECT COUNT(*) n FROM contatos`).get().n,
};
src.close();

console.log('Na origem, para este setor:');
console.log(`  conversas (leads): ${contarOrigem.leads}`);
console.log(`  mensagens:         ${contarOrigem.mensagens}`);
console.log(`  contatos (compart.): ${contarOrigem.contatos}\n`);

// -------- 2) COPIA o arquivo do banco (a origem fica intacta) --------
fs.copyFileSync(origem, saida);
console.log('✓ Cópia criada. A partir daqui só mexo na cópia — a origem não é tocada.\n');

// -------- 3) Na CÓPIA, remove tudo que não é deste setor --------
const db = new DatabaseSync(saida);

// Usuários mantidos: admins + quem tinha acesso a este setor.
const mantidos = db.prepare(`
  SELECT DISTINCT v.id FROM vendedores v
  WHERE v.role = 'admin'
     OR v.id IN (SELECT vendedor_id FROM vendedor_setores WHERE setor_id = ?)
`).all(setorId).map((r) => r.id);
const phMant = mantidos.length ? mantidos.map(() => '?').join(',') : 'NULL';

// Durante a limpeza em massa, desligamos as checagens de chave estrangeira —
// estamos removendo tabelas inteiras de dados de outros setores numa ordem
// controlada, e no fim conferimos que não sobrou nenhum "órfão". (Precisa
// ser FORA da transação — o SQLite ignora esse PRAGMA dentro de um BEGIN.)
db.exec('PRAGMA foreign_keys = OFF');

db.exec('BEGIN');
try {
  // 1) Primeiro solta/limpa as referências a usuários que vão sair, ANTES de
  //    remover os usuários — assim nada fica apontando pra um id que sumiu.
  if (mantidos.length) {
    db.prepare(`UPDATE leads SET vendedor_id = NULL WHERE vendedor_id IS NOT NULL AND vendedor_id NOT IN (${phMant})`).run(...mantidos);
    db.prepare(`UPDATE lembretes SET vendedor_id = NULL WHERE vendedor_id IS NOT NULL AND vendedor_id NOT IN (${phMant})`).run(...mantidos);
    db.prepare(`DELETE FROM metas WHERE vendedor_id NOT IN (${phMant})`).run(...mantidos);
    db.prepare(`DELETE FROM push_subscriptions WHERE vendedor_id NOT IN (${phMant})`).run(...mantidos);
    db.prepare(`DELETE FROM vendedores WHERE id NOT IN (${phMant})`).run(...mantidos);
  }

  // 2) Vínculos de setor: tira os de outros setores E os de usuários removidos.
  db.prepare(`DELETE FROM vendedor_setores WHERE setor_id IS NOT ?`).run(setorId);
  if (mantidos.length) {
    db.prepare(`DELETE FROM vendedor_setores WHERE vendedor_id NOT IN (${phMant})`).run(...mantidos);
  }

  // 3) Conversas de outros setores (e o que depende delas).
  db.prepare(`DELETE FROM mensagens WHERE lead_id IN (SELECT id FROM leads WHERE setor_id IS NOT ?)`).run(setorId);
  db.prepare(`DELETE FROM lembretes WHERE lead_id IN (SELECT id FROM leads WHERE setor_id IS NOT ?)`).run(setorId);
  db.prepare(`DELETE FROM leads WHERE setor_id IS NOT ?`).run(setorId);

  // 4) Relatórios e análises de outros setores.
  db.prepare(`DELETE FROM relatorios_financeiro WHERE setor_id IS NOT ?`).run(setorId);
  db.prepare(`DELETE FROM analises_personalizadas WHERE setor_id IS NOT ?`).run(setorId);

  // 5) Por último, deixa só a linha deste setor na tabela de setores.
  db.prepare(`DELETE FROM setores WHERE id IS NOT ?`).run(setorId);

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  abortar(`Erro durante a migração (nada foi salvo na cópia): ${err.message}`);
}

// -------- 3b) MÍDIA COMO ARQUIVO: tira o base64 de dentro do banco --------
// Cada mídia que estava embutida em base64 vira um arquivo numa pasta ao lado
// do banco, e o banco passa a guardar só a referência "/midia/...". É isso que
// deixa o banco pequeno e rápido. A pasta de mídia vai junto pro Volume do
// setor na hora de subir.
const midiaDir = saida.replace(/\.sqlite$/i, '') + '-midia';
if (!fs.existsSync(midiaDir)) fs.mkdirSync(midiaDir, { recursive: true });
const crypto = require('crypto');
const extPorMime = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','video/mp4':'mp4','application/pdf':'pdf' };
const extPorTipo = { imagem:'jpg', audio:'ogg', video:'mp4', documento:'pdf', sticker:'webp' };
function extrair(dataUri, tipo, nome) {
  const m = String(dataUri).match(/^data:([^;,]*)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = (m[1] || '').toLowerCase();
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  let ext = extPorMime[mime];
  if (!ext && nome && nome.includes('.')) ext = nome.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,5);
  if (!ext) ext = extPorTipo[tipo] || 'bin';
  const arq = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(midiaDir, arq), buf);
  return '/midia/' + arq;
}
const comMidiaBase64 = db.prepare(`SELECT id, midia_url, midia_tipo, midia_nome FROM mensagens WHERE midia_url LIKE 'data:%'`).all();
let extraidas = 0;
const updRef = db.prepare(`UPDATE mensagens SET midia_url = ? WHERE id = ?`);
db.exec('BEGIN');
try {
  for (const row of comMidiaBase64) {
    const ref = extrair(row.midia_url, row.midia_tipo, row.midia_nome);
    if (ref) { updRef.run(ref, row.id); extraidas++; }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  abortar(`Erro ao extrair mídia pra arquivo: ${err.message}`);
}
console.log(`✓ Mídia extraída pra arquivo: ${extraidas} de ${comMidiaBase64.length} (pasta: ${path.basename(midiaDir)})`);

// Compacta o arquivo (recupera o espaço das conversas removidas E do base64).
db.exec('VACUUM');

// -------- 4) CONFERE as contagens (segurança contra perda) --------
const depois = {
  leads: db.prepare(`SELECT COUNT(*) n FROM leads`).get().n,
  mensagens: db.prepare(`SELECT COUNT(*) n FROM mensagens`).get().n,
  contatos: db.prepare(`SELECT COUNT(*) n FROM contatos`).get().n,
  leadsForaDoSetor: db.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id IS NOT ?`).get(setorId).n,
  vendedores: db.prepare(`SELECT COUNT(*) n FROM vendedores`).get().n,
};
db.close();

console.log('Na cópia migrada:');
console.log(`  conversas (leads): ${depois.leads}`);
console.log(`  mensagens:         ${depois.mensagens}`);
console.log(`  contatos:          ${depois.contatos}`);
console.log(`  usuários mantidos: ${depois.vendedores}\n`);

const okLeads = depois.leads === contarOrigem.leads;
const okMsgs = depois.mensagens === contarOrigem.mensagens;
const okContatos = depois.contatos === contarOrigem.contatos;
const semForasteiros = depois.leadsForaDoSetor === 0;

function mb(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
const tamBanco = fs.existsSync(saida) ? fs.statSync(saida).size : 0;
let tamMidia = 0, arquivosMidia = 0;
if (fs.existsSync(midiaDir)) {
  for (const f of fs.readdirSync(midiaDir)) { tamMidia += fs.statSync(path.join(midiaDir, f)).size; arquivosMidia++; }
}

if (okLeads && okMsgs && okContatos && semForasteiros) {
  console.log('✅ CONFERÊNCIA OK — nenhuma conversa deste setor foi perdida, e nenhuma de outro setor sobrou.');
  console.log(`   Banco (enxuto):  ${path.resolve(saida)}  (${mb(tamBanco)})`);
  console.log(`   Pasta de mídia:  ${path.resolve(midiaDir)}  (${arquivosMidia} arquivos, ${mb(tamMidia)})`);
  console.log('   → o banco vai como seed; a pasta de mídia vai pro /midia do Volume desse setor.\n');
  process.exit(0);
} else {
  console.error('⚠️  CONFERÊNCIA FALHOU — as contagens não bateram:');
  if (!okLeads) console.error(`   conversas: origem=${contarOrigem.leads} cópia=${depois.leads}`);
  if (!okMsgs) console.error(`   mensagens: origem=${contarOrigem.mensagens} cópia=${depois.mensagens}`);
  if (!okContatos) console.error(`   contatos: origem=${contarOrigem.contatos} cópia=${depois.contatos}`);
  if (!semForasteiros) console.error(`   sobraram ${depois.leadsForaDoSetor} conversas de outro setor.`);
  console.error('   A origem continua intacta. Me chame pra investigar antes de usar essa cópia.\n');
  process.exit(1);
}
