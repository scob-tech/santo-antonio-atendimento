// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

// SEED NA PRIMEIRA SUBIDA — jeito simples de trazer o histórico pro Volume
// do Railway sem acesso técnico a ele. Se o Volume ainda NÃO tem banco
// (primeira vez que este sistema sobe) E existe um arquivo "seed-inicial.sqlite"
// no projeto (o histórico deste setor já migrado), copiamos ele pro Volume
// ANTES de abrir o banco. A partir da segunda subida, o banco do Volume já
// existe, então o seed é ignorado (o trabalho do dia a dia nunca é
// sobrescrito). Depois de confirmar que entrou, o arquivo seed pode ser
// removido do projeto.
(() => {
  const fs = require('fs');
  const setor = (process.env.SETOR || 'vendas').toLowerCase();
  const DATA_DIR = process.env.DATA_DIR || __dirname;
  const alvo = path.join(DATA_DIR, 'data.sqlite');
  // Procura primeiro o seed DESTE setor (assim um único repositório pode
  // guardar os três: seed-vendas.sqlite, seed-financeiro.sqlite,
  // seed-expedicao.sqlite — cada projeto importa só o seu, pelo SETOR).
  // Se não achar, tenta um "seed-inicial.sqlite" genérico.
  const candidatos = [
    path.join(__dirname, `seed-${setor}.sqlite`),
    path.join(__dirname, 'seed-inicial.sqlite'),
  ];
  const seed = candidatos.find((p) => fs.existsSync(p));
  if (!seed) return;
  try {
    let precisaImportar = false;
    if (!fs.existsSync(alvo)) {
      // Volume totalmente vazio (primeira subida de verdade).
      precisaImportar = true;
    } else {
      // Já existe um banco no Volume. Mas se ele estiver VAZIO (0 conversas),
      // foi criado por um deploy anterior SEM histórico — nesse caso importa
      // o seed por cima. Se tiver conversas de verdade, NÃO mexe (nunca
      // sobrescreve dado real).
      try {
        const { DatabaseSync } = require('node:sqlite');
        const atualDb = new DatabaseSync(alvo);
        const temLeads = atualDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='leads'").get().n;
        const nLeads = temLeads ? atualDb.prepare('SELECT COUNT(*) n FROM leads').get().n : 0;
        atualDb.close();
        if (nLeads === 0) precisaImportar = true;
      } catch (e) {
        // Se não deu pra ler o banco atual, não arrisca sobrescrever.
      }
    }
    if (precisaImportar) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(seed, alvo);
      console.log(`>> Histórico importado de ${path.basename(seed)} para o Volume (banco estava vazio).`);
    } else {
      console.log('>> Banco do Volume já tem conversas — seed ignorado (não sobrescreve).');
    }
  } catch (e) {
    console.error('>> Falha ao importar o seed:', e.message);
  }
})();

const db = require('./db');
const ai = require('./ai');
const authLib = require('./auth');
const zapi = require('./zapi');
const claudeIA = require('./claude');
const push = require('./push');
const agendador = require('./agendador');
const backup = require('./backup');
const midia = require('./midia');

// EDIÇÃO DE SETOR ÚNICO: este sistema inteiro atende UM setor só, fixado
// pela variável de ambiente SETOR (vendas | financeiro | expedicao). Tudo
// no sistema — leads, conversas, relatórios — pertence a esse setor. Não
// existe troca de setor, nem mistura possível: cada setor roda numa cópia
// separada deste mesmo código, com seu próprio banco e seu próprio WhatsApp.
const SETOR = (process.env.SETOR || 'vendas').toLowerCase();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
  // HTML, JS e CSS sempre revalidam com o servidor antes de usar o cache —
  // assim todo deploy novo aparece na hora (o cache antigo do app.js era o
  // motivo de "subi o arquivo mas continua igual"). Imagens e demais assets
  // seguem o cache padrão do navegador.
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// ---------------------------------------------------------------
// MIDDLEWARES DE AUTENTICAÇÃO
// ---------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.cookies.sessao;
  const usuario = token ? authLib.pegarSessao(token) : null;
  if (!usuario) return res.status(401).json({ erro: 'não autenticado' });
  req.usuario = usuario;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'ação restrita ao administrador' });
  }
  next();
}

// "Supervisor" tem a mesma visibilidade e ações do admin, EXCETO trocar
// senha e ver relatório (essas duas continuam exclusivas de requireAdmin).
function ehGestor(usuario) {
  return usuario && (usuario.role === 'admin' || usuario.role === 'supervisor');
}
function requireGestor(req, res, next) {
  if (!ehGestor(req.usuario)) {
    return res.status(403).json({ erro: 'ação restrita a administrador ou supervisor' });
  }
  next();
}

// ---------------------------------------------------------------
// SETOR ÚNICO: como o sistema inteiro atende um setor só (SETOR), estes
// helpers simplesmente devolvem sempre esse setor. As consultas do resto
// do código continuam com o "AND setor_id = ?" de sempre (agora sempre o
// mesmo setor) — por isso não precisei reescrever nenhuma delas, o que
// preserva todas as correções já feitas. Todo mundo que está logado neste
// sistema, por definição, pertence a este setor.
// ---------------------------------------------------------------
function setoresPermitidosDoUsuario(usuario) {
  return [SETOR];
}

// Sempre o setor fixo deste sistema — ignora qualquer ?setor= da query.
function resolverSetorAtivo(usuario, slugQuery) {
  return db.getSetorPorSlug(SETOR);
}

// Em setor único, quem está logado sempre pode acessar os leads (todos são
// do mesmo setor). Mantido como função pra não mexer nos ~15 pontos que a
// chamam como guarda.
function usuarioAcessaLead(usuario, lead) {
  return true;
}

// ---------------------------------------------------------------
// LOGIN / LOGOUT / SESSÃO ATUAL
// ---------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { login, senha, setor } = req.body;
  if (!login || !senha) {
    return res.status(400).json({ erro: 'login e senha são obrigatórios' });
  }

  const vendedor = db.prepare('SELECT * FROM vendedores WHERE login = ?').get(login);
  if (!vendedor || !authLib.verificarSenha(senha, vendedor.senha_hash)) {
    return res.status(401).json({ erro: 'login ou senha inválidos' });
  }

  // Setor único: todo mundo deste sistema pertence ao mesmo setor.
  const setoresPermitidos = [SETOR];

  const token = authLib.criarSessao(vendedor, setoresPermitidos);
  res.cookie('sessao', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, usuario: { id: vendedor.id, nome: vendedor.nome, role: vendedor.role, setoresPermitidos } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessao;
  if (token) authLib.destruirSessao(token);
  res.clearCookie('sessao');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  // A sessão guarda uma "foto" do usuário tirada no momento do login —
  // se o admin editar nome/cargo/setor de alguém depois, quem já está
  // logado só veria a mudança deslogando e logando de novo. Buscando
  // fresco do banco aqui, a mudança aparece na hora, sem precisar disso.
  const vendedor = db.prepare('SELECT id, nome, login, role FROM vendedores WHERE id = ?').get(req.usuario.id);
  if (!vendedor) return res.status(401).json({ erro: 'conta não existe mais' });

  res.json({ ...vendedor, setoresPermitidos: [SETOR] });
});

// Autoatendimento: qualquer vendedor troca a própria senha, desde que
// informe a senha atual corretamente. Diferente do endpoint de admin
// (/api/vendedores/:id/redefinir-senha), que não pede a senha antiga —
// esse aqui é o "esqueci minha senha" normal, sem depender do admin.
app.post('/api/me/senha', requireAuth, (req, res) => {
  const { senha_atual, senha_nova } = req.body;
  if (!senha_atual || !senha_nova) {
    return res.status(400).json({ erro: 'informe a senha atual e a nova senha' });
  }
  if (senha_nova.length < 4) {
    return res.status(400).json({ erro: 'a nova senha precisa ter pelo menos 4 caracteres' });
  }
  const vendedor = db.prepare('SELECT * FROM vendedores WHERE id = ?').get(req.usuario.id);
  if (!vendedor || !authLib.verificarSenha(senha_atual, vendedor.senha_hash)) {
    return res.status(401).json({ erro: 'senha atual incorreta' });
  }
  const novoHash = authLib.hashSenha(senha_nova);
  db.prepare('UPDATE vendedores SET senha_hash = ? WHERE id = ?').run(novoHash, req.usuario.id);
  res.json({ ok: true });
});

// Setor único: este sistema tem um setor só. Mantido pra compatibilidade
// com qualquer chamada antiga do frontend — devolve sempre esse setor.
app.get('/api/setores', requireAuth, (req, res) => {
  res.json([db.getSetorPorSlug(SETOR)]);
});

// Serve os arquivos de mídia guardados no Volume (fotos, documentos, áudios,
// vídeos). Exige login — como é a mesma origem, o cookie de sessão vai junto
// automaticamente no <img src> / <a href>, então funciona pra exibir e baixar.
app.get('/midia/:arquivo', requireAuth, (req, res) => {
  const caminho = midia.caminhoDoArquivo(req.params.arquivo);
  if (!caminho) return res.status(404).json({ erro: 'mídia não encontrada' });
  res.sendFile(caminho);
});

// ---------------------------------------------------------------
// NOTIFICAÇÃO PUSH — mensagem nova ou lead novo mesmo com o app fechado
// ---------------------------------------------------------------
app.get('/api/push/public-key', requireAuth, (req, res) => {
  res.json({ publicKey: push.publicKey });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  try {
    push.salvarInscricao(req.usuario.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ erro: 'endpoint é obrigatório' });
  push.removerInscricao(endpoint);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// CADASTRO DE VENDEDOR (só admin)
// ---------------------------------------------------------------
app.post('/api/vendedores', requireAuth, requireAdmin, (req, res) => {
  const { nome, login, senha, role, setores } = req.body;
  if (!nome || !login || !senha) {
    return res.status(400).json({ erro: 'nome, login e senha são obrigatórios' });
  }
  if (senha.length < 4) {
    return res.status(400).json({ erro: 'senha muito curta (mínimo 4 caracteres)' });
  }

  const existente = db.prepare('SELECT id FROM vendedores WHERE login = ?').get(login);
  if (existente) {
    return res.status(409).json({ erro: 'esse login já está em uso' });
  }

  // Só um admin de verdade pode criar outro admin ou supervisor — um
  // supervisor cadastrando alguém só consegue criar vendedor comum,
  // pra não dar pra ele mesmo escalar privilégio.
  const rolesPermitidas = req.usuario.role === 'admin' ? ['admin', 'supervisor', 'vendedor'] : ['vendedor'];
  const roleFinal = rolesPermitidas.includes(role) ? role : 'vendedor';
  const senha_hash = authLib.hashSenha(senha);
  const info = db.prepare(`
    INSERT INTO vendedores (nome, login, senha_hash, role, disponivel)
    VALUES (?, ?, ?, ?, 1)
  `).run(nome, login, senha_hash, roleFinal);

  // Quais setores esse vendedor acessa. Se a tela que chamou esse endpoint
  // ainda não manda esse campo (front atual não manda), cai no padrão
  // 'vendas' — mantém o comportamento de hoje sem quebrar nada.
  const slugsRecebidos = Array.isArray(setores) && setores.length > 0 ? setores : ['vendas'];
  const inserirAcesso = db.prepare(`INSERT OR IGNORE INTO vendedor_setores (vendedor_id, setor_id) VALUES (?, ?)`);
  for (const slug of slugsRecebidos) {
    const setor = db.getSetorPorSlug(slug);
    if (setor) inserirAcesso.run(info.lastInsertRowid, setor.id);
  }

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Admin redefine a senha de qualquer vendedor — inclusive a própria (é o
// mesmo endpoint: admin passando o próprio id troca a própria senha).
app.post('/api/vendedores/:id/redefinir-senha', requireAuth, requireAdmin, (req, res) => {
  const { senha } = req.body;
  if (!senha || senha.length < 4) {
    return res.status(400).json({ erro: 'senha muito curta (mínimo 4 caracteres)' });
  }

  const vendedor = db.prepare('SELECT id FROM vendedores WHERE id = ?').get(req.params.id);
  if (!vendedor) return res.status(404).json({ erro: 'vendedor não encontrado' });

  const senha_hash = authLib.hashSenha(senha);
  db.prepare('UPDATE vendedores SET senha_hash = ? WHERE id = ?').run(senha_hash, req.params.id);

  res.json({ ok: true });
});

// Admin edita nome, login ou nível de acesso de qualquer conta.
app.patch('/api/vendedores/:id', requireAuth, requireAdmin, (req, res) => {
  const { nome, login, role, setores } = req.body;

  const vendedor = db.prepare('SELECT * FROM vendedores WHERE id = ?').get(req.params.id);
  if (!vendedor) return res.status(404).json({ erro: 'vendedor não encontrado' });

  if (login && login !== vendedor.login) {
    const emUso = db.prepare('SELECT id FROM vendedores WHERE login = ? AND id != ?').get(login, req.params.id);
    if (emUso) return res.status(409).json({ erro: 'esse login já está em uso' });
  }

  const roleFinal = ['admin', 'supervisor', 'vendedor'].includes(role) ? role : vendedor.role;

  db.prepare(`UPDATE vendedores SET nome = ?, login = ?, role = ? WHERE id = ?`)
    .run(nome || vendedor.nome, login || vendedor.login, roleFinal, req.params.id);

  // Só mexe nos setores se o campo veio na requisição — a tela de edição
  // atual não manda esse campo ainda, então sem ele nada muda no acesso
  // que o vendedor já tinha.
  if (Array.isArray(setores)) {
    db.prepare(`DELETE FROM vendedor_setores WHERE vendedor_id = ?`).run(req.params.id);
    const inserirAcesso = db.prepare(`INSERT OR IGNORE INTO vendedor_setores (vendedor_id, setor_id) VALUES (?, ?)`);
    for (const slug of setores) {
      const setor = db.getSetorPorSlug(slug);
      if (setor) inserirAcesso.run(req.params.id, setor.id);
    }
  }

  res.json({ ok: true });
});

app.delete('/api/vendedores/:id', requireAuth, requireAdmin, (req, res) => {
  const idAlvo = Number(req.params.id);
  const vendedor = db.prepare('SELECT * FROM vendedores WHERE id = ?').get(idAlvo);
  if (!vendedor) return res.status(404).json({ erro: 'vendedor não encontrado' });

  if (idAlvo === req.usuario.id) {
    return res.status(400).json({ erro: 'você não pode excluir a própria conta' });
  }
  if (vendedor.role === 'admin') {
    const totalAdmins = db.prepare(`SELECT COUNT(*) AS n FROM vendedores WHERE role = 'admin'`).get().n;
    if (totalAdmins <= 1) {
      return res.status(400).json({ erro: 'esse é o único administrador — não dá pra excluir' });
    }
  }
  const atendimentosAtivos = db.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE vendedor_id = ? AND status = 'em_atendimento'`
  ).get(idAlvo).n;
  if (atendimentosAtivos > 0) {
    return res.status(409).json({ erro: `esse vendedor ainda tem ${atendimentosAtivos} conversa(s) em atendimento — transfira antes de excluir` });
  }

  // Leads/lembretes antigos mantêm o vendedor_id como referência histórica
  // (não apaga nada de conversa nem relatório) — só desliga o acesso e o
  // cadastro em si.
  db.prepare('DELETE FROM vendedor_setores WHERE vendedor_id = ?').run(idAlvo);
  db.prepare('DELETE FROM metas WHERE vendedor_id = ?').run(idAlvo);
  db.prepare('DELETE FROM vendedores WHERE id = ?').run(idAlvo);

  res.json({ ok: true });
});

// ---------------------------------------------------------------
// WEBHOOKS — dois pontos de entrada:
//   /webhook/message  → simulado (usado pelo scripts/simulate-*.js e testes)
//   /webhook/zapi     → mensagens reais do WhatsApp via Z-API
// Ambos convergem na mesma função de processamento, então a lógica de
// negócio (anti-duplicação, IA, criação de lead) só existe uma vez.
// Nenhum dos dois exige login: são origens externas alimentando o sistema.
// ---------------------------------------------------------------

// Processa uma mensagem recebida (de onde quer que tenha vindo) e retorna
// o resultado. Envia a boas-vindas automática de volta pro WhatsApp de
// verdade quando a Z-API estiver configurada (enviarMensagemWhatsapp vira
// no-op silencioso se não estiver — ver zapi.js).
// Interruptor da mensagem automática de boas-vindas. Desliga só isso —
// o resto do sistema (fila, conversa, envio manual do vendedor) continua
// 100% normal. Pra desligar: variável BOAS_VINDAS_AUTOMATICA=false no Railway.
// Sem a variável (ou qualquer outro valor), fica ligado por padrão.
const BOAS_VINDAS_ATIVA = process.env.BOAS_VINDAS_AUTOMATICA !== 'false';
if (!BOAS_VINDAS_ATIVA) {
  console.log('>> Mensagem automática de boas-vindas DESLIGADA (BOAS_VINDAS_AUTOMATICA=false) — só envio manual do vendedor está ativo.');
}

// Corpo da notificação não pode ser um romance — trunca mantendo legível.
function truncar(texto, tamanho = 100) {
  if (!texto) return '';
  return texto.length > tamanho ? texto.slice(0, tamanho - 1) + '…' : texto;
}

async function processarMensagemRecebida({ telefone, nome_cliente, texto, origem, midia_url, midia_tipo, setor = 'vendas', isGrupo = false, zapiMessageId = null, zapiReferenceMessageId = null }) {
  const setorObj = db.getSetorPorSlug(setor) || db.getSetorPorSlug('vendas');

  // Mídia que chega do cliente vem como LINK da Z-API (que pode expirar).
  // Baixamos pro Volume na hora e guardamos como arquivo permanente — assim
  // a foto/documento não some depois. Se o download falhar, mantém o link.
  if (midia_url) {
    midia_url = await midia.salvarDeUrl(midia_url, { tipo: midia_tipo });
  }

  // Normaliza só telefone de conversa individual — o "telefone" de um
  // grupo é na verdade o ID do grupo (tem letras/traço), não um número
  // de verdade, então não pode passar pela limpeza de dígitos.
  if (!isGrupo) telefone = db.normalizarTelefone(telefone);

  // Formas equivalentes do número (com/sem o nono dígito) — a busca por lead
  // existente compara por QUALQUER uma delas, pra não duplicar o mesmo cliente
  // só porque a Z-API mandou o número num formato diferente da outra vez.
  const variantesTel = isGrupo ? [telefone] : db.variantesTelefone(telefone);
  const phTel = variantesTel.map(() => '?').join(',');

  // Contato já salvo pela equipe tem prioridade sobre o nome que vem do
  // WhatsApp (push name) — sem isso, toda mensagem nova ia sobrescrever o
  // nome que a equipe escolheu com o nome "de fábrica" do WhatsApp.
  const contatoSalvo = !isGrupo ? db.getContatoPorTelefone(telefone) : null;
  if (contatoSalvo) nome_cliente = contatoSalvo.nome;

  // Se essa mensagem é uma resposta a outra (a pessoa citou/respondeu
  // direto no WhatsApp, não pelo nosso sistema), resolve pro ID interno
  // da mensagem original — é o que faz a citação aparecer certinho aqui
  // dentro também, não só quando a resposta parte do nosso painel.
  let respondeAResolvido = null;
  if (zapiReferenceMessageId) {
    const original = db.prepare('SELECT id FROM mensagens WHERE zapi_message_id = ?').get(zapiReferenceMessageId);
    if (original) respondeAResolvido = original.id;
  }

  const leadExistente = db.prepare(`
    SELECT * FROM leads WHERE telefone IN (${phTel}) AND setor_id = ? ORDER BY criado_em DESC LIMIT 1
  `).get(...variantesTel, setorObj.id);

  if (leadExistente && leadExistente.status !== 'encerrado') {
    // Conversa já em aberto (novo ou em_atendimento) — só adiciona a mensagem
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, zapi_message_id, responde_a) VALUES (?, 'cliente', ?, ?, ?, ?, ?)`)
      .run(leadExistente.id, texto, midia_url || null, midia_tipo || null, zapiMessageId, respondeAResolvido);

    // Notifica só se já tem dono — se ainda tá "novo" esperando alguém
    // puxar, já mandou push na criação; não fica reenviando a cada
    // mensagem nova pra não virar spam pra quem ainda não pegou.
    if (leadExistente.status === 'em_atendimento' && leadExistente.vendedor_id) {
      push.notificarVendedor(leadExistente.vendedor_id, {
        titulo: `💬 ${leadExistente.nome_cliente || leadExistente.telefone}`,
        corpo: truncar(texto) || (midia_tipo ? `[${midia_tipo}]` : 'Nova mensagem'),
        leadId: leadExistente.id,
      }).catch((err) => console.error('>> Falha ao notificar vendedor:', err.message));
    }

    return { lead_id: leadExistente.id, info: 'mensagem adicionada a conversa existente (lead não duplicado)' };
  }

  if (leadExistente && leadExistente.status === 'encerrado') {
    // Cliente que já conversou antes volta a escrever — reabre a conversa
    // antiga (com todo o histórico) em vez de criar um lead do zero.
    // Se já tinha vendedor, volta pra ele; se nunca teve, volta pra fila.
    const novoStatus = (isGrupo || leadExistente.vendedor_id) ? 'em_atendimento' : 'novo';
    // Quando volta pra fila ('novo'), atualiza criado_em pra AGORA. Sem isso,
    // a fila (que filtra por "date(criado_em) = hoje") nunca mostra esse lead
    // de novo depois de reaberto em outro dia — ele fica escondido no sistema
    // até alguém pensar em ir catar numa data antiga pelo filtro do admin.
    // Leads que voltam direto pra 'em_atendimento' não usam esse filtro de
    // data, então não precisam disso.
    if (novoStatus === 'novo') {
      db.prepare(`UPDATE leads SET status = ?, criado_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`)
        .run(novoStatus, leadExistente.id);
    } else {
      db.prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(novoStatus, leadExistente.id);
    }
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, zapi_message_id, responde_a) VALUES (?, 'cliente', ?, ?, ?, ?, ?)`)
      .run(leadExistente.id, texto, midia_url || null, midia_tipo || null, zapiMessageId, respondeAResolvido);

    if (novoStatus === 'em_atendimento' && leadExistente.vendedor_id) {
      push.notificarVendedor(leadExistente.vendedor_id, {
        titulo: `💬 ${leadExistente.nome_cliente || leadExistente.telefone}`,
        corpo: truncar(texto) || (midia_tipo ? `[${midia_tipo}]` : 'Conversa reaberta'),
        leadId: leadExistente.id,
      }).catch((err) => console.error('>> Falha ao notificar vendedor:', err.message));
    } else if (novoStatus === 'em_atendimento') {
      push.notificarTodosVendedores({
        titulo: `💬 ${leadExistente.nome_cliente || leadExistente.telefone}`,
        corpo: truncar(texto) || (midia_tipo ? `[${midia_tipo}]` : 'Conversa reaberta'),
        leadId: leadExistente.id,
      }).catch((err) => console.error('>> Falha ao notificar vendedores:', err.message));
    } else {
      push.notificarTodosVendedores({
        titulo: '🆕 Lead voltou pra fila',
        corpo: `${leadExistente.nome_cliente || leadExistente.telefone}: ${truncar(texto)}`,
        leadId: leadExistente.id,
      }).catch((err) => console.error('>> Falha ao notificar vendedores:', err.message));
    }

    return { lead_id: leadExistente.id, info: 'conversa antiga reaberta' };
  }

  const oportunidades = ai.identificarOportunidade(texto);
  let interesse = oportunidades.length > 0 ? oportunidades.join(', ') : null;
  let boasVindas = null;

  // Boas-vindas automática não faz sentido pra grupo — é conversa interna
  // (motorista, vendedor), não cliente novo chegando pela primeira vez.
  if (BOAS_VINDAS_ATIVA && !isGrupo) {
    // Tenta gerar boas-vindas + resumo com IA de verdade; se não estiver
    // configurada (ou falhar), cai pro stub de palavra-chave (ai.js).
    const iaResposta = await claudeIA.processarNovaMensagem(texto, nome_cliente);
    if (iaResposta && iaResposta.interesse) interesse = iaResposta.interesse;
    boasVindas = (iaResposta && iaResposta.boas_vindas) || ai.gerarMensagemBoasVindas(texto, nome_cliente);
  }

  // Rede de segurança contra CORRIDA: entre a busca lá em cima e aqui teve um
  // await (as boas-vindas da IA). Se nesse meio-tempo outra mensagem do MESMO
  // cliente chegou em rajada (ex: instância reconectou e despejou várias de
  // uma vez) e já criou o lead, gruda a mensagem nele em vez de criar um
  // segundo. Não há await entre esta checagem e o INSERT abaixo, então do
  // ponto de vista do event loop é atômico — a corrida não passa.
  if (!isGrupo) {
    const jaCriado = db.prepare(`
      SELECT * FROM leads WHERE telefone IN (${phTel}) AND setor_id = ? AND status != 'encerrado' ORDER BY criado_em DESC LIMIT 1
    `).get(...variantesTel, setorObj.id);
    if (jaCriado) {
      db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, zapi_message_id, responde_a) VALUES (?, 'cliente', ?, ?, ?, ?, ?)`)
        .run(jaCriado.id, texto, midia_url || null, midia_tipo || null, zapiMessageId, respondeAResolvido);
      return { lead_id: jaCriado.id, info: 'corrida evitada: mensagem grudada em lead recém-criado (não duplicado)' };
    }
  }

  const insertLead = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, interesse, setor_id, is_grupo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertLead.run(telefone, nome_cliente || null, texto, origem || 'geral', isGrupo ? 'em_atendimento' : 'novo', interesse, setorObj.id, isGrupo ? 1 : 0);
  const leadId = info.lastInsertRowid;

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, zapi_message_id, responde_a) VALUES (?, 'cliente', ?, ?, ?, ?, ?)`)
    .run(leadId, texto, midia_url || null, midia_tipo || null, zapiMessageId, respondeAResolvido);

  push.notificarTodosVendedores({
    titulo: isGrupo ? '👥 Nova mensagem em grupo' : '🆕 Novo lead',
    corpo: `${nome_cliente || telefone}: ${truncar(texto)}`,
    leadId,
  }).catch((err) => console.error('>> Falha ao notificar vendedores:', err.message));

  if (boasVindas) {
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'ia', ?)`)
      .run(leadId, boasVindas);
    // Manda a boas-vindas de verdade pro WhatsApp do cliente (se configurado)
    await zapi.enviarMensagemWhatsapp(telefone, boasVindas, setor);
  }

  return { lead_id: leadId, mensagem_boas_vindas: boasVindas, oportunidades_detectadas: oportunidades };
}

app.post('/webhook/message', async (req, res) => {
  const { telefone, nome_cliente, texto, origem } = req.body;
  if (!telefone || !texto) {
    return res.status(400).json({ erro: 'telefone e texto são obrigatórios' });
  }
  const resultado = await processarMensagemRecebida({ telefone, nome_cliente, texto, origem });
  res.status(resultado.mensagem_boas_vindas ? 201 : 200).json(resultado);
});

// Webhook real da Z-API — configure essa URL no painel de CADA instância,
// em "Webhooks" → "Ao receber" (ReceivedCallback):
//   Vendas:     https://SEU-DOMINIO/webhook/zapi              (é a de sempre, não muda)
//   Financeiro: https://SEU-DOMINIO/webhook/zapi/financeiro
//   Expedição:  https://SEU-DOMINIO/webhook/zapi/expedicao
async function processarWebhookMensagem(req, res) {
  {
    // TRAVA DE ISOLAMENTO: este sistema atende um setor só e só aceita
    // mensagens da SUA própria instância da Z-API. Se por engano chegar um
    // webhook de outra instância (link "Ao receber" apontado pra cá por
    // erro), a mensagem é recusada aqui — nunca é gravada. É isso que torna
    // impossível uma conversa de outro setor cair neste sistema: não depende
    // da configuração da Z-API estar certa, e sim desta regra do código.
    const instanceId = req.body && req.body.instanceId;
    if (!zapi.instanciaPropria(instanceId)) {
      console.warn(`>> [ISOLAMENTO] Webhook de instância estranha (${instanceId}) recusado. Este sistema é do setor "${SETOR}" e só processa a sua própria instância — confira o "Ao receber" no painel da Z-API.`);
      return res.status(200).json({ info: 'instância não pertence a este sistema, ignorado' });
    }
    const setor = SETOR;

    const { telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe, isGrupo, referenceMessageId } = zapi.interpretarWebhook(req.body);
    const setorObj = db.getSetorPorSlug(setor);

    // fromMe: true pode ser (a) eco da mensagem que NÓS mandamos pela API,
    // ou (b) o vendedor respondendo manualmente direto no WhatsApp do celular
    // conectado. No caso (b), registramos a mensagem na conversa também —
    // senão ela fica invisível no sistema mesmo tendo sido enviada de verdade.
    if (fromMe) {
      if (zapi.foiEnviadaPorNos(messageId)) {
        return res.status(200).json({ info: 'eco da nossa própria mensagem, ignorado' });
      }
      if (zapi.jaProcessada(`manual-${messageId}`)) {
        return res.status(200).json({ info: 'mensagem manual já processada antes, ignorada' });
      }
      if (telefone && texto) {
        zapi.marcarProcessada(`manual-${messageId}`);
        // Pega a conversa mais recente desse telefone nesse setor, seja
        // qual for o status — antes só pegava "em_atendimento", e uma
        // resposta manual num lead ainda "novo" (ninguém puxou ainda)
        // ficava de fora do sistema, mesmo tendo sido enviada de verdade.
        // Compara pelas variantes do número (com/sem o nono dígito) pra
        // achar o lead certo mesmo se o formato vier diferente.
        const varsManual = isGrupo ? [telefone] : db.variantesTelefone(telefone);
        const phManual = varsManual.map(() => '?').join(',');
        const leadAtivo = db.prepare(`
          SELECT * FROM leads WHERE telefone IN (${phManual}) AND setor_id = ? ORDER BY criado_em DESC LIMIT 1
        `).get(...varsManual, setorObj.id);
        if (leadAtivo && leadAtivo.status !== 'encerrado') {
          // Segunda camada de proteção contra duplicação: mesmo que o
          // messageId da Z-API não tenha batido com o que registramos no
          // envio (não é 100% garantido pela plataforma), se já existe uma
          // mensagem NOSSA idêntica nos últimos 20 segundos nessa mesma
          // conversa, é o eco do que a gente acabou de mandar — não uma
          // resposta manual de verdade. Evita duplicar.
          const ecoRecente = db.prepare(`
            SELECT id FROM mensagens WHERE lead_id = ? AND remetente = 'vendedor' AND texto = ?
            AND criado_em >= strftime('%Y-%m-%d %H:%M:%f','now','-20 seconds')
            ORDER BY criado_em DESC LIMIT 1
          `).get(leadAtivo.id, texto);
          if (ecoRecente) {
            return res.status(200).json({ info: 'eco recente idêntico já registrado, ignorado' });
          }
          const refManual = midiaUrl ? await midia.salvarDeUrl(midiaUrl, { tipo: midiaTipo }) : null;
          db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'vendedor', ?, ?, ?)`)
            .run(leadAtivo.id, texto, refManual, midiaTipo || null);
          // Responder manualmente já "puxa" a conversa pra atendimento —
          // alguém da equipe claramente já está cuidando dela.
          if (leadAtivo.status === 'novo') {
            db.prepare(`UPDATE leads SET status = 'em_atendimento' WHERE id = ?`).run(leadAtivo.id);
          }
          return res.status(200).json({ info: 'mensagem manual do vendedor registrada na conversa' });
        }
      }
      return res.status(200).json({ info: 'mensagem enviada por nós (sem lead ativo correspondente), ignorada' });
    }
    if (zapi.jaProcessada(messageId)) {
      return res.status(200).json({ info: 'mensagem já processada antes (duplicada), ignorada' });
    }
    if (!telefone || !texto) {
      return res.status(200).json({ info: 'payload sem telefone/texto reconhecível, ignorado' });
    }

    zapi.marcarProcessada(messageId);
    const resultado = await processarMensagemRecebida({
      telefone,
      nome_cliente: nomeCliente,
      texto,
      origem: 'whatsapp',
      midia_url: midiaUrl,
      midia_tipo: midiaTipo,
      setor,
      isGrupo,
      zapiMessageId: messageId,
      zapiReferenceMessageId: referenceMessageId,
    });
    res.status(200).json(resultado);
  }
}

// Um único endereço de "Ao receber" da Z-API — configure este link no
// painel da instância deste setor:  https://SEU-DOMINIO/webhook/zapi
app.post('/webhook/zapi', processarWebhookMensagem);

// ---------------------------------------------------------------
// LEADS
// ---------------------------------------------------------------

// Fila completa: leads 'novo' aparecem por inteiro pra todo mundo.
// Leads em atendimento/encerrados só aparecem por inteiro pro dono
// (quem puxou) ou pro admin — pros demais, só um resumo mínimo
// (nome + interesse), sem telefone e sem conversa.
// Busca por nome/telefone — pra achar conversa antiga (mesmo encerrada) e
// continuar de onde parou. Vendedor só acha as próprias; gestor acha todas.
app.get('/api/leads/buscar', requireAuth, (req, res) => {
  const termo = (req.query.q || '').trim();
  if (termo.length < 2) return res.json([]);

  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);

  const todos = db.prepare(`
    SELECT * FROM leads
    WHERE (nome_cliente LIKE ? OR telefone LIKE ?) AND setor_id = ?
    ORDER BY criado_em DESC LIMIT 30
  `).all(`%${termo}%`, `%${termo}%`, setorAtivo.id);

  // Mesmo formato de dado que /api/leads devolve, pra renderizar
  // exatamente igual na tela (mesmo tamanho, mesmo badge, etc.) —
  // antes essa busca devolvia um resumo mais pobre e o item ficava
  // visualmente diferente do resto da lista.
  const resultado = todos
    .filter((lead) => ehGestor(req.usuario) || lead.vendedor_id === req.usuario.id || lead.status === 'novo' || lead.is_grupo)
    .map((lead) => {
      const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
      const ultima = db.prepare(
        'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(lead.id);
      const vendedor = lead.vendedor_id
        ? db.prepare('SELECT nome FROM vendedores WHERE id = ?').get(lead.vendedor_id)
        : null;
      const naoLidas = lead.visto_em
        ? db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' AND criado_em > ?`).get(lead.id, lead.visto_em).n
        : db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente'`).get(lead.id).n;
      return { ...lead, ultima_mensagem: ultima || null, restrito: false, dono, vendedor_nome: vendedor ? vendedor.nome : null, nao_lidas: naoLidas, contato_salvo: lead.is_grupo ? true : Boolean(db.getContatoPorTelefone(lead.telefone)) };
    });

  res.json(resultado);
});

app.get('/api/leads', requireAuth, (req, res) => {
  const { status, data, setor } = req.query;
  const setorAtivo = resolverSetorAtivo(req.usuario, setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  let leads;

  if (status) {
    const statusList = status.split(',').map((s) => s.trim());
    const placeholders = statusList.map(() => '?').join(',');

    if (statusList.length === 1 && statusList[0] === 'novo') {
      // Fila de leads novos: por padrão mostra TODO lead ainda não puxado,
      // de qualquer dia — um lead esperando há 2 dias é mais urgente, não
      // menos, então não faz sentido escondê-lo da fila por padrão.
      // O filtro de data agora é só uma lupa opcional (admin ou vendedor
      // podem usar pra olhar só um dia específico, se quiserem).
      if (data) {
        leads = db.prepare(`
          SELECT * FROM leads WHERE status IN (${placeholders}) AND setor_id = ? AND date(criado_em) = date(?)
          ORDER BY criado_em ASC
        `).all(...statusList, setorAtivo.id, data);
      } else {
        leads = db.prepare(`
          SELECT * FROM leads WHERE status IN (${placeholders}) AND setor_id = ?
          ORDER BY criado_em ASC
        `).all(...statusList, setorAtivo.id);
      }
    } else {
      // Conversas ativas + histórico. Antes trazia TODO encerrado que já
      // existiu (acumulava pra sempre) e rodava sub-consultas pra cada um a
      // cada 3s — era o que deixava tudo lento conforme os dados cresciam.
      // Agora: em_atendimento SEMPRE; encerrado só o recente (últimos 2 dias,
      // que é o que a tela de fato mostra). Encerradas mais antigas continuam
      // acessíveis pela BUSCA, que não tem esse limite.
      const querEncerrado = statusList.includes('encerrado');
      const outros = statusList.filter((s) => s !== 'encerrado');
      const cond = [];
      const params = [setorAtivo.id];
      if (outros.length) {
        cond.push(`status IN (${outros.map(() => '?').join(',')})`);
        params.push(...outros);
      }
      if (querEncerrado) {
        cond.push(`(status = 'encerrado' AND COALESCE(encerrado_em, criado_em) >= datetime('now','-2 days'))`);
      }
      leads = db.prepare(`SELECT * FROM leads WHERE setor_id = ? AND (${cond.join(' OR ')}) ORDER BY criado_em DESC`).all(...params);
    }
  } else {
    leads = db.prepare('SELECT * FROM leads WHERE setor_id = ? ORDER BY criado_em DESC').all(setorAtivo.id);
  }

  const resultado = leads.map((lead) => {
    const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
    const podeVerTudo = ehGestor(req.usuario) || dono || lead.status === 'novo';

    if (podeVerTudo) {
      const ultima = db.prepare(
        'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(lead.id);
      const vendedor = lead.vendedor_id
        ? db.prepare('SELECT nome FROM vendedores WHERE id = ?').get(lead.vendedor_id)
        : null;
      // Mensagens do cliente desde a última vez que alguém abriu essa conversa
      const naoLidas = lead.visto_em
        ? db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' AND criado_em > ?`).get(lead.id, lead.visto_em).n
        : db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente'`).get(lead.id).n;
      return { ...lead, ultima_mensagem: ultima || null, restrito: false, dono, vendedor_nome: vendedor ? vendedor.nome : null, nao_lidas: naoLidas, contato_salvo: lead.is_grupo ? true : Boolean(db.getContatoPorTelefone(lead.telefone)) };
    }

    // Versão restrita: só dados mínimos
    return {
      id: lead.id,
      nome_cliente: lead.nome_cliente,
      interesse: lead.interesse,
      origem: lead.origem,
      status: lead.status,
      criado_em: lead.criado_em,
      restrito: true,
      dono: false,
    };
  });

  res.json(resultado);
});

app.get('/api/leads/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  const podeVer = ehGestor(req.usuario) || dono || lead.status === 'novo';
  if (!podeVer) {
    return res.status(403).json({ erro: 'este lead já está sendo atendido por outro vendedor' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);

  // Marca como "visto agora" — zera o badge de não lida pra quem abriu
  if (dono || ehGestor(req.usuario)) {
    db.prepare(`UPDATE leads SET visto_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`).run(req.params.id);
  }

  res.json({ ...lead, mensagens, dono, contato_salvo: lead.is_grupo ? true : Boolean(db.getContatoPorTelefone(lead.telefone)) });
});

// Marca como não lida de propósito — útil pra "lembrar de responder depois".
// Recua visto_em pra 1ms antes da mensagem mais recente da conversa, então
// o badge de não lida volta a aparecer (pelo menos com a última mensagem).
app.post('/api/leads/:id/marcar-nao-lida', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }
  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode marcar como não lida' });
  }
  const ultima = db.prepare('SELECT criado_em FROM mensagens WHERE lead_id = ? ORDER BY criado_em DESC LIMIT 1').get(req.params.id);
  if (!ultima) return res.status(400).json({ erro: 'conversa sem mensagem ainda' });
  db.prepare(`UPDATE leads SET visto_em = datetime(?, '-1 seconds') WHERE id = ?`).run(ultima.criado_em, req.params.id);
  res.json({ ok: true });
});

app.patch('/api/leads/:id/mensagens/:msgId', requireAuth, async (req, res) => {
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ erro: 'texto não pode ficar vazio' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) return res.status(403).json({ erro: 'sem permissão nessa conversa' });

  const msg = db.prepare('SELECT * FROM mensagens WHERE id = ? AND lead_id = ?').get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ erro: 'mensagem não encontrada' });
  if (msg.remetente !== 'vendedor') return res.status(400).json({ erro: 'só dá pra editar mensagem enviada pela equipe' });
  if (msg.apagada) return res.status(400).json({ erro: 'mensagem já foi apagada' });

  db.prepare(`UPDATE mensagens SET texto = ?, editada = 1 WHERE id = ?`).run(texto.trim(), msg.id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id/mensagens/:msgId', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) return res.status(403).json({ erro: 'sem permissão nessa conversa' });

  const msg = db.prepare('SELECT * FROM mensagens WHERE id = ? AND lead_id = ?').get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ erro: 'mensagem não encontrada' });
  if (msg.remetente !== 'vendedor') return res.status(400).json({ erro: 'só dá pra apagar mensagem enviada pela equipe' });

  // Soft delete: o texto/mídia somem da tela, mas a linha continua
  // existindo (senão uma citação apontando pra essa mensagem quebraria).
  db.prepare(`UPDATE mensagens SET apagada = 1, texto = 'Mensagem apagada', midia_url = NULL, midia_tipo = NULL, midia_nome = NULL WHERE id = ?`).run(msg.id);
  res.json({ ok: true });
});

// Vendedor logado "puxa" o lead pra si (não seleciona mais quem — é sempre quem está logado)
app.post('/api/leads/:id/claim', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  if (lead.is_grupo) {
    return res.status(400).json({ erro: 'conversa de grupo não tem dono — qualquer um do setor já pode responder direto' });
  }
  if (lead.vendedor_id) {
    return res.status(409).json({ erro: 'lead já foi puxado por outro vendedor' });
  }

  // Limite de 5 conversas simultâneas por vendedor em Vendas — evita
  // acumular lead sem fechar; admin/supervisor não têm esse limite.
  const setorDoLeadClaim = db.prepare('SELECT slug FROM setores WHERE id = ?').get(lead.setor_id);
  if (setorDoLeadClaim && setorDoLeadClaim.slug === 'vendas' && !ehGestor(req.usuario)) {
    const ativos = db.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE vendedor_id = ? AND status = 'em_atendimento' AND setor_id = ?`
    ).get(req.usuario.id, lead.setor_id).n;
    if (ativos >= 5) {
      return res.status(409).json({ erro: 'Você já está com 5 conversas simultâneas em Vendas. Feche alguma antes de pegar outro lead.' });
    }
  }

  const vendedorId = req.usuario.id;
  db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
    .run(vendedorId, req.params.id);

  // Cria automaticamente um lembrete de follow-up daqui a 2 dias
  const daqui2dias = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
    VALUES (?, ?, ?, ?, 'ligacao', strftime('%Y-%m-%d %H:%M:%f','now'))
  `).run(req.params.id, vendedorId, `Verificar se ${lead.nome_cliente || lead.telefone} fechou o pedido`, daqui2dias);

  res.json({ ok: true });
});

// Transferir atendimento pra outro vendedor — dono do lead ou gestor.
// Mantém todo o histórico, só troca quem é responsável.
app.post('/api/leads/:id/transferir', requireAuth, (req, res) => {
  const { novo_vendedor_id } = req.body;
  if (!novo_vendedor_id) return res.status(400).json({ erro: 'informe pra quem transferir' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }
  if (lead.is_grupo) {
    return res.status(400).json({ erro: 'conversa de grupo é de todo mundo do setor — não tem como transferir' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode transferir' });
  }

  const novoVendedor = db.prepare('SELECT id FROM vendedores WHERE id = ?').get(novo_vendedor_id);
  if (!novoVendedor) return res.status(404).json({ erro: 'vendedor de destino não encontrado' });

  db.prepare(`UPDATE leads SET vendedor_id = ?, status = 'em_atendimento' WHERE id = ?`)
    .run(novo_vendedor_id, req.params.id);

  res.json({ ok: true });
});

// Vendedor registra um lead manualmente (cliente que veio por outro canal —
// telefone, presencial). Fica marcado como "nota" — não dispara mensagem
// nenhuma pro WhatsApp sozinho. Se o vendedor quiser mandar mensagem de
// verdade depois, faz isso normalmente pela conversa (decisão dele, com
// o mesmo cuidado de sempre sobre iniciar conversa com número novo).
app.post('/api/leads/manual', requireAuth, (req, res) => {
  const { nome_cliente, observacao, setor } = req.body;
  if (!req.body.telefone) return res.status(400).json({ erro: 'telefone é obrigatório' });
  const telefone = db.normalizarTelefone(req.body.telefone);
  if (telefone.length < 10) return res.status(400).json({ erro: 'telefone parece incompleto — confere o número' });

  const setorAtivo = resolverSetorAtivo(req.usuario, setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);

  // Já existe QUALQUER conversa (aberta OU encerrada) pra esse telefone
  // nesse setor? Então isso aqui não é um contato novo — é só salvar/
  // atualizar o nome de alguém que já é conhecido. Nunca cria uma
  // segunda conversa nem duplica: só atualiza o nome e devolve a
  // conversa que já existe.
  const existenteQualquerStatus = db.prepare(
    `SELECT id, status FROM leads WHERE telefone = ? AND setor_id = ? ORDER BY criado_em DESC LIMIT 1`
  ).get(telefone, setorAtivo.id);
  if (existenteQualquerStatus) {
    if (nome_cliente) db.salvarContato(telefone, nome_cliente, req.usuario.id);
    return res.json({ lead_id: existenteQualquerStatus.id, ja_existia: true, status: existenteQualquerStatus.status });
  }

  if (setorAtivo.slug === 'vendas' && !ehGestor(req.usuario)) {
    const ativos = db.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE vendedor_id = ? AND status = 'em_atendimento' AND setor_id = ?`
    ).get(req.usuario.id, setorAtivo.id).n;
    if (ativos >= 5) {
      return res.status(409).json({ erro: 'Você já está com 5 conversas simultâneas em Vendas. Feche alguma antes de cadastrar outro lead.' });
    }
  }

  const info = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, vendedor_id, setor_id)
    VALUES (?, ?, ?, 'manual', 'em_atendimento', ?, ?)
  `).run(telefone, nome_cliente || null, observacao || 'Lead cadastrado manualmente', req.usuario.id, setorAtivo.id);

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'nota', ?)`)
    .run(info.lastInsertRowid, observacao || `Lead cadastrado manualmente por ${req.usuario.nome}`);

  res.status(201).json({ ok: true, lead_id: info.lastInsertRowid });
});

// Encerrar atendimento — só o dono do lead ou o admin. Encerra em 1 clique,
// a análise diária da IA decide resultado/valor/motivo depois, sozinha.
app.post('/api/leads/:id/encerrar', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode encerrar' });
  }

  // Se o vendedor já disse na hora se fechou ou não, grava isso — senão
  // fica em aberto (null) e a análise diária da IA preenche depois sozinha.
  const { fechou_pedido, valor_venda } = req.body || {};
  if (fechou_pedido === true) {
    // valor_venda fica em aberto (NULL) de propósito — a análise diária da
    // IA lê a conversa e estima o valor depois, sem precisar perguntar
    // pro vendedor na hora de encerrar.
    db.prepare(`
      UPDATE leads SET status = 'encerrado', resultado = 'convertido', valor_venda = ?,
        convertido_em = strftime('%Y-%m-%d %H:%M:%f','now'),
        encerrado_em = strftime('%Y-%m-%d %H:%M:%f','now')
      WHERE id = ?
    `).run(valor_venda != null ? valor_venda : null, req.params.id);
  } else if (fechou_pedido === false) {
    db.prepare(`
      UPDATE leads SET status = 'encerrado', resultado = 'perdido',
        encerrado_em = strftime('%Y-%m-%d %H:%M:%f','now')
      WHERE id = ?
    `).run(req.params.id);
  } else {
    // Encerra em 1 clique sem informar resultado — a análise diária da IA
    // lê a conversa depois e preenche isso sozinha.
    db.prepare(`UPDATE leads SET status = 'encerrado', encerrado_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`).run(req.params.id);
  }

  res.json({ ok: true });
});

// Reabre manualmente uma conversa encerrada — mesmo dono (ou admin/supervisor)
// que puderam encerrar também podem reabrir. Segue a mesma regra do reabrir
// automático (quando o cliente escreve de novo sozinho): não mexe em
// resultado/valor_venda/motivo_perda já registrados, só volta o status —
// se já tinha uma venda contabilizada, ela continua valendo no relatório.
app.post('/api/leads/:id/reabrir', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }
  if (lead.status !== 'encerrado') {
    return res.status(400).json({ erro: 'esse lead não está encerrado' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem atendeu (ou o admin) pode reabrir essa conversa' });
  }

  // Se o lead nunca teve dono (foi encerrado sem ninguém puxar), quem
  // reabre assume o atendimento — mesma regra do claim normal.
  db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
    .run(lead.vendedor_id || req.usuario.id, req.params.id);

  res.json({ ok: true });
});

// Vendedor envia mensagem pro cliente — só o dono do lead ou o admin
app.post('/api/leads/:id/mensagens', requireAuth, async (req, res) => {
  const { texto, midia_base64, midia_tipo, midia_nome, responde_a } = req.body;
  if (!texto && !midia_base64) {
    return res.status(400).json({ erro: 'texto ou anexo é obrigatório' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode responder' });
  }

  const rotulos = { imagem: '[Imagem]', audio: '[Áudio]', video: '[Vídeo]', documento: '[Documento]' };
  let textoFinal = texto || `${rotulos[midia_tipo] || '[Anexo]'}${midia_nome ? ' ' + midia_nome : ''}`;
  let textoParaEnviar = texto;

  // Financeiro e Expedição usam 1 número de WhatsApp pra equipe inteira —
  // sem isso, o cliente não sabe qual pessoa da equipe está falando com
  // ele. Vendas não precisa (histórico dela é 1 vendedor por cliente).
  // Formato "Primeiro Nome + Setor" (ex: "João Expedição") — curto o
  // suficiente pra não poluir a mensagem, mas já deixa claro quem
  // respondeu, evitando o "quem foi que falou comigo?" depois.
  const setorDoLead = db.prepare('SELECT slug, nome FROM setores WHERE id = ?').get(lead.setor_id);
  if (setorDoLead && (setorDoLead.slug === 'financeiro' || setorDoLead.slug === 'expedicao') && texto) {
    const primeiroNome = req.usuario.nome.split(' ')[0];
    const prefixo = `*${primeiroNome} ${setorDoLead.nome}:*\n`;
    textoFinal = prefixo + textoFinal;
    textoParaEnviar = prefixo + texto;
  }

  // Se achou essa conversa pela busca (encerrada) e decidiu escrever de
  // novo, reabre automaticamente — sem precisar de nenhum passo extra.
  if (lead.status === 'encerrado') {
    db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
      .run(lead.vendedor_id || req.usuario.id, req.params.id);
  }

  // Só aceita responder a uma mensagem que é realmente dessa mesma
  // conversa — evita citar mensagem de outro lead por engano/malícia.
  let respondeAValido = null;
  if (responde_a) {
    const msgOriginal = db.prepare('SELECT id FROM mensagens WHERE id = ? AND lead_id = ?').get(responde_a, req.params.id);
    if (msgOriginal) respondeAValido = msgOriginal.id;
  }

  // Guarda a mídia como ARQUIVO no Volume (não base64 no banco). O base64
  // original (midia_base64) continua em memória só pra mandar pra Z-API logo
  // abaixo; no banco fica só a referência curta "/midia/...".
  const refMidia = midia_base64 ? midia.salvarDataUri(midia_base64, { tipo: midia_tipo, nome: midia_nome }) : null;
  const info = db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, midia_nome, responde_a) VALUES (?, 'vendedor', ?, ?, ?, ?, ?)`)
    .run(req.params.id, textoFinal, refMidia, midia_tipo || null, midia_nome || null, respondeAValido);

  // Se está respondendo a uma mensagem específica, pega o ID dela lá na
  // Z-API — é isso que faz o WhatsApp do cliente mostrar a citação de
  // verdade (balãozinho com o trecho da mensagem original em cima),
  // igual acontece quando alguém responde direto pelo app.
  let citarMessageId = null;
  if (respondeAValido) {
    const msgOriginalCompleta = db.prepare('SELECT zapi_message_id FROM mensagens WHERE id = ?').get(respondeAValido);
    if (msgOriginalCompleta && msgOriginalCompleta.zapi_message_id) citarMessageId = msgOriginalCompleta.zapi_message_id;
  }

  // @Menção — quem foi citado ganha uma notificação direcionada, pra
  // valer a pena de verdade usar isso numa conversa de grupo com várias
  // pessoas (senão a menção é só cosmética).
  if (texto) {
    const mencoes = texto.match(/@[a-zA-ZÀ-ÿ0-9_]+(?:\s[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ]*)*/g) || [];
    if (mencoes.length > 0) {
      // Setor único: qualquer pessoa da equipe pode ser mencionada.
      const vendedoresDoSetor = db.prepare(`SELECT id, nome FROM vendedores`).all();
      for (const mencaoTexto of mencoes) {
        const nomeMencionado = mencaoTexto.slice(1).toLowerCase();
        const encontrado = vendedoresDoSetor.find((v) => v.nome.toLowerCase() === nomeMencionado || v.nome.toLowerCase().startsWith(nomeMencionado));
        if (encontrado && encontrado.id !== req.usuario.id) {
          push.notificarVendedor(encontrado.id, {
            titulo: `📣 ${req.usuario.nome} te mencionou`,
            corpo: `${lead.nome_cliente || lead.telefone}: ${truncar(texto)}`,
            leadId: lead.id,
          }).catch((err) => console.error('>> Falha ao notificar menção:', err.message));
        }
      }
    }
  }

  const envio = midia_base64
    ? await zapi.enviarMidiaWhatsapp(lead.telefone, midia_tipo, midia_base64, midia_nome, textoParaEnviar, setorDoLead ? setorDoLead.slug : 'vendas', citarMessageId)
    : await zapi.enviarMensagemWhatsapp(lead.telefone, textoParaEnviar, setorDoLead ? setorDoLead.slug : 'vendas', citarMessageId);

  // Guarda o ID que a Z-API devolveu na NOSSA própria mensagem — assim,
  // se alguém responder a ESSA mensagem depois, também vira citação de
  // verdade no WhatsApp (não só nas respostas ao cliente).
  if (envio.messageId) {
    // Já nasce como 'enviado' — o webhook de status depois promove pra
    // 'entregue' e 'lido' conforme o cliente recebe/abre.
    db.prepare(`UPDATE mensagens SET zapi_message_id = ?, status_entrega = 'enviado' WHERE id = ?`).run(envio.messageId, info.lastInsertRowid);
  } else if (envio.enviado) {
    db.prepare(`UPDATE mensagens SET status_entrega = 'enviado' WHERE id = ?`).run(info.lastInsertRowid);
  }

  res.status(201).json({ ok: true, enviado_whatsapp: envio.enviado });
});

// ---------------------------------------------------------------
// WEBHOOK DE STATUS (confirmação de entrega/leitura da Z-API)
// A Z-API chama esta URL quando o status de uma mensagem NOSSA muda.
// Configure o webhook "Ao enviar status da mensagem" da instância deste
// setor pra cá:  https://SEU-DOMINIO/webhook/zapi-status
// ---------------------------------------------------------------
async function handlerStatusZapi(req, res) {
  // TRAVA DE ISOLAMENTO também aqui: só o status da própria instância conta.
  const instanceId = req.body && req.body.instanceId;
  if (!zapi.instanciaPropria(instanceId)) {
    return res.status(200).json({ info: 'status de instância estranha, ignorado' });
  }
  const { status, ids } = zapi.interpretarStatus(req.body);
  if (!status || ids.length === 0) {
    // REDE DE SEGURANÇA: se um payload de MENSAGEM (recebida ou resposta
    // manual) caiu aqui no endereço de status por engano — porque o link
    // "Ao receber" foi apontado pro /webhook/zapi-status — não perde a
    // mensagem: reencaminha pro processamento normal (a trava de instância
    // já garante que é a instância certa).
    const msg = zapi.interpretarWebhook(req.body);
    const pareceMensagem = Boolean(msg.telefone && (msg.texto || msg.midiaUrl));
    if (pareceMensagem) {
      console.warn('>> [ROTEAMENTO] Mensagem caiu no endereço de status (-status) por engano — reencaminhando pro processamento normal. Corrija o link "Ao receber" na Z-API.');
      return processarWebhookMensagem(req, res);
    }
    return res.status(200).json({ info: 'status sem id reconhecível, ignorado' });
  }
  const novo = zapi.mapearStatusEntrega(status);
  if (!novo) {
    return res.status(200).json({ info: `status "${status}" não mapeado, ignorado` });
  }
  // Nunca regride (uma confirmação de 'entregue' que chega atrasada não pode
  // apagar um 'lido' que já veio). Rank: enviado<entregue<lido.
  const rankNovo = { enviado: 1, entregue: 2, lido: 3 }[novo];
  const upd = db.prepare(`
    UPDATE mensagens SET status_entrega = ?
    WHERE zapi_message_id = ?
      AND COALESCE(CASE status_entrega WHEN 'enviado' THEN 1 WHEN 'entregue' THEN 2 WHEN 'lido' THEN 3 END, 0) < ?
  `);
  let atualizadas = 0;
  for (const id of ids) atualizadas += upd.run(novo, id, rankNovo).changes;
  res.status(200).json({ ok: true, status: novo, atualizadas });
}
app.post('/webhook/zapi-status', handlerStatusZapi);

// ---------------------------------------------------------------
// ENCAMINHAR MENSAGEM — copia uma mensagem (texto e/ou mídia) pra QUALQUER
// conversa de QUALQUER setor e a envia de verdade pela instância Z-API do
// setor de destino. Busca de destino é cross-setor de propósito.
// ---------------------------------------------------------------
app.get('/api/encaminhar/destinos', requireAuth, (req, res) => {
  const termo = (req.query.q || '').trim();
  if (termo.length < 2) return res.json([]);
  // Setor único: todas as conversas deste sistema são deste setor.
  const leads = db.prepare(`
    SELECT id, nome_cliente, telefone, is_grupo, status
    FROM leads
    WHERE (nome_cliente LIKE ? OR telefone LIKE ?)
    ORDER BY criado_em DESC LIMIT 30
  `).all(`%${termo}%`, `%${termo}%`);
  res.json(leads);
});

app.post('/api/mensagens/:id/encaminhar', requireAuth, async (req, res) => {
  const origem = db.prepare('SELECT * FROM mensagens WHERE id = ?').get(req.params.id);
  if (!origem) return res.status(404).json({ erro: 'mensagem não encontrada' });
  if (origem.apagada) return res.status(400).json({ erro: 'não dá pra encaminhar uma mensagem apagada' });

  const destino = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.destino_lead_id);
  if (!destino) return res.status(404).json({ erro: 'conversa de destino não encontrada' });

  // Tira o prefixo interno "*Fulano:*" da mensagem original, se tiver.
  const textoOriginal = (origem.texto || '').replace(/^\*[^*]+:\*\n/, '');
  const temMidia = Boolean(origem.midia_url);
  if (!textoOriginal.trim() && !temMidia) {
    return res.status(400).json({ erro: 'essa mensagem não tem conteúdo pra encaminhar' });
  }

  const textoSalvo = textoOriginal;
  const textoParaEnviar = textoOriginal;

  // Escrever numa conversa encerrada reabre ela (mesma regra do envio normal).
  if (destino.status === 'encerrado') {
    db.prepare(`UPDATE leads SET status = 'em_atendimento' WHERE id = ?`).run(destino.id);
  }

  const info = db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo, midia_nome) VALUES (?, 'vendedor', ?, ?, ?, ?)`)
    .run(destino.id, textoSalvo, origem.midia_url || null, origem.midia_tipo || null, origem.midia_nome || null);

  // Pra reenviar pela Z-API, a mídia precisa do conteúdo — se estiver salva
  // como arquivo local ("/midia/..."), lê de volta como data URI.
  const midiaParaEnviar = temMidia ? midia.refParaDataUri(origem.midia_url, { tipo: origem.midia_tipo }) : null;
  const envio = temMidia
    ? await zapi.enviarMidiaWhatsapp(destino.telefone, origem.midia_tipo, midiaParaEnviar, origem.midia_nome, textoParaEnviar, null, null)
    : await zapi.enviarMensagemWhatsapp(destino.telefone, textoParaEnviar, null, null);

  if (envio.messageId) {
    db.prepare(`UPDATE mensagens SET zapi_message_id = ?, status_entrega = 'enviado' WHERE id = ?`).run(envio.messageId, info.lastInsertRowid);
  } else if (envio.enviado) {
    db.prepare(`UPDATE mensagens SET status_entrega = 'enviado' WHERE id = ?`).run(info.lastInsertRowid);
  }

  res.status(201).json({ ok: true, enviado_whatsapp: envio.enviado, destino: destino.nome_cliente || destino.telefone });
});

// ---------------------------------------------------------------
// VENDEDORES
// ---------------------------------------------------------------
app.get('/api/vendedores', requireAuth, (req, res) => {
  const vendedores = db.prepare('SELECT id, nome, login, role FROM vendedores ORDER BY nome ASC').all();
  const comContagem = vendedores.map((v) => {
    const leadsAtivos = db.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE vendedor_id = ? AND status = 'em_atendimento'`
    ).get(v.id).n;
    return { ...v, leads_ativos: leadsAtivos, setores: [SETOR] };
  });
  res.json(comContagem);
});

// ---------------------------------------------------------------
// LEMBRETES — cada vendedor só vê os seus; admin vê todos
// ---------------------------------------------------------------
app.get('/api/lembretes', requireAuth, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);

  const status = req.query.status || 'pendentes'; // pendentes | concluidas | todas
  let condicaoFeito;
  if (status === 'concluidas') {
    condicaoFeito = `lembretes.feito = 1 AND lembretes.concluido_em >= datetime('now', '-1 day')`;
  } else if (status === 'todas') {
    // pendentes sem limite de tempo + concluídas só das últimas 24h
    condicaoFeito = `(lembretes.feito = 0 OR (lembretes.feito = 1 AND lembretes.concluido_em >= datetime('now', '-1 day')))`;
  } else {
    condicaoFeito = 'lembretes.feito = 0';
  }
  const ordem = status === 'concluidas' ? 'lembretes.quando DESC' : 'lembretes.quando ASC';

  let lembretes;
  if (ehGestor(req.usuario)) {
    lembretes = db.prepare(`
      SELECT lembretes.*, leads.nome_cliente, leads.telefone
      FROM lembretes
      JOIN leads ON leads.id = lembretes.lead_id
      WHERE ${condicaoFeito} AND leads.setor_id = ?
      ORDER BY ${ordem}
    `).all(setorAtivo.id);
  } else {
    lembretes = db.prepare(`
      SELECT lembretes.*, leads.nome_cliente, leads.telefone
      FROM lembretes
      JOIN leads ON leads.id = lembretes.lead_id
      WHERE ${condicaoFeito} AND lembretes.vendedor_id = ? AND leads.setor_id = ?
      ORDER BY ${ordem}
    `).all(req.usuario.id, setorAtivo.id);
  }
  res.json(lembretes);
});

app.post('/api/lembretes/:id/concluir', requireAuth, (req, res) => {
  db.prepare(`UPDATE lembretes SET feito = 1, concluido_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Criação manual de lembrete/tarefa — vendedor monta a própria agenda
// (ex: "mandar orçamento", "calcular frete") em cima de um lead que já é dele.
// Admin também pode criar tarefa PRA outro vendedor (ex: revisar atendimento).
const TIPOS_LEMBRETE = ['orcamento', 'catalogo', 'frete', 'pos_venda', 'ligacao', 'objecao', 'oportunidade', 'outro'];
app.post('/api/lembretes', requireAuth, (req, res) => {
  const { lead_id, titulo, quando, tipo, vendedor_id } = req.body;
  if (!lead_id || !titulo || !quando) {
    return res.status(400).json({ erro: 'lead_id, titulo e quando são obrigatórios' });
  }
  const tipoFinal = TIPOS_LEMBRETE.includes(tipo) ? tipo : 'outro';

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode criar tarefa nesse lead' });
  }

  // Só admin pode atribuir a tarefa a outro vendedor; qualquer outro caso, é pra si mesmo
  const vendedorDestino = ehGestor(req.usuario) && vendedor_id ? vendedor_id : req.usuario.id;

  const info = db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
  `).run(lead_id, vendedorDestino, titulo, quando, tipoFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Disparo manual da análise diária (útil pra testar sem esperar 18h, ou se
// o servidor esteve fora do ar na hora automática) — só admin.
app.post('/api/admin/rodar-analise-diaria', requireAuth, requireAdmin, async (req, res) => {
  const resultado = await agendador.rodarAnaliseDiaria();
  res.json(resultado);
});

// ---------------------------------------------------------------
// SUGESTÕES DA IA — a IA lê a conversa e sugere, mas nunca grava
// nada sozinha. O vendedor (ou admin) sempre confirma com um clique.
// ---------------------------------------------------------------
app.get('/api/leads/:id/sugestao-encerramento', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'sem permissão pra esse lead' });
  }
  if (!claudeIA.configurado) {
    return res.status(503).json({ erro: 'IA ainda não configurada nesse servidor (falta ANTHROPIC_API_KEY)' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);
  const sugestao = await claudeIA.analisarConversa(mensagens);
  if (!sugestao) return res.status(502).json({ erro: 'IA não conseguiu analisar agora, tenta de novo em instantes' });
  res.json(sugestao);
});

app.get('/api/leads/:id/sugestao-tarefa', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) {
    return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  }

  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'sem permissão pra esse lead' });
  }
  if (!claudeIA.configurado) {
    return res.status(503).json({ erro: 'IA ainda não configurada nesse servidor (falta ANTHROPIC_API_KEY)' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);
  const sugestao = await claudeIA.sugerirTarefa(mensagens);
  if (!sugestao) return res.status(502).json({ erro: 'IA não conseguiu analisar agora, tenta de novo em instantes' });
  res.json(sugestao);
});

// ---------------------------------------------------------------
// RELATÓRIO DO DIA
// Admin: números gerais + quebra por vendedor.
// Vendedor: só o próprio desempenho.
// ---------------------------------------------------------------
function calcularRelatorio(dataISO, filtroVendedorId) {
  // criado_em é salvo em UTC pelo SQLite (datetime('now')); comparamos por prefixo de data.
  const leadsDoDia = db.prepare(`SELECT * FROM leads WHERE date(criado_em) = date(?)`).all(dataISO);

  const encerradosHoje = db.prepare(`
    SELECT * FROM leads WHERE date(criado_em) = date(?) AND status = 'encerrado'
  `).all(dataISO);

  function metricasDe(leads) {
    const recebidos = leads.length;
    const convertidos = leads.filter(l => l.resultado === 'convertido');
    const perdidos = leads.filter(l => l.resultado === 'perdido');
    const valorTotal = convertidos.reduce((soma, l) => soma + (l.valor_venda || 0), 0);
    const ticketMedio = convertidos.length > 0 ? valorTotal / convertidos.length : 0;

    // Distribuição de motivos de perda (objeções)
    const objecoes = {};
    perdidos.forEach(l => {
      const motivo = l.motivo_perda || 'não informado';
      objecoes[motivo] = (objecoes[motivo] || 0) + 1;
    });

    // Tempo até ser puxado (criação -> primeira mudança pra em_atendimento).
    // Como não guardamos histórico de status, aproximamos usando a criação do lembrete
    // automático (criado no momento do claim) como proxy do instante do claim.
    let temposAteClaim = [];
    let temposAtePrimeiraResposta = [];
    let gargalos = 0;

    leads.forEach(l => {
      const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY id ASC').all(l.id);
      const primeiraMsgCliente = mensagens.find(m => m.remetente === 'cliente');
      const primeiraRespostaVendedor = mensagens.find(m => m.remetente === 'vendedor');
      if (primeiraMsgCliente && primeiraRespostaVendedor) {
        const minutos = (new Date(primeiraRespostaVendedor.criado_em + 'Z') - new Date(primeiraMsgCliente.criado_em + 'Z')) / 60000;
        if (minutos >= 0) temposAtePrimeiraResposta.push(minutos);
      }
      // Gargalo: qualquer intervalo >= 5min entre uma mensagem do cliente e a próxima resposta (ia não conta)
      for (let i = 0; i < mensagens.length; i++) {
        if (mensagens[i].remetente === 'cliente') {
          const proxima = mensagens.slice(i + 1).find(m => m.remetente === 'vendedor');
          if (proxima) {
            const gap = (new Date(proxima.criado_em + 'Z') - new Date(mensagens[i].criado_em + 'Z')) / 60000;
            if (gap >= 5) { gargalos++; break; }
          } else if (l.status !== 'encerrado') {
            gargalos++; break; // ainda esperando resposta
          }
        }
      }
    });

    const media = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const indefinidos = leads.filter(l => l.resultado === 'indefinido').length;
    const encerradosPendentes = leads.filter(l => l.status === 'encerrado' && !l.resultado).length;

    return {
      leads_recebidos: recebidos,
      convertidos: convertidos.length,
      perdidos: perdidos.length,
      indefinidos,
      encerrados_aguardando_analise: encerradosPendentes,
      ainda_em_aberto: recebidos - convertidos.length - perdidos.length - indefinidos - encerradosPendentes,
      taxa_conversao: recebidos > 0 ? Math.round((convertidos.length / recebidos) * 1000) / 10 : 0,
      ticket_medio: Math.round(ticketMedio * 100) / 100,
      valor_total_vendido: Math.round(valorTotal * 100) / 100,
      tempo_medio_primeira_resposta_min: media(temposAtePrimeiraResposta) !== null ? Math.round(media(temposAtePrimeiraResposta)) : null,
      leads_com_gargalo: gargalos,
      objecoes,
    };
  }

  if (filtroVendedorId) {
    const meus = leadsDoDia.filter(l => l.vendedor_id === filtroVendedorId);
    const tarefasIA = db.prepare(`
      SELECT lembretes.id, lembretes.lead_id, lembretes.titulo, lembretes.tipo, lembretes.feito,
             leads.nome_cliente, leads.telefone
      FROM lembretes
      JOIN leads ON leads.id = lembretes.lead_id
      WHERE lembretes.titulo LIKE '🤖%' AND date(lembretes.criado_em) = date(?) AND lembretes.vendedor_id = ?
      ORDER BY lembretes.feito ASC, lembretes.criado_em ASC
    `).all(dataISO, filtroVendedorId);
    return { data: dataISO, escopo: 'proprio', ...metricasDe(meus), tarefas_ia: tarefasIA };
  }

  const geral = metricasDe(leadsDoDia);
  const vendedores = db.prepare(`SELECT id, nome FROM vendedores`).all();
  const porVendedor = vendedores.map(v => {
    const meus = leadsDoDia.filter(l => l.vendedor_id === v.id);
    if (meus.length === 0) return null;
    return { vendedor: v.nome, ...metricasDe(meus) };
  }).filter(Boolean);

  // Tarefas que a análise diária da IA criou nesse dia (gargalo, oportunidade,
  // pós-venda, lead esquecido) — é o que liga o relatório à análise diária:
  // não é só um número, dá pra ver exatamente o que a IA sinalizou e clicar
  // pra resolver.
  const tarefasIA = db.prepare(`
    SELECT lembretes.id, lembretes.lead_id, lembretes.titulo, lembretes.tipo, lembretes.feito,
           leads.nome_cliente, leads.telefone
    FROM lembretes
    JOIN leads ON leads.id = lembretes.lead_id
    WHERE lembretes.titulo LIKE '🤖%' AND date(lembretes.criado_em) = date(?)
    ORDER BY lembretes.feito ASC, lembretes.criado_em ASC
  `).all(dataISO);

  return { data: dataISO, escopo: 'geral', ...geral, por_vendedor: porVendedor, tarefas_ia: tarefasIA };
}

// Excluir um lead (e tudo ligado a ele) — só admin. Útil pra limpar dado de
// teste/demonstração, ou remover um lead criado por engano.
app.delete('/api/leads/:id', requireAuth, requireAdmin, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  db.prepare('DELETE FROM mensagens WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lembretes WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

// Limpa de uma vez todos os dados criados pela simulação de demonstração
// (scripts/simulate-demo.js) — leads dos vendedores "*_demo" e os próprios
// vendedores demo. Não mexe em nenhum dado real. Só admin.
app.post('/api/admin/limpar-demo', requireAuth, requireGestor, (req, res) => {
  if (req.usuario.login !== 'admin') {
    return res.status(403).json({ erro: 'ação restrita à conta de desenvolvedor' });
  }
  const vendedoresDemo = db.prepare(`SELECT id FROM vendedores WHERE login LIKE '%\\_demo' ESCAPE '\\'`).all();
  const idsVendedoresDemo = vendedoresDemo.map((v) => v.id);

  const leadsParaApagar = db.prepare(`
    SELECT id FROM leads WHERE telefone LIKE '1199111%' ${idsVendedoresDemo.length > 0 ? `OR vendedor_id IN (${idsVendedoresDemo.join(',')})` : ''}
  `).all();

  let leadsApagados = 0;
  for (const lead of leadsParaApagar) {
    db.prepare('DELETE FROM mensagens WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM lembretes WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
    leadsApagados++;
  }

  let vendedoresApagados = 0;
  for (const id of idsVendedoresDemo) {
    db.prepare('DELETE FROM lembretes WHERE vendedor_id = ?').run(id);
    db.prepare('DELETE FROM vendedores WHERE id = ?').run(id);
    vendedoresApagados++;
  }

  res.json({ ok: true, leads_apagados: leadsApagados, vendedores_demo_apagados: vendedoresApagados });
});

app.get('/api/relatorio', requireAuth, (req, res) => {
  if (req.usuario.role === 'supervisor') {
    return res.status(403).json({ erro: 'relatório não disponível pra esse nível de acesso' });
  }
  const dataISO = req.query.data || new Date().toISOString().slice(0, 10);
  if (req.usuario.role === 'admin') {
    res.json(calcularRelatorio(dataISO, null));
  } else {
    res.json(calcularRelatorio(dataISO, req.usuario.id));
  }
});

// ---------------------------------------------------------------
// PROGRESSO: gráfico de vendas (leads convertidos) por período —
// usa o que a análise diária da IA já preenche (resultado/valor_venda/
// convertido_em), sem precisar de tabela nova.
// ---------------------------------------------------------------
function agruparPorGranularidade(vendas, granularidade) {
  const buckets = new Map();
  for (const v of vendas) {
    const bruto = v.convertido_em.includes('Z') ? v.convertido_em : v.convertido_em + 'Z';
    const data = new Date(bruto);
    let key, label;
    if (granularidade === 'mensal') {
      key = `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
      label = data.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    } else if (granularidade === 'semanal') {
      const inicioSemana = new Date(data);
      inicioSemana.setUTCDate(data.getUTCDate() - data.getUTCDay());
      const fimSemana = new Date(inicioSemana);
      fimSemana.setUTCDate(inicioSemana.getUTCDate() + 6);
      key = inicioSemana.toISOString().slice(0, 10);
      label = `${inicioSemana.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })}–${fimSemana.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })}`;
    } else {
      key = data.toISOString().slice(0, 10);
      label = data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    }
    if (!buckets.has(key)) buckets.set(key, { key, label, value: 0 });
    buckets.get(key).value += 1;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

app.get('/api/relatorio/progresso', requireAuth, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);

  const granularidade = req.query.granularidade || 'diario'; // diario | semanal | mensal
  const gestor = ehGestor(req.usuario);

  // Período: OU um preset (semana/mes/3meses), OU datas específicas
  // escolhidas na tela (data_inicio/data_fim, formato YYYY-MM-DD) — o
  // seletor de calendário no admin manda essas duas em vez do preset.
  let desdeAtual, desdeAnterior, dias;
  if (req.query.data_inicio && req.query.data_fim) {
    const inicio = new Date(req.query.data_inicio + 'T00:00:00Z');
    const fim = new Date(req.query.data_fim + 'T23:59:59Z');
    dias = Math.max(1, Math.round((fim - inicio) / (24 * 60 * 60 * 1000)));
    desdeAtual = inicio.toISOString();
    desdeAnterior = new Date(inicio.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
    var ateAtual = fim.toISOString();
  } else {
    const periodo = req.query.periodo || 'semana';
    dias = { semana: 7, mes: 30, '3meses': 90 }[periodo] || 7;
    desdeAtual = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    desdeAnterior = new Date(Date.now() - dias * 2 * 24 * 60 * 60 * 1000).toISOString();
    var ateAtual = new Date().toISOString();
  }

  // Vendedor só acompanha o próprio progresso. Gestor vê o setor inteiro
  // por padrão, mas pode escolher um vendedor específico pra isolar.
  const vendedorFiltro = gestor && req.query.vendedor_id ? Number(req.query.vendedor_id) : (!gestor ? req.usuario.id : null);

  const vendas = vendedorFiltro
    ? db.prepare(`SELECT convertido_em, valor_venda FROM leads WHERE resultado = 'convertido' AND setor_id = ? AND vendedor_id = ? AND convertido_em >= ?`)
        .all(setorAtivo.id, vendedorFiltro, desdeAnterior)
    : db.prepare(`SELECT convertido_em, valor_venda FROM leads WHERE resultado = 'convertido' AND setor_id = ? AND convertido_em >= ?`)
        .all(setorAtivo.id, desdeAnterior);

  const atual = vendas.filter((v) => v.convertido_em >= desdeAtual && v.convertido_em <= ateAtual);
  const anterior = vendas.filter((v) => v.convertido_em < desdeAtual);

  const total = atual.length;
  const totalAnterior = anterior.length;
  const comparacao = totalAnterior > 0
    ? Math.round(((total - totalAnterior) / totalAnterior) * 100)
    : (total > 0 ? 100 : 0);

  res.json({
    total,
    mediaPorDia: +(total / dias).toFixed(1),
    comparacao,
    buckets: agruparPorGranularidade(atual, granularidade),
  });
});

// ---------------------------------------------------------------
// METAS — 1 meta ativa por vendedor, só admin define. 3 tipos: valor
// (soma de vendas), pedidos (quantidade de vendas), atendimentos
// (quantidade de conversas encerradas, com ou sem venda).
// ---------------------------------------------------------------
function inicioDoPeriodo(periodo) {
  const agora = new Date();
  if (periodo === 'mes') {
    return new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString();
  }
  // semana: segunda-feira desta semana, 00:00
  const diaSemana = agora.getDay(); // 0 = domingo
  const diffParaSegunda = diaSemana === 0 ? 6 : diaSemana - 1;
  const segunda = new Date(agora);
  segunda.setDate(agora.getDate() - diffParaSegunda);
  segunda.setHours(0, 0, 0, 0);
  return segunda.toISOString();
}

function fimDoPeriodo(periodo) {
  const agora = new Date();
  if (periodo === 'mes') {
    return new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59);
  }
  const diaSemana = agora.getDay(); // 0 = domingo
  const diffParaDomingo = diaSemana === 0 ? 0 : 7 - diaSemana;
  const domingo = new Date(agora);
  domingo.setDate(agora.getDate() + diffParaDomingo);
  domingo.setHours(23, 59, 59, 0);
  return domingo;
}

function calcularProgressoMeta(meta) {
  const desde = inicioDoPeriodo(meta.periodo);
  let atual = 0;
  if (meta.tipo === 'valor') {
    atual = db.prepare(`SELECT COALESCE(SUM(valor_venda),0) AS n FROM leads WHERE resultado='convertido' AND vendedor_id=? AND convertido_em >= ?`)
      .get(meta.vendedor_id, desde).n;
  } else if (meta.tipo === 'pedidos') {
    atual = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE resultado='convertido' AND vendedor_id=? AND convertido_em >= ?`)
      .get(meta.vendedor_id, desde).n;
  } else if (meta.tipo === 'atendimentos') {
    atual = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status='encerrado' AND vendedor_id=? AND encerrado_em >= ?`)
      .get(meta.vendedor_id, desde).n;
  }
  const percentual = meta.valor_meta > 0 ? Math.min(100, Math.round((atual / meta.valor_meta) * 100)) : 0;
  const falta = Math.max(0, meta.valor_meta - atual);
  const fim = fimDoPeriodo(meta.periodo);
  const diasRestantes = Math.max(0, Math.ceil((fim - new Date()) / (24 * 60 * 60 * 1000)));
  return { atual, percentual, falta, diasRestantes };
}

app.get('/api/metas/:vendedorId', requireAuth, (req, res) => {
  const vendedorId = Number(req.params.vendedorId);
  if (vendedorId !== req.usuario.id && !ehGestor(req.usuario)) {
    return res.status(403).json({ erro: 'sem permissão pra ver a meta de outro vendedor' });
  }
  const meta = db.prepare('SELECT * FROM metas WHERE vendedor_id = ?').get(vendedorId);
  if (!meta) return res.json({ meta: null });
  const { atual, percentual, falta, diasRestantes } = calcularProgressoMeta(meta);
  res.json({ meta, atual, percentual, falta, diasRestantes });
});

app.post('/api/metas/:vendedorId', requireAuth, requireAdmin, (req, res) => {
  const vendedorId = Number(req.params.vendedorId);
  const alvo = db.prepare('SELECT role FROM vendedores WHERE id = ?').get(vendedorId);
  if (!alvo) return res.status(404).json({ erro: 'vendedor não encontrado' });
  if (alvo.role !== 'vendedor') {
    return res.status(400).json({ erro: 'meta é só pra quem tem cargo de vendedor — admin e supervisor não têm meta pessoal' });
  }
  const { tipo, valor_meta, periodo } = req.body;
  if (!['valor', 'pedidos', 'atendimentos'].includes(tipo)) {
    return res.status(400).json({ erro: 'tipo de meta inválido' });
  }
  const valorNum = Number(valor_meta);
  if (!valorNum || valorNum <= 0) {
    return res.status(400).json({ erro: 'informe um valor de meta maior que zero' });
  }
  const periodoFinal = periodo === 'mes' ? 'mes' : 'semana';

  db.prepare(`
    INSERT INTO metas (vendedor_id, tipo, valor_meta, periodo, definida_por, definida_em)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT(vendedor_id) DO UPDATE SET
      tipo = excluded.tipo, valor_meta = excluded.valor_meta, periodo = excluded.periodo,
      definida_por = excluded.definida_por, definida_em = excluded.definida_em
  `).run(vendedorId, tipo, valorNum, periodoFinal, req.usuario.id);

  res.json({ ok: true });
});

app.delete('/api/metas/:vendedorId', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM metas WHERE vendedor_id = ?').run(req.params.vendedorId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// HISTÓRICO DE RELATÓRIOS (Financeiro) — a análise diária da IA pra esse
// setor gera 1 relatório de texto por dia (gargalo de cobrança/negociação,
// não tarefa por lead). Só admin acessa.
// ---------------------------------------------------------------
app.get('/api/relatorios-financeiro', requireAuth, requireAdmin, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  const linhas = db.prepare(`
    SELECT data, gerado_em FROM relatorios_financeiro WHERE setor_id = ? ORDER BY data DESC LIMIT 90
  `).all(setorAtivo.id);
  res.json(linhas);
});

app.get('/api/relatorios-financeiro/:data', requireAuth, requireAdmin, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  const relatorio = db.prepare(`
    SELECT * FROM relatorios_financeiro WHERE setor_id = ? AND data = ?
  `).get(setorAtivo.id, req.params.data);
  if (!relatorio) return res.status(404).json({ erro: 'nenhum relatório encontrado pra essa data' });
  res.json(relatorio);
});

// Gera o relatório do Financeiro na hora (mesma lógica da análise diária,
// só que sob demanda) — usado pelo botão "Gerar Análise" quando o setor
// ativo é Financeiro.
app.post('/api/relatorios-financeiro/gerar-agora', requireAuth, requireAdmin, async (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro || setorAtivo.slug !== 'financeiro') {
    return res.status(400).json({ erro: 'esse botão só existe pro setor Financeiro' });
  }
  if (!claudeIA.configurado) {
    return res.status(400).json({ erro: 'IA não configurada (ANTHROPIC_API_KEY ausente)' });
  }
  const hojeISO = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const leadsHoje = db.prepare(`
    SELECT DISTINCT leads.* FROM leads
    JOIN mensagens ON mensagens.lead_id = leads.id
    WHERE leads.setor_id = ? AND date(mensagens.criado_em) = date('now')
  `).all(setorAtivo.id);

  if (leadsHoje.length === 0) {
    return res.status(400).json({ erro: 'nenhuma conversa com mensagem hoje nesse setor ainda' });
  }

  const conversas = leadsHoje.map((lead) => ({
    lead,
    mensagens: db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id),
  })).filter((c) => c.mensagens.length > 0);

  const relatorio = await claudeIA.analisarFinanceiroDiario(conversas);
  if (!relatorio) return res.status(500).json({ erro: 'a IA não conseguiu gerar o relatório agora — tenta de novo em instantes' });

  db.prepare(`
    INSERT INTO relatorios_financeiro (setor_id, data, conteudo, gerado_em)
    VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT(setor_id, data) DO UPDATE SET conteudo = excluded.conteudo, gerado_em = excluded.gerado_em
  `).run(setorAtivo.id, hojeISO, relatorio);

  res.json({ ok: true, data: hojeISO, conteudo: relatorio });
});

// ---------------------------------------------------------------
// ANÁLISE SOB MEDIDA (pedido da gestão) — o admin escreve uma instrução
// livre (ex: "por que os clientes não estão fechando essa semana", "quanto
// de desconto os vendedores estão dando") e a IA lê TODAS as conversas
// ativas e encerradas do setor ativo, respondendo especificamente àquilo.
// Não grava nada — é leitura sob demanda. Tem cap de conversas e de
// mensagens por conversa pra não estourar custo/tempo/token num setor com
// histórico grande (o total lido volta na resposta, pra ficar transparente).
// ---------------------------------------------------------------
app.post('/api/analise-personalizada', requireAuth, requireAdmin, async (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  if (!claudeIA.configurado) {
    return res.status(400).json({ erro: 'IA não configurada nesse servidor (falta ANTHROPIC_API_KEY)' });
  }

  const instrucao = (req.body && req.body.instrucao != null ? String(req.body.instrucao) : '').trim();
  if (!instrucao) return res.status(400).json({ erro: 'escreva o que você quer que a IA analise nas conversas' });
  if (instrucao.length > 500) return res.status(400).json({ erro: 'a instrução ficou longa demais (máximo 500 caracteres)' });

  const LIMITE_CONVERSAS = 40;   // no máximo N conversas mais recentes do setor
  const LIMITE_MENSAGENS = 30;   // últimas N mensagens de cada conversa
  const MAX_CHARS_MSG = 400;     // trunca mensagem gigante (evita 1 áudio transcrito enorme dominar)
  const ORCAMENTO_CHARS = 45000; // teto total do material enviado pra IA (~11k tokens) — setor com meses de histórico (Vendas) não estoura mais

  // Conversas ativas E encerradas do setor, ordenadas pela atividade mais
  // recente (data da última mensagem), pegando as mais recentes primeiro.
  const leads = db.prepare(`
    SELECT leads.*, MAX(mensagens.criado_em) AS ultima_msg
    FROM leads
    JOIN mensagens ON mensagens.lead_id = leads.id
    WHERE leads.setor_id = ?
    GROUP BY leads.id
    ORDER BY ultima_msg DESC
    LIMIT ?
  `).all(setorAtivo.id, LIMITE_CONVERSAS);

  if (leads.length === 0) {
    return res.status(400).json({ erro: 'ainda não há conversas com mensagens nesse setor pra analisar' });
  }

  // Monta as conversas respeitando um orçamento de caracteres — assim um
  // setor com muito histórico (Vendas roda há meses) manda um recorte
  // recente e responde rápido, em vez de mandar tudo e a IA recusar/travar.
  const conversas = [];
  let acumulado = 0;
  for (const lead of leads) {
    if (acumulado >= ORCAMENTO_CHARS) break;
    const todas = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    const mensagens = todas.slice(-LIMITE_MENSAGENS).map((m) => ({
      ...m,
      texto: m.texto ? String(m.texto).slice(0, MAX_CHARS_MSG) : m.texto,
    }));
    if (mensagens.length === 0) continue;
    const tamanho = mensagens.reduce((s, m) => s + ((m.texto || '').length) + 24, 0) + 60;
    conversas.push({ lead, mensagens });
    acumulado += tamanho;
  }

  if (conversas.length === 0) {
    return res.status(400).json({ erro: 'ainda não há conversas com mensagens nesse setor pra analisar' });
  }

  const resultado = await claudeIA.analisarPersonalizado(conversas, instrucao);
  if (!resultado || resultado.erro) {
    return res.status(502).json({ erro: (resultado && resultado.erro) || 'a IA não conseguiu gerar a análise agora — tenta de novo em instantes' });
  }

  // Guarda no histórico do setor (data + pergunta + conteúdo completo), pra
  // o admin reabrir depois. A tela mostra só data + pergunta; o texto inteiro
  // só quando clica.
  const info = db.prepare(`
    INSERT INTO analises_personalizadas (setor_id, instrucao, conteudo, criado_por, gerado_em)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
  `).run(setorAtivo.id, instrucao, resultado.conteudo, req.usuario.id);

  res.json({ ok: true, id: info.lastInsertRowid, conteudo: resultado.conteudo, conversas_analisadas: conversas.length });
});

// Histórico das análises sob medida do setor — só data + pergunta (id pra
// abrir o conteúdo depois). Só admin.
app.get('/api/analises-personalizadas', requireAuth, requireAdmin, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  const linhas = db.prepare(`
    SELECT id, instrucao, gerado_em FROM analises_personalizadas
    WHERE setor_id = ? ORDER BY gerado_em DESC LIMIT 100
  `).all(setorAtivo.id);
  res.json(linhas);
});

// Conteúdo completo de uma análise específica — escopo por setor de
// propósito (a análise de um setor não abre pela aba de outro). Só admin.
app.get('/api/analises-personalizadas/:id', requireAuth, requireAdmin, (req, res) => {
  const setorAtivo = resolverSetorAtivo(req.usuario, req.query.setor);
  if (setorAtivo.erro) return res.status(403).json(setorAtivo);
  const analise = db.prepare(`
    SELECT * FROM analises_personalizadas WHERE id = ? AND setor_id = ?
  `).get(req.params.id, setorAtivo.id);
  if (!analise) return res.status(404).json({ erro: 'análise não encontrada nesse setor' });
  res.json(analise);
});

// ---------------------------------------------------------------
// CONTATOS — nome de verdade por telefone, salvo pela equipe. Compartilhado
// entre os 3 setores (é a mesma pessoa/número, independente de quem fala
// com ela). Qualquer vendedor logado pode ver e salvar.
// ---------------------------------------------------------------
app.get('/api/contatos', requireAuth, (req, res) => {
  const termo = (req.query.q || '').trim();
  const contatos = termo
    ? db.prepare(`SELECT * FROM contatos WHERE nome LIKE ? OR telefone LIKE ? ORDER BY nome ASC LIMIT 100`).all(`%${termo}%`, `%${termo}%`)
    : db.prepare(`SELECT * FROM contatos ORDER BY nome ASC LIMIT 200`).all();
  res.json(contatos);
});

app.post('/api/contatos', requireAuth, (req, res) => {
  const { telefone, nome } = req.body;
  if (!telefone || !nome || !nome.trim()) {
    return res.status(400).json({ erro: 'telefone e nome são obrigatórios' });
  }
  db.salvarContato(telefone, nome.trim(), req.usuario.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// ARMAZENAMENTO — relatório de espaço + compactação de mídia. A mídia que a
// equipe ENVIA fica guardada em base64 dentro do banco (é o que mais pesa no
// volume). Aqui o admin vê quanto isso ocupa, manda compactar as fotos
// antigas (a recompressão em si roda no navegador, sem biblioteca no
// servidor) e depois pede pra "encolher" o arquivo do banco (VACUUM).
// ---------------------------------------------------------------
const LIMITE_FOTO_GRANDE = 150000; // ~150KB de data URI = candidata a compactar

app.get('/api/admin/armazenamento', requireAuth, requireAdmin, (req, res) => {
  const pageCount = db.prepare('PRAGMA page_count').get().page_count || 0;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size || 0;
  const bancoBytes = pageCount * pageSize;

  // Agora a mídia é ARQUIVO no Volume — medimos a pasta /midia direto no disco.
  const fs = require('fs');
  let midiaBytes = 0, midiaQtd = 0;
  const porTipo = {};
  const extParaTipo = { jpg:'imagem', jpeg:'imagem', png:'imagem', gif:'imagem', webp:'imagem',
    ogg:'audio', mp3:'audio', m4a:'audio', amr:'audio', mp4:'video', pdf:'documento' };
  try {
    if (fs.existsSync(midia.MIDIA_DIR)) {
      for (const f of fs.readdirSync(midia.MIDIA_DIR)) {
        const st = fs.statSync(require('path').join(midia.MIDIA_DIR, f));
        if (!st.isFile()) continue;
        midiaBytes += st.size; midiaQtd++;
        const ext = (f.split('.').pop() || '').toLowerCase();
        const tipo = extParaTipo[ext] || 'outro';
        porTipo[tipo] = (porTipo[tipo] || 0) + st.size;
      }
    }
  } catch (e) { /* pasta ainda não existe: fica zerado */ }

  res.json({
    banco_bytes: bancoBytes,
    midia_bytes: midiaBytes,
    midia_qtd: midiaQtd,
    por_tipo: porTipo,
    fotos_grandes_qtd: 0,        // não há mais base64 pra compactar
    fotos_grandes_bytes: 0,
  });
});

app.get('/api/admin/fotos-grandes', requireAuth, requireAdmin, (req, res) => {
  const limite = Math.min(parseInt(req.query.limite, 10) || 8, 20);
  const rows = db.prepare(`
    SELECT id, midia_url FROM mensagens
    WHERE midia_url LIKE 'data:image/jp%' AND LENGTH(midia_url) > ? AND midia_compactada = 0
    ORDER BY LENGTH(midia_url) DESC LIMIT ?
  `).all(LIMITE_FOTO_GRANDE, limite);
  res.json(rows);
});

app.put('/api/admin/mensagens/:id/midia-compacta', requireAuth, requireAdmin, (req, res) => {
  const { data_uri } = req.body;
  const atual = db.prepare('SELECT LENGTH(midia_url) AS tam FROM mensagens WHERE id = ?').get(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'mensagem não encontrada' });
  // Sempre marca como já processada (mesmo se não coube reduzir), pra não
  // entrar em looping. Só troca a mídia se a nova versão for MENOR.
  if (data_uri && /^data:image\//.test(data_uri) && data_uri.length < atual.tam) {
    db.prepare('UPDATE mensagens SET midia_url = ?, midia_compactada = 1 WHERE id = ?').run(data_uri, req.params.id);
    return res.json({ ok: true, de: atual.tam, para: data_uri.length });
  }
  db.prepare('UPDATE mensagens SET midia_compactada = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, pulou: true });
});

// Baixa um backup do banco na hora (além do backup automático diário).
// Gera uma cópia íntegra e envia o arquivo pro admin salvar onde quiser.
app.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    const arquivo = backup.fazerBackup();
    res.download(arquivo, path.basename(arquivo));
  } catch (e) {
    res.status(500).json({ erro: `não deu pra gerar o backup agora (${e.message}). Costuma ser falta de espaço livre no volume.` });
  }
});

app.post('/api/admin/compactar-banco', requireAuth, requireAdmin, (req, res) => {
  const tam = () => (db.prepare('PRAGMA page_count').get().page_count || 0) * (db.prepare('PRAGMA page_size').get().page_size || 0);
  try {
    const antes = tam();
    db.exec('VACUUM');
    const depois = tam();
    res.json({ ok: true, antes, depois, recuperado: Math.max(0, antes - depois) });
  } catch (e) {
    res.status(500).json({ erro: `não deu pra compactar o banco agora (${e.message}). Isso costuma ser falta de espaço livre no volume — aumente o volume um pouco e tente de novo.` });
  }
});

// ---------------------------------------------------------------
// FIGURINHAS (stickers da loja) — biblioteca gerenciada pelo admin. A imagem
// fica guardada uma vez; ao enviar, a mensagem só referencia a figurinha
// (não copia a imagem), pra não inchar o banco.
// ---------------------------------------------------------------
app.get('/api/figurinhas', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, nome FROM figurinhas ORDER BY id DESC').all());
});

app.get('/api/figurinhas/:id/img', requireAuth, (req, res) => {
  const f = db.prepare('SELECT imagem FROM figurinhas WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).end();
  const m = /^data:([^;]+);base64,(.*)$/s.exec(f.imagem);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(Buffer.from(m[2], 'base64'));
});

app.post('/api/figurinhas', requireAuth, requireAdmin, (req, res) => {
  const { nome, imagem } = req.body;
  if (!imagem || !/^data:image\//.test(imagem)) return res.status(400).json({ erro: 'imagem inválida' });
  if (imagem.length > 800000) return res.status(400).json({ erro: 'figurinha muito grande — use uma imagem menor' });
  const info = db.prepare(`INSERT INTO figurinhas (nome, imagem, criado_por, criado_em) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))`)
    .run((nome || '').trim() || null, imagem, req.usuario.id);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/figurinhas/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM figurinhas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Envia uma figurinha da biblioteca numa conversa.
app.post('/api/leads/:id/figurinha', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (!usuarioAcessaLead(req.usuario, lead)) return res.status(403).json({ erro: 'este lead é de um setor que você não acessa' });
  const dono = lead.vendedor_id === req.usuario.id || Boolean(lead.is_grupo);
  if (!ehGestor(req.usuario) && !dono) return res.status(403).json({ erro: 'sem permissão pra esse lead' });

  const fig = db.prepare('SELECT * FROM figurinhas WHERE id = ?').get(req.body.figurinha_id);
  if (!fig) return res.status(404).json({ erro: 'figurinha não encontrada' });

  const setorDoLead = lead.setor_id ? db.prepare('SELECT slug FROM setores WHERE id = ?').get(lead.setor_id) : null;
  if (lead.status === 'encerrado') {
    db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`).run(lead.vendedor_id || req.usuario.id, lead.id);
  }

  // Guarda só a referência da figurinha (sem copiar a imagem pro banco).
  const info = db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'vendedor', '', ?, 'sticker')`)
    .run(lead.id, `/api/figurinhas/${fig.id}/img`);

  const envio = await zapi.enviarFigurinhaWhatsapp(lead.telefone, fig.imagem, setorDoLead ? setorDoLead.slug : 'vendas');
  if (envio.messageId) {
    db.prepare(`UPDATE mensagens SET zapi_message_id = ?, status_entrega = 'enviado' WHERE id = ?`).run(envio.messageId, info.lastInsertRowid);
  } else if (envio.enviado) {
    db.prepare(`UPDATE mensagens SET status_entrega = 'enviado' WHERE id = ?`).run(info.lastInsertRowid);
  }
  res.status(201).json({ ok: true, enviado_whatsapp: envio.enviado });
});

// Editar contato salvo — trocar nome e/ou número (pedido do Financeiro).
app.put('/api/contatos/:id', requireAuth, (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome || !telefone) return res.status(400).json({ erro: 'nome e telefone são obrigatórios' });
  const r = db.editarContato(req.params.id, nome, telefone);
  if (r.erro) return res.status(/já existe/.test(r.erro) ? 409 : 400).json(r);
  res.json(r);
});

// ---------------------------------------------------------------
// RELATÓRIO DE USO — página HTML pronta, pra abrir direto no navegador
// (inclusive do celular) sem precisar de terminal/console. Só admin.
// ---------------------------------------------------------------
const HORA_COMERCIAL_INICIO = 8, HORA_COMERCIAL_FIM = 18;
function paraBrasilia(dataStr) {
  const comZ = dataStr.includes('Z') ? dataStr : dataStr.replace(' ', 'T') + 'Z';
  return new Date(new Date(comZ).getTime() - 3 * 60 * 60 * 1000);
}
function minutosComerciaisEntre(inicioStr, fimStr) {
  let total = 0;
  let cursor = paraBrasilia(inicioStr);
  const alvo = paraBrasilia(fimStr);
  while (cursor < alvo) {
    const diaSemana = cursor.getUTCDay();
    const ehDiaUtil = diaSemana >= 1 && diaSemana <= 5;
    const horaAtual = cursor.getUTCHours() + cursor.getUTCMinutes() / 60;
    if (!ehDiaUtil || horaAtual < HORA_COMERCIAL_INICIO || horaAtual >= HORA_COMERCIAL_FIM) {
      const proximo = new Date(cursor);
      if (!ehDiaUtil || horaAtual >= HORA_COMERCIAL_FIM) {
        proximo.setUTCDate(proximo.getUTCDate() + 1);
        proximo.setUTCHours(HORA_COMERCIAL_INICIO, 0, 0, 0);
        while (proximo.getUTCDay() === 0 || proximo.getUTCDay() === 6) proximo.setUTCDate(proximo.getUTCDate() + 1);
      } else {
        proximo.setUTCHours(HORA_COMERCIAL_INICIO, 0, 0, 0);
      }
      cursor = proximo;
      continue;
    }
    const fimExpediente = new Date(cursor);
    fimExpediente.setUTCHours(HORA_COMERCIAL_FIM, 0, 0, 0);
    const proximoPonto = alvo < fimExpediente ? alvo : fimExpediente;
    total += (proximoPonto - cursor) / 60000;
    cursor = proximoPonto;
  }
  return total;
}

app.get('/relatorio-uso', requireAuth, requireAdmin, (req, res) => {
  const setores = db.getTodosSetores();
  const blocos = [];

  for (const setor of setores) {
    const totalLeads = db.prepare('SELECT COUNT(*) n FROM leads WHERE setor_id = ?').get(setor.id).n;
    if (totalLeads === 0) continue;
    const encerrados = db.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id = ? AND status = 'encerrado'`).get(setor.id).n;
    const convertidos = db.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id = ? AND resultado = 'convertido'`).get(setor.id).n;
    const valorTotal = db.prepare(`SELECT COALESCE(SUM(valor_venda),0) v FROM leads WHERE setor_id = ? AND resultado = 'convertido'`).get(setor.id).v;
    const primeiroLead = db.prepare('SELECT MIN(criado_em) d FROM leads WHERE setor_id = ?').get(setor.id).d;
    const totalMsgs = db.prepare(`SELECT COUNT(*) n FROM mensagens WHERE lead_id IN (SELECT id FROM leads WHERE setor_id = ?)`).get(setor.id).n;

    const leadsDoSetor = db.prepare(`SELECT id FROM leads WHERE setor_id = ? AND is_grupo = 0`).all(setor.id);
    const tempos = [];
    for (const lead of leadsDoSetor) {
      const primeiraCliente = db.prepare(`SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' ORDER BY criado_em ASC LIMIT 1`).get(lead.id);
      if (!primeiraCliente) continue;
      const primeiraResposta = db.prepare(`SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente IN ('vendedor','ia') AND criado_em > ? ORDER BY criado_em ASC LIMIT 1`).get(lead.id, primeiraCliente.criado_em);
      if (!primeiraResposta) continue;
      const minutos = minutosComerciaisEntre(primeiraCliente.criado_em, primeiraResposta.criado_em);
      if (minutos >= 0 && minutos < 60 * 24) tempos.push(minutos);
    }
    const mediaResposta = tempos.length > 0 ? (tempos.reduce((a, b) => a + b, 0) / tempos.length) : null;

    blocos.push({ setor, totalLeads, encerrados, convertidos, valorTotal, primeiroLead, totalMsgs, mediaResposta, medidos: tempos.length });
  }

  const porMes = db.prepare(`
    SELECT strftime('%Y-%m', criado_em) AS mes, COUNT(*) AS n FROM leads
    WHERE criado_em >= date('now', '-6 months') GROUP BY mes ORDER BY mes ASC
  `).all();
  const maxMes = Math.max(...porMes.map((m) => m.n), 1);

  const fmtR$ = (n) => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const fmtMin = (min) => min == null ? '—' : (min < 60 ? `${min.toFixed(0)} min` : `${(min / 60).toFixed(1)} h`);

  res.send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de Uso — Santo Antônio</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --navy:#2B3990; --navy-d:#202B6B; --red:#E63329; --bg:#F1F2F5; --border:#E4E6EB; --muted:#6B7280; --green:#16A34A; --green-bg:#E9F7EF; }
  * { box-sizing:border-box; }
  body { font-family:'Inter',sans-serif; background:var(--bg); color:#1F2430; margin:0; padding:16px; }
  h1 { font-family:'Oswald',sans-serif; font-size:19px; color:var(--navy-d); margin:4px 0 2px; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
  .card { background:white; border-radius:12px; padding:16px 18px; margin-bottom:14px; border-top:3px solid var(--navy); }
  .card.destaque { border-top-color: var(--red); }
  .card h2 { font-family:'Oswald',sans-serif; font-size:15px; color:var(--navy-d); margin:0 0 10px; text-transform:uppercase; }
  .linha { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
  .linha:last-child { border-bottom:none; }
  .linha b { color:var(--navy-d); }
  .stat-grid { display:flex; gap:10px; margin-bottom:14px; }
  .stat { flex:1; background:white; border-radius:10px; padding:12px; text-align:center; border-top:3px solid var(--navy); }
  .stat .num { font-family:'Oswald',sans-serif; font-size:20px; color:var(--navy-d); }
  .stat .lab { font-size:9.5px; color:var(--muted); text-transform:uppercase; margin-top:2px; }
  .mes-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:12px; }
  .mes-label { width:56px; font-weight:700; color:var(--navy-d); flex-shrink:0; }
  .mes-barra-track { flex:1; background:var(--border); border-radius:6px; height:10px; overflow:hidden; }
  .mes-barra-fill { background:var(--navy); height:100%; }
  .mes-valor { width:64px; text-align:right; color:var(--muted); flex-shrink:0; }
  .aviso { background:var(--green-bg); color:var(--green); border-radius:8px; padding:10px 12px; font-size:11.5px; margin-bottom:16px; }
</style></head>
<body>
  <h1>📊 Relatório de Uso</h1>
  <div class="sub">Depósito Santo Antônio · gerado agora, direto do banco de dados</div>
  <div class="aviso">✅ Tempo de resposta considera só horário comercial (seg-sex, 8h-18h) — mensagem fora do expediente não conta.</div>

  ${blocos.map((b) => `
    <div class="card ${b.setor.slug === 'vendas' ? 'destaque' : ''}">
      <h2>${b.setor.nome}</h2>
      <div class="linha"><span>Em operação desde</span><b>${b.primeiroLead ? b.primeiroLead.split(' ')[0].split('-').reverse().join('/') : '—'}</b></div>
      <div class="linha"><span>Conversas atendidas</span><b>${b.totalLeads}</b></div>
      <div class="linha"><span>Conversas encerradas</span><b>${b.encerrados}</b></div>
      ${b.setor.slug === 'vendas' ? `
      <div class="linha"><span>Pedidos fechados</span><b>${b.convertidos} (${b.totalLeads > 0 ? Math.round(100 * b.convertidos / b.totalLeads) : 0}%)</b></div>
      <div class="linha"><span>Valor vendido</span><b>${fmtR$(b.valorTotal)}</b></div>` : ''}
      <div class="linha"><span>Mensagens trocadas</span><b>${b.totalMsgs}</b></div>
      <div class="linha"><span>Tempo médio de resposta*</span><b>${fmtMin(b.mediaResposta)}</b></div>
    </div>
  `).join('')}

  <div class="card">
    <h2>📈 Volume por mês</h2>
    ${porMes.map((m) => `
      <div class="mes-row">
        <div class="mes-label">${m.mes}</div>
        <div class="mes-barra-track"><div class="mes-barra-fill" style="width:${100 * m.n / maxMes}%;"></div></div>
        <div class="mes-valor">${m.n} conversas</div>
      </div>
    `).join('')}
  </div>

  <div class="sub" style="margin-top:10px;">*calculado só em horário comercial (seg-sex, 8h-18h, horário de Brasília)</div>
</body></html>`);
});

// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT} — setor "${SETOR}"`);
  agendador.iniciarAgendador();
  backup.agendar(); // backup automático diário do banco (proteção do histórico)
});
