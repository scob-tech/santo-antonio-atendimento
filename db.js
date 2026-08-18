// db.js
// Banco local em SQLite, usando o módulo node:sqlite que já vem
// EMBUTIDO no Node.js (desde a v22) — não precisa instalar nada, não
// precisa compilar código, não precisa de Python nem build tools.
// Quando formos integrar de verdade, migramos essas mesmas tabelas
// para o Supabase (Postgres) sem mudar a lógica do app.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const auth = require('./auth');

// Em produção (Railway), DATA_DIR aponta pro Volume permanente conectado
// ao serviço — sem isso, o banco vive no disco do container e some a
// cada redeploy. Localmente, sem a variável, continua salvando do lado
// do server.js como sempre foi.
const dataDir = process.env.DATA_DIR || __dirname;
const db = new DatabaseSync(path.join(dataDir, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS vendedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    disponivel INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL,
    nome_cliente TEXT,
    primeira_mensagem TEXT NOT NULL,
    origem TEXT NOT NULL DEFAULT 'geral',       -- de qual ícone/página do site veio: produtos | duvidas | geral | ...
    status TEXT NOT NULL DEFAULT 'novo',      -- novo | em_atendimento | encerrado
    vendedor_id INTEGER,                       -- null até alguem puxar
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    remetente TEXT NOT NULL,   -- 'cliente' | 'vendedor' | 'ia'
    texto TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS lembretes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    vendedor_id INTEGER,
    titulo TEXT NOT NULL,
    quando TEXT NOT NULL,
    feito INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  -- Um "endereço" de notificação por navegador/aparelho em que o vendedor
  -- ativou. Uma pessoa pode ter mais de um (celular + computador), por
  -- isso não é uma coluna na tabela vendedores, é tabela própria.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendedor_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  -- Identidade do servidor pra poder mandar push (protocolo VAPID).
  -- Gerada sozinha na primeira vez que o servidor sobe (ver getOuCriarChavesVapid
  -- abaixo) e guardada aqui, no Volume persistente — assim não precisa
  -- configurar nenhuma variável manual no Railway pra isso funcionar.
  CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL
  );

  -- Setores da loja (Vendas, Financeiro, Expedição, ...). Cada setor vai
  -- ter seu próprio número de WhatsApp no futuro; por enquanto isso aqui
  -- é só a estrutura de dados + controle de acesso.
  CREATE TABLE IF NOT EXISTS setores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,   -- 'vendas' | 'financeiro' | 'expedicao'
    nome TEXT NOT NULL           -- rótulo bonito pra exibir na tela
  );

  -- Quem tem acesso a qual setor. Vendedor de Financeiro só aparece aqui
  -- ligado a 'financeiro', por exemplo — sem essa linha, sem acesso.
  -- Admin não precisa de linha aqui: acesso total já vem do role.
  CREATE TABLE IF NOT EXISTS vendedor_setores (
    vendedor_id INTEGER NOT NULL,
    setor_id INTEGER NOT NULL,
    PRIMARY KEY (vendedor_id, setor_id),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id),
    FOREIGN KEY (setor_id) REFERENCES setores(id)
  );

  -- Meta atual de cada vendedor — 1 por vendedor (definir uma nova
  -- substitui a anterior). Só admin define; vendedor só acompanha.
  CREATE TABLE IF NOT EXISTS metas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendedor_id INTEGER NOT NULL UNIQUE,
    tipo TEXT NOT NULL,          -- 'valor' | 'atendimentos' | 'pedidos'
    valor_meta REAL NOT NULL,
    periodo TEXT NOT NULL DEFAULT 'semana', -- 'semana' | 'mes'
    definida_por INTEGER,
    definida_em TEXT NOT NULL,
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  -- Relatório de gargalo do Financeiro — a análise diária da IA, pra esse
  -- setor especificamente, não gera tarefa por lead como em Vendas: gera
  -- 1 relatório de texto por dia, guardado aqui pra o admin ver na hora
  -- e also poder consultar dias antigos depois (histórico de relatórios).
  CREATE TABLE IF NOT EXISTS relatorios_financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setor_id INTEGER NOT NULL,
    data TEXT NOT NULL,       -- YYYY-MM-DD
    conteudo TEXT NOT NULL,
    gerado_em TEXT NOT NULL,
    UNIQUE(setor_id, data)
  );

  -- Contato salvo de verdade (nome escolhido pela equipe), por telefone —
  -- compartilhado entre os 3 setores, já que é o mesmo número de WhatsApp
  -- de verdade independente de quem está conversando com ele. Enquanto um
  -- telefone não tem linha aqui, o nome exibido é só o que veio do
  -- WhatsApp (push name), e a conversa mostra o botão "Salvar contato".
  CREATE TABLE IF NOT EXISTS contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL UNIQUE,
    nome TEXT NOT NULL,
    criado_por INTEGER,
    criado_em TEXT NOT NULL
  );

  -- Histórico das "Análises sob medida" (pedido da gestão). Diferente do
  -- relatorios_financeiro (1 por dia, automático), aqui cada análise que o
  -- admin roda fica guardada com a PERGUNTA que ele escreveu e o texto
  -- completo que a IA respondeu. Vale pros TRÊS setores (a lista é sempre
  -- filtrada pelo setor). A tela mostra só data + pergunta; o conteúdo
  -- inteiro só aparece quando clica pra abrir.
  CREATE TABLE IF NOT EXISTS analises_personalizadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setor_id INTEGER NOT NULL,
    instrucao TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criado_por INTEGER,
    gerado_em TEXT NOT NULL
  );

  -- Biblioteca de figurinhas (stickers) da loja, cadastradas pelo admin. É um
  -- conjunto pequeno e fixo — a imagem fica guardada UMA vez aqui; a mensagem
  -- que envia a figurinha só guarda uma referência (/api/figurinhas/:id/img),
  -- não uma cópia, pra não inchar o banco a cada envio.
  CREATE TABLE IF NOT EXISTS figurinhas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    imagem TEXT NOT NULL,
    criado_por INTEGER,
    criado_em TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------
// MIGRAÇÕES: adiciona colunas novas em bancos que já existiam antes
// do sistema de login (sem apagar nenhum dado existente).
// ---------------------------------------------------------------
function colunaExiste(tabela, coluna) {
  const info = db.prepare(`PRAGMA table_info(${tabela})`).all();
  return info.some((c) => c.name === coluna);
}

if (!colunaExiste('vendedores', 'login')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN login TEXT`);
}
if (!colunaExiste('vendedores', 'senha_hash')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN senha_hash TEXT`);
}
if (!colunaExiste('vendedores', 'role')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN role TEXT NOT NULL DEFAULT 'vendedor'`);
}
if (!colunaExiste('leads', 'interesse')) {
  db.exec(`ALTER TABLE leads ADD COLUMN interesse TEXT`);
}
// resumo da análise da IA — guardado pra poder mostrar na tela de
// resultado da análise diária e no relatório, sem precisar chamar a IA
// de novo só pra reexibir o que ela já disse uma vez
if (!colunaExiste('leads', 'resumo_ia')) {
  db.exec(`ALTER TABLE leads ADD COLUMN resumo_ia TEXT`);
}
// quando o lembrete foi criado — precisa pra filtrar "tarefas que a IA
// criou HOJE" no relatório do dia (lembretes antigas não tinham essa coluna)
if (!colunaExiste('lembretes', 'criado_em')) {
  // SQLite não deixa usar função (strftime) como valor padrão direto no
  // ADD COLUMN quando é NOT NULL numa tabela que já existe — só aceita
  // valor constante nesse caso (diferente de CREATE TABLE, onde funciona).
  // Por isso em 2 passos: adiciona a coluna sem default, depois preenche
  // as linhas existentes manualmente.
  db.exec(`ALTER TABLE lembretes ADD COLUMN criado_em TEXT`);
  db.exec(`UPDATE lembretes SET criado_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE criado_em IS NULL`);
}
if (!colunaExiste('leads', 'resultado')) {
  db.exec(`ALTER TABLE leads ADD COLUMN resultado TEXT`); // 'convertido' | 'perdido'
}
if (!colunaExiste('leads', 'valor_venda')) {
  db.exec(`ALTER TABLE leads ADD COLUMN valor_venda REAL`);
}
if (!colunaExiste('leads', 'motivo_perda')) {
  db.exec(`ALTER TABLE leads ADD COLUMN motivo_perda TEXT`);
}
// tipo de ação do lembrete — alimenta a "agenda do dia seguinte"
if (!colunaExiste('lembretes', 'tipo')) {
  db.exec(`ALTER TABLE lembretes ADD COLUMN tipo TEXT NOT NULL DEFAULT 'outro'`);
}
// Quando o lembrete foi marcado como concluído — usado pra só mostrar as
// concluídas das últimas 24h na Agenda (sem isso, a lista de concluídas
// só cresceria pra sempre e ia poluir a tela).
if (!colunaExiste('lembretes', 'concluido_em')) {
  db.exec(`ALTER TABLE lembretes ADD COLUMN concluido_em TEXT`);
}
// mídia recebida (imagem, áudio, vídeo, documento, sticker) — guardamos a URL
// e o tipo pra poder exibir direto no chat, sem precisar abrir o WhatsApp
if (!colunaExiste('mensagens', 'midia_url')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_url TEXT`);
}
if (!colunaExiste('mensagens', 'midia_tipo')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_tipo TEXT`);
}
// Nome original do arquivo — sem isso, não dá pra oferecer um download
// de verdade (com extensão certa) pra quem for abrir o anexo depois.
if (!colunaExiste('mensagens', 'midia_nome')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_nome TEXT`);
}
// Vínculo de "responder" — igual ao WhatsApp, mostra uma citação da
// mensagem original em cima da resposta.
if (!colunaExiste('mensagens', 'responde_a')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN responde_a INTEGER`);
}
// Editar/apagar mensagem depois de enviada — só se aplica a mensagens
// nossas (remetente='vendedor'); apagar é "soft delete": o texto original
// some, mas a linha continua existindo (histórico/citação não quebra).
if (!colunaExiste('mensagens', 'editada')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN editada INTEGER NOT NULL DEFAULT 0`);
}
if (!colunaExiste('mensagens', 'apagada')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN apagada INTEGER NOT NULL DEFAULT 0`);
}
// ID da mensagem lá na Z-API/WhatsApp — precisa disso pra conseguir citar
// ("responder") de verdade no WhatsApp do cliente, não só aqui dentro.
if (!colunaExiste('mensagens', 'zapi_message_id')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN zapi_message_id TEXT`);
}
// Confirmação de leitura das mensagens QUE A EQUIPE ENVIA: 'enviado' (saiu),
// 'entregue' (chegou no cliente), 'lido' (cliente abriu — ✓✓ azul). Atualizado
// pelo webhook de status da Z-API, casando pelo zapi_message_id. Fica null nas
// mensagens do cliente e enquanto o webhook de status não estiver configurado.
if (!colunaExiste('mensagens', 'status_entrega')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN status_entrega TEXT`);
}
// Marca que a mídia dessa mensagem já passou pela compactação (recompressão
// de foto antiga), pra não tentar de novo em looping — mesmo quando a foto,
// depois de compactada, ainda ficou um pouco acima do limite de "grande".
if (!colunaExiste('mensagens', 'midia_compactada')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_compactada INTEGER NOT NULL DEFAULT 0`);
}
// marca quando o dono (ou gestor) abriu a conversa pela última vez —
// alimenta o badge de "mensagem não lida" nas Conversas Ativas
if (!colunaExiste('leads', 'visto_em')) {
  db.exec(`ALTER TABLE leads ADD COLUMN visto_em TEXT`);
}
// a qual setor esse lead pertence (Vendas, Financeiro, Expedição...).
// Todo lead que já existia antes dos setores existirem vai pro setor
// "vendas" — é o único que já existia até aqui, então nada muda pra
// ninguém que já está usando o sistema.
if (!colunaExiste('leads', 'setor_id')) {
  db.exec(`ALTER TABLE leads ADD COLUMN setor_id INTEGER`);
}
// Quando o lead virou venda de verdade — usado pro gráfico de Progresso.
// Sem essa coluna, só teríamos a data de CRIAÇÃO do lead, que não é a
// mesma coisa que a data da venda (a análise diária pode confirmar a
// conversão dias depois da primeira mensagem).
if (!colunaExiste('leads', 'convertido_em')) {
  db.exec(`ALTER TABLE leads ADD COLUMN convertido_em TEXT`);
  // Vendas já registradas antes dessa coluna existir usam a data de
  // criação do lead como aproximação — melhor que sumir do gráfico.
  db.exec(`UPDATE leads SET convertido_em = criado_em WHERE resultado = 'convertido' AND convertido_em IS NULL`);
}
// Quando o atendimento foi encerrado de verdade (convertido OU perdido) —
// usado pra meta de "número de atendimentos finalizados", que conta
// qualquer encerramento, não só venda fechada.
if (!colunaExiste('leads', 'encerrado_em')) {
  db.exec(`ALTER TABLE leads ADD COLUMN encerrado_em TEXT`);
  db.exec(`UPDATE leads SET encerrado_em = COALESCE(convertido_em, criado_em) WHERE status = 'encerrado' AND encerrado_em IS NULL`);
}
// Conversa de grupo não tem "dono" — é de todo mundo do setor, ninguém
// precisa (nem pode) puxar ela como se fosse um lead individual.
if (!colunaExiste('leads', 'is_grupo')) {
  db.exec(`ALTER TABLE leads ADD COLUMN is_grupo INTEGER NOT NULL DEFAULT 0`);
}

// CURADORIA DE QUALIDADE: além do texto humano (conteudo), guardamos o bloco
// de métricas por vendedor em JSON estruturado numa coluna própria, pra o
// dashboard externo ler direto sem precisar garimpar texto. Vale tanto pras
// análises (analises_personalizadas) quanto pro relatório diário do Financeiro.
if (!colunaExiste('analises_personalizadas', 'metricas_json')) {
  db.exec(`ALTER TABLE analises_personalizadas ADD COLUMN metricas_json TEXT`);
}
if (!colunaExiste('relatorios_financeiro', 'metricas_json')) {
  db.exec(`ALTER TABLE relatorios_financeiro ADD COLUMN metricas_json TEXT`);
}

// ---------------------------------------------------------------
// ÍNDICES — sem eles, cada consulta "mensagens de um lead" varria a tabela
// mensagens INTEIRA (que é enorme por causa das mídias em base64). Como a
// lista de conversas roda isso pra cada lead a cada 3s, ficava cada vez mais
// lento conforme os dados cresciam. Criar índice é seguro, idempotente e
// deixa essas consultas praticamente instantâneas.
// ---------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mensagens_lead_id ON mensagens(lead_id);
  CREATE INDEX IF NOT EXISTS idx_mensagens_zapi ON mensagens(zapi_message_id);
  CREATE INDEX IF NOT EXISTS idx_leads_setor_status ON leads(setor_id, status);
  CREATE INDEX IF NOT EXISTS idx_leads_telefone ON leads(telefone);
  CREATE INDEX IF NOT EXISTS idx_leads_encerrado_em ON leads(encerrado_em);
`);

// ---------------------------------------------------------------
// SETORES: cria os 3 setores padrão (se ainda não existirem) e faz o
// backfill pra tudo que já existia antes desse conceito existir —
// sem isso, todo lead e vendedor antigo ficaria "sem setor" e sumiria
// das telas assim que a lógica de setor entrar em uso de verdade.
// ---------------------------------------------------------------
// EDIÇÃO DE SETOR ÚNICO: este banco pertence a UM setor só, definido pela
// variável de ambiente SETOR. Criamos (se não existir) apenas a linha desse
// setor — não há os outros. Assim getTodosSetores() sempre reflete só ele.
const NOMES_SETOR = { vendas: 'Vendas', financeiro: 'Financeiro', expedicao: 'Expedição' };
const SETOR_UNICO = (process.env.SETOR || 'vendas').toLowerCase();
const NOME_SETOR = NOMES_SETOR[SETOR_UNICO] || (SETOR_UNICO.charAt(0).toUpperCase() + SETOR_UNICO.slice(1));

const existeSetor = db.prepare(`SELECT id FROM setores WHERE slug = ?`).get(SETOR_UNICO);
if (!existeSetor) {
  db.prepare(`INSERT INTO setores (slug, nome) VALUES (?, ?)`).run(SETOR_UNICO, NOME_SETOR);
}
const setorAtivoRow = db.prepare(`SELECT id FROM setores WHERE slug = ?`).get(SETOR_UNICO);

// Todo lead sem setor definido pertence a este setor (o único que existe aqui).
db.prepare(`UPDATE leads SET setor_id = ? WHERE setor_id IS NULL`).run(setorAtivoRow.id);

// ---------------------------------------------------------------
// Garante que sempre existe pelo menos 1 administrador.
// Login: admin / Senha: admin123 — TROCAR depois do primeiro acesso
// (ainda não existe tela de troca de senha; se precisar mudar, me avisa).
// ---------------------------------------------------------------
const existeAdmin = db.prepare(`SELECT id FROM vendedores WHERE role = 'admin'`).get();
if (!existeAdmin) {
  const senha_hash = auth.hashSenha('admin123');
  db.prepare(`
    INSERT INTO vendedores (nome, login, senha_hash, role, disponivel)
    VALUES ('Administrador', 'admin', ?, 'admin', 1)
  `).run(senha_hash);
  console.log('>> Conta admin criada — login: admin | senha: admin123 (troque assim que possível)');
}

// ---------------------------------------------------------------
// Chaves VAPID pra notificação push — gera na primeira vez que o servidor
// sobe e guarda no banco (Volume persistente), pra sempre usar as MESMAS
// chaves depois disso. Trocar a chave pública invalidaria toda inscrição
// de notificação que os vendedores já tivessem ativado.
// ---------------------------------------------------------------
function getOuCriarChavesVapid() {
  const existente = db.prepare(`SELECT public_key, private_key FROM vapid_keys WHERE id = 1`).get();
  if (existente) return { publicKey: existente.public_key, privateKey: existente.private_key };

  const webpush = require('web-push');
  const chaves = webpush.generateVAPIDKeys();
  db.prepare(`INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)`)
    .run(chaves.publicKey, chaves.privateKey);
  console.log('>> Chaves VAPID geradas e salvas (primeira vez) — notificação push pronta pra uso.');
  return { publicKey: chaves.publicKey, privateKey: chaves.privateKey };
}

module.exports = db;
module.exports.getOuCriarChavesVapid = getOuCriarChavesVapid;

// Setores que esse vendedor pode acessar — [{ id, slug, nome }]. Não
// inclui verificação de admin aqui de propósito: quem decide "admin vê
// tudo" é a camada de cima (server.js), essa função só reflete o que
// está na tabela vendedor_setores.
module.exports.getSetoresPermitidos = function (vendedorId) {
  return db.prepare(`
    SELECT setores.id, setores.slug, setores.nome
    FROM vendedor_setores
    JOIN setores ON setores.id = vendedor_setores.setor_id
    WHERE vendedor_setores.vendedor_id = ?
    ORDER BY setores.id ASC
  `).all(vendedorId);
};

module.exports.getTodosSetores = function () {
  return db.prepare(`SELECT id, slug, nome FROM setores ORDER BY id ASC`).all();
};

module.exports.getSetorPorSlug = function (slug) {
  return db.prepare(`SELECT id, slug, nome FROM setores WHERE slug = ?`).get(slug);
};

// Só dígitos — sem isso, "(11) 98765-4321" e "5511987654321" seriam
// tratados como telefones diferentes e criariam contato/conversa
// duplicados só por causa da formatação de como foi digitado.
module.exports.normalizarTelefone = function (telefone) {
  let limpo = String(telefone || '').replace(/\D/g, '');
  // Número digitado no formato nacional (DDD + número, 10 ou 11 dígitos,
  // sem o código do país) recebe o 55 na frente — sem isso,
  // "(11) 98765-4321" e "5511987654321" seriam tratados como números
  // diferentes e duplicariam a conversa.
  if (limpo.length === 10 || limpo.length === 11) {
    limpo = '55' + limpo;
  }
  return limpo;
};

// Variantes equivalentes de um telefone brasileiro por causa do "nono
// dígito": o mesmo celular pode chegar da Z-API COM o 9 (55 + DDD + 9 + 8
// dígitos = 13) ou SEM o 9 (55 + DDD + 8 = 12), dependendo da origem. Como
// é a MESMA pessoa, geramos as duas formas pra comparar/procurar por
// qualquer uma delas e não duplicar lead. Conservador: só cria a variante
// "com 9" quando o número parece mesmo celular (parte local começa em 6-9),
// pra nunca confundir um fixo (começa em 2-5) com um celular.
module.exports.variantesTelefone = function (telefone) {
  const base = module.exports.normalizarTelefone(telefone);
  const set = new Set([base]);
  if (base.startsWith('55')) {
    const resto = base.slice(2); // DDD + número local
    if (resto.length === 11 && resto[2] === '9') {
      // celular COM o 9 → variante SEM o 9
      set.add('55' + resto.slice(0, 2) + resto.slice(3));
    } else if (resto.length === 10 && /[6-9]/.test(resto[2])) {
      // possível celular SEM o 9 → variante COM o 9
      set.add('55' + resto.slice(0, 2) + '9' + resto.slice(2));
    }
  }
  return [...set];
};

module.exports.getContatoPorTelefone = function (telefone) {
  const limpo = module.exports.normalizarTelefone(telefone);
  return db.prepare(`SELECT * FROM contatos WHERE telefone = ?`).get(limpo);
};

// Salva (ou atualiza) o nome de um contato, e já atualiza o nome exibido
// em todo lead existente com esse telefone — sem isso, a conversa
// continuaria mostrando o nome antigo (do WhatsApp) ao lado do nome novo
// salvo, dando a impressão de "duplicado".
module.exports.salvarContato = function (telefone, nome, criadoPor) {
  const limpo = module.exports.normalizarTelefone(telefone);
  db.prepare(`
    INSERT INTO contatos (telefone, nome, criado_por, criado_em)
    VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT(telefone) DO UPDATE SET nome = excluded.nome
  `).run(limpo, nome, criadoPor || null);
  db.prepare(`UPDATE leads SET nome_cliente = ? WHERE telefone = ?`).run(nome, limpo);
};

// Edita um contato já salvo: troca o nome e/ou o número. Se o número mudou,
// as conversas que estavam no número antigo são movidas pro novo (comparando
// pelas variantes com/sem o nono dígito), pra continuarem ligadas ao contato.
// Recusa se o número novo já pertencer a OUTRO contato (o telefone é único).
// Retorna { ok } ou { erro }.
module.exports.editarContato = function (id, nome, telefoneNovo) {
  const atual = db.prepare(`SELECT * FROM contatos WHERE id = ?`).get(id);
  if (!atual) return { erro: 'contato não encontrado' };

  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) return { erro: 'o nome não pode ficar em branco' };

  const telNovo = module.exports.normalizarTelefone(telefoneNovo);
  if (!telNovo || telNovo.replace(/\D/g, '').length < 8) return { erro: 'telefone inválido' };

  const mudouNumero = telNovo !== atual.telefone;
  if (mudouNumero) {
    const jaExiste = db.prepare(`SELECT id FROM contatos WHERE telefone = ? AND id != ?`).get(telNovo, id);
    if (jaExiste) return { erro: 'já existe outro contato salvo com esse número' };
    // Move as conversas do número antigo pro novo (com variantes do nono dígito).
    const varsAntigo = module.exports.variantesTelefone(atual.telefone);
    const ph = varsAntigo.map(() => '?').join(',');
    db.prepare(`UPDATE leads SET telefone = ? WHERE telefone IN (${ph})`).run(telNovo, ...varsAntigo);
  }

  db.prepare(`UPDATE contatos SET nome = ?, telefone = ? WHERE id = ?`).run(nomeLimpo, telNovo, id);

  // Propaga o nome novo pras conversas que estão nesse número.
  const varsNovo = module.exports.variantesTelefone(telNovo);
  const ph2 = varsNovo.map(() => '?').join(',');
  db.prepare(`UPDATE leads SET nome_cliente = ? WHERE telefone IN (${ph2})`).run(nomeLimpo, ...varsNovo);

  return { ok: true, id, nome: nomeLimpo, telefone: telNovo };
};
