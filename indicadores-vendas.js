// indicadores-vendas.js
// ENDPOINT EXTERNO DE INDICADORES DE VENDAS — GET /api/externo/indicadores-vendas
//
// Fornece ao Scob 3D Operations só números AGREGADOS do atendimento de
// Vendas (contrato v1): conversas finalizadas hoje e no mês, conversas
// aguardando resposta e tempo médio de primeira resposta de hoje. Nenhum
// nome, telefone, texto de mensagem, valor de venda ou dado do Financeiro.
// Somente leitura: nada aqui altera conversas ou mensagens.
//
// Fórmulas, divergências com os relatórios atuais e limitações estão em
// INDICADORES-VENDAS.md.
//
// SEGURANÇA
// - Só existe na instalação de Vendas, e só com SETOR=vendas definido
//   EXPLICITAMENTE no ambiente. O padrão do resto do sistema (SETOR
//   ausente = vendas) não vale aqui: sem a variável, responde 404. Em
//   qualquer outro setor também é 404.
// - Token próprio da integração (INDICADORES_VENDAS_TOKEN, mínimo 32
//   caracteres), diferente do RELATORIO_TOKEN e de qualquer sessão de
//   vendedor. Sem token configurado, recusa tudo (503).
// - Comparação do token em tempo constante e limite de requisições por IP.
// - Nenhum log por requisição (nem IP, nem token, nem dado de conversa).

const crypto = require('crypto');
const express = require('express');
const horario = require('./horario');

const TAMANHO_MINIMO_TOKEN = 32;
const LIMITE_PADRAO = { janelaMs: 60 * 1000, max: 20 };
const OFFSET_BRT = 3 * 60 * 60 * 1000; // UTC-3 fixo, igual ao horario.js
const DIA_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------
// DATAS — o banco guarda UTC no formato do SQLite ("2026-11-01 12:00:00.000");
// alguns campos antigos podem ter vindo em ISO com "Z". Os cortes de "hoje"
// e "mês" seguem o dia de Brasília.
// ---------------------------------------------------------------
function lerDataBanco(texto) {
  if (!texto) return null;
  const iso = texto.includes('T') ? texto : texto.replace(' ', 'T');
  return new Date(/Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
}

function paraFormatoBanco(data) {
  return data.toISOString().replace('T', ' ').replace('Z', '');
}

// Início do dia e do mês de Brasília que contêm "agora", em UTC.
function cortesBrasilia(agora) {
  const brt = new Date(agora.getTime() - OFFSET_BRT);
  const inicioDia = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + OFFSET_BRT;
  const inicioMes = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1) + OFFSET_BRT;
  return { inicioDia: new Date(inicioDia), inicioMes: new Date(inicioMes) };
}

// ISO 8601 com o fuso de Brasília explícito, ex.: "2026-11-01T12:00:00-03:00".
function isoBrasilia(data) {
  return new Date(data.getTime() - OFFSET_BRT).toISOString().slice(0, 19) + '-03:00';
}

const arredondar1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------
// CÁLCULO — só lê colunas de status, datas, remetente e ids. Nunca seleciona
// texto, telefone, nome ou valores.
// ---------------------------------------------------------------
function calcularIndicadoresVendas(db, setorId, agora = new Date()) {
  const { inicioDia, inicioMes } = cortesBrasilia(agora);
  const agoraBanco = paraFormatoBanco(agora);

  // FINALIZADAS: conversas (não grupo) com status encerrado cujo último
  // encerramento (encerrado_em) caiu no dia / mês de Brasília.
  const contarEncerradas = (desde) => db.prepare(`
    SELECT COUNT(*) AS n FROM leads
    WHERE setor_id = ? AND is_grupo = 0 AND status = 'encerrado' AND encerrado_em IS NOT NULL
      AND julianday(encerrado_em) >= julianday(?) AND julianday(encerrado_em) <= julianday(?)
  `).get(setorId, paraFormatoBanco(desde), agoraBanco).n;

  // Mensagens relevantes: só cliente e vendedor (humano). 'ia' (boas-vindas
  // automática) e 'nota' (nota interna) não contam como resposta.
  const ultimaRelevante = db.prepare(`
    SELECT id, remetente FROM mensagens
    WHERE lead_id = ? AND remetente IN ('cliente', 'vendedor') ORDER BY id DESC LIMIT 1
  `);
  const ultimaDoVendedorAntes = db.prepare(`
    SELECT MAX(id) AS id FROM mensagens WHERE lead_id = ? AND remetente = 'vendedor' AND id < ?
  `);
  const primeiraDoClienteApos = db.prepare(`
    SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' AND id > ? ORDER BY id LIMIT 1
  `);
  const primeiraDoVendedorApos = db.prepare(`
    SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente = 'vendedor' AND id > ? ORDER BY id LIMIT 1
  `);

  // Começo da sequência de mensagens do cliente ainda sem resposta humana
  // que contém a mensagem `idMensagem` (pode ter começado em outro dia).
  function inicioDaEspera(leadId, idMensagem) {
    const anterior = ultimaDoVendedorAntes.get(leadId, idMensagem);
    return lerDataBanco(primeiraDoClienteApos.get(leadId, anterior && anterior.id ? anterior.id : 0).criado_em);
  }

  // AGUARDANDO RESPOSTA: conversas abertas (não encerradas, não grupo) cuja
  // última mensagem relevante é do cliente. A espera conta do começo dessa
  // sequência até agora, só em minutos de expediente (horario.js).
  const abertas = db.prepare(`
    SELECT id FROM leads WHERE setor_id = ? AND status != 'encerrado' AND is_grupo = 0
  `).all(setorId);
  let aguardando = 0;
  let maiorEspera = 0;
  for (const lead of abertas) {
    const ultima = ultimaRelevante.get(lead.id);
    if (!ultima || ultima.remetente !== 'cliente') continue;
    aguardando += 1;
    maiorEspera = Math.max(maiorEspera, horario.minutosUteis(inicioDaEspera(lead.id, ultima.id), agora));
  }

  // PRIMEIRA RESPOSTA DE HOJE: para cada conversa (não grupo) em que o
  // cliente escreveu hoje, mede da primeira mensagem dele no dia (ou do
  // começo da espera, se ela vinha de antes) até a primeira mensagem humana
  // depois dela, em minutos de expediente. Sem resposta ainda: sem_resposta.
  // O id das mensagens cresce com o tempo: achar a última mensagem antes do
  // corte evita ler a tabela inteira, que não tem índice por data.
  const antesDoCorte = db.prepare('SELECT id FROM mensagens WHERE criado_em < ? ORDER BY id DESC LIMIT 1')
    .get(paraFormatoBanco(inicioDia));
  const primeirasDoDia = db.prepare(`
    SELECT m.lead_id, MIN(m.id) AS id FROM mensagens m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.id > ? AND m.remetente = 'cliente' AND l.setor_id = ? AND l.is_grupo = 0
      AND julianday(m.criado_em) >= julianday(?) AND julianday(m.criado_em) <= julianday(?)
    GROUP BY m.lead_id
  `).all(antesDoCorte ? antesDoCorte.id : 0, setorId, paraFormatoBanco(inicioDia), agoraBanco);

  const tempos = [];
  let semResposta = 0;
  for (const { lead_id: leadId, id } of primeirasDoDia) {
    const resposta = primeiraDoVendedorApos.get(leadId, id);
    const respondidaEm = resposta ? lerDataBanco(resposta.criado_em) : null;
    if (!respondidaEm || respondidaEm > agora) {
      semResposta += 1;
      continue;
    }
    tempos.push(horario.minutosUteis(inicioDaEspera(leadId, id), respondidaEm));
  }
  const media = tempos.length ? tempos.reduce((a, b) => a + b, 0) / tempos.length : null;

  return {
    versao: 1,
    setor: 'vendas',
    gerado_em: isoBrasilia(agora),
    finalizadas: { hoje: contarEncerradas(inicioDia), mes: contarEncerradas(inicioMes) },
    aguardando_resposta: { total: aguardando, espera_mais_antiga_min: arredondar1(maiorEspera) },
    primeira_resposta_hoje: {
      media_min: media === null ? null : arredondar1(media),
      amostras: tempos.length,
      sem_resposta: semResposta,
    },
  };
}

// ---------------------------------------------------------------
// ROTA
// ---------------------------------------------------------------
function tokenConfigurado(env) {
  const token = (env.INDICADORES_VENDAS_TOKEN || '').trim();
  return token.length >= TAMANHO_MINIMO_TOKEN ? token : null;
}

// Compara pelo hash (mesmo tamanho sempre), em tempo constante.
function tokenConfere(recebido, esperado) {
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

// Janela fixa por IP, em memória (reinicia junto com o servidor).
function criarLimitador({ janelaMs, max }) {
  const contagens = new Map();
  return function permitir(chave, agoraMs) {
    for (const [k, v] of contagens) if (agoraMs - v.inicio >= janelaMs) contagens.delete(k);
    const atual = contagens.get(chave) || { inicio: agoraMs, n: 0 };
    atual.n += 1;
    contagens.set(chave, atual);
    return atual.n <= max ? { ok: true } : { ok: false, retryAfterS: Math.ceil((atual.inicio + janelaMs - agoraMs) / 1000) };
  };
}

function criarRotaIndicadoresVendas({ db, env = process.env, agora = () => new Date(), limite = LIMITE_PADRAO }) {
  const router = express.Router();
  const permitir = criarLimitador(limite);

  router.get('/api/externo/indicadores-vendas', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

    // Setor explícito: SETOR ausente (padrão "vendas" do sistema) não ativa a rota.
    const setor = (env.SETOR || '').trim().toLowerCase();
    if (setor !== 'vendas') return res.status(404).json({ erro: 'nao_encontrado' });

    const limiteOk = permitir(req.ip || 'desconhecido', Date.now());
    if (!limiteOk.ok) {
      res.set('Retry-After', String(limiteOk.retryAfterS));
      return res.status(429).json({ erro: 'muitas_requisicoes' });
    }

    const esperado = tokenConfigurado(env);
    if (!esperado) return res.status(503).json({ erro: 'nao_configurado' });

    const m = (req.get('authorization') || '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!m || !tokenConfere(m[1], esperado)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ erro: 'nao_autorizado' });
    }

    const setorObj = db.getSetorPorSlug('vendas');
    if (!setorObj) return res.status(404).json({ erro: 'nao_encontrado' });

    try {
      res.json(calcularIndicadoresVendas(db, setorObj.id, agora()));
    } catch (e) {
      console.error('>> [indicadores-vendas] falha ao calcular os indicadores');
      res.status(500).json({ erro: 'falha_interna' });
    }
  });

  return router;
}

module.exports = { criarRotaIndicadoresVendas, calcularIndicadoresVendas, cortesBrasilia, isoBrasilia };
