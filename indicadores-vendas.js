// indicadores-vendas.js
// ENDPOINT EXTERNO DE INDICADORES DE VENDAS — GET /api/externo/indicadores-vendas
//
// Fornece ao Scob 3D Operations só números AGREGADOS do atendimento de
// Vendas (contrato v2), exatamente três indicadores do dia (Brasília):
// conversas encerradas hoje, tempo médio até a primeira resposta humana e
// tempo médio de resposta humana — os dois tempos com amostras e esperas
// sem resposta. Nenhum nome, telefone, texto de mensagem, valor de venda ou
// dado do Financeiro. Somente leitura: nada aqui altera conversas ou mensagens.
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
// - Comparação do token em tempo constante.
// - Dois limites de requisições SEPARADOS (ver "LIMITES" abaixo): tentativas
//   com token inválido nunca consomem a cota das consultas autenticadas.
// - Nenhum log por requisição (nem IP, nem token, nem dado de conversa).

const crypto = require('crypto');
const express = require('express');
const horario = require('./horario');

const TAMANHO_MINIMO_TOKEN = 32;
// LIMITES (janela fixa de 1 min, em memória; zeram quando o serviço reinicia):
// - autorizadas: consultas com token VÁLIDO, numa cota única da integração
//   (só quem tem o token consome). Protege o banco se o token vazar.
// - falhas: tentativas com token ausente ou inválido, por endereço da conexão
//   (req.ip). Sem 'trust proxy', o X-Forwarded-For enviado pelo cliente é
//   ignorado; atrás de um proxy, req.ip é o do proxy e a cota de falhas vira
//   uma só para todos — o que só afeta outras tentativas inválidas.
// O token é sempre verificado primeiro: durante o bloqueio de falhas, o token
// certo continua sendo aceito. A defesa contra adivinhação é o tamanho do
// token (≥ 32 caracteres aleatórios); o limite de falhas reduz o volume.
const LIMITES_PADRAO = {
  autorizadas: { janelaMs: 60 * 1000, max: 30 },
  falhas: { janelaMs: 60 * 1000, max: 10 },
};
const MAX_CHAVES_FALHAS = 1000;
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

// Início do dia de Brasília que contém "agora", em UTC.
function inicioDoDiaBrasilia(agora) {
  const brt = new Date(agora.getTime() - OFFSET_BRT);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + OFFSET_BRT);
}

// ISO 8601 com o fuso de Brasília explícito, ex.: "2026-11-01T12:00:00-03:00".
function isoBrasilia(data) {
  return new Date(data.getTime() - OFFSET_BRT).toISOString().slice(0, 19) + '-03:00';
}

const arredondar1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------
// ESPERAS — regras (ver INDICADORES-VENDAS.md):
// - Só contam mensagens 'cliente' e 'vendedor' (humano: painel, celular,
//   encaminhamento, figurinha). 'ia' (automática) e 'nota' (interna) são
//   ignoradas: não abrem nem respondem espera.
// - Espera: começa na primeira mensagem do cliente depois da última resposta
//   humana (ou do início do ciclo); mensagens seguintes do cliente não
//   reiniciam o relógio. Termina na próxima mensagem do vendedor.
// - Ciclo de atendimento: começa na criação da conversa ou na primeira
//   mensagem depois do último encerramento registrado (conversa reaberta).
//   Só o ÚLTIMO encerramento fica no banco (leads.encerrado_em): ciclos de
//   reaberturas anteriores não são distinguidos (limitação aceita).
// - A primeira espera RESPONDIDA de cada ciclo é a "primeira resposta".
// ---------------------------------------------------------------
function esperasDaConversa(mensagens, encerradoEm) {
  const encerramento = encerradoEm ? lerDataBanco(encerradoEm) : null;
  const respondidas = [];
  let aberta = null;
  let respondidaNoCiclo = false;
  let anterior = null;
  for (const m of mensagens) {
    const em = lerDataBanco(m.criado_em);
    if (encerramento && anterior && anterior <= encerramento && em > encerramento) {
      // Reaberta: a espera do ciclo anterior terminou no encerramento, sem resposta.
      aberta = null;
      respondidaNoCiclo = false;
    }
    anterior = em;
    if (m.remetente === 'cliente') {
      if (!aberta) aberta = { inicio: em, primeira: !respondidaNoCiclo };
    } else if (aberta) {
      respondidas.push({ ...aberta, resposta: em });
      respondidaNoCiclo = true;
      aberta = null;
    }
  }
  return { respondidas, aberta };
}

const media = (valores) => (valores.length ? arredondar1(valores.reduce((a, b) => a + b, 0) / valores.length) : null);

// ---------------------------------------------------------------
// CÁLCULO — só lê colunas de status, datas, remetente e ids. Nunca seleciona
// texto, telefone, nome ou valores.
// ---------------------------------------------------------------
function calcularIndicadoresVendas(db, setorId, agora = new Date()) {
  const inicioDia = inicioDoDiaBrasilia(agora);
  const desde = paraFormatoBanco(inicioDia);
  const ate = paraFormatoBanco(agora);

  // 1. ENCERRADAS HOJE: conversas (não grupo) encerradas, com o último
  // encerramento (encerrado_em) no dia de Brasília.
  const encerradasHoje = db.prepare(`
    SELECT COUNT(*) AS n FROM leads
    WHERE setor_id = ? AND is_grupo = 0 AND status = 'encerrado' AND encerrado_em IS NOT NULL
      AND julianday(encerrado_em) >= julianday(?) AND julianday(encerrado_em) <= julianday(?)
  `).get(setorId, desde, ate).n;

  // Conversas a analisar: as com resposta humana hoje e as abertas (esperas
  // em andamento). O id das mensagens cresce com o tempo: partir da última
  // mensagem antes do corte evita ler a tabela inteira (sem índice por data).
  const antesDoCorte = db.prepare('SELECT id FROM mensagens WHERE criado_em < ? ORDER BY id DESC LIMIT 1').get(desde);
  const respondidasHoje = db.prepare(`
    SELECT DISTINCT m.lead_id AS id FROM mensagens m JOIN leads l ON l.id = m.lead_id
    WHERE m.id > ? AND m.remetente = 'vendedor' AND l.setor_id = ? AND l.is_grupo = 0
      AND julianday(m.criado_em) >= julianday(?) AND julianday(m.criado_em) <= julianday(?)
  `).all(antesDoCorte ? antesDoCorte.id : 0, setorId, desde, ate);
  const abertas = db.prepare(`
    SELECT id FROM leads WHERE setor_id = ? AND is_grupo = 0 AND status != 'encerrado'
  `).all(setorId);
  const conversa = db.prepare('SELECT status, encerrado_em FROM leads WHERE id = ?');
  // Só até "agora": o cálculo de um instante não usa mensagens posteriores.
  const relevantes = db.prepare(`
    SELECT remetente, criado_em FROM mensagens
    WHERE lead_id = ? AND remetente IN ('cliente', 'vendedor') AND julianday(criado_em) <= julianday(?) ORDER BY id
  `);

  const primeiras = [];
  const todas = [];
  let semRespostaPrimeira = 0;
  let semResposta = 0;
  const ids = new Set([...respondidasHoje, ...abertas].map((l) => l.id));
  for (const id of ids) {
    const lead = conversa.get(id);
    const { respondidas, aberta } = esperasDaConversa(relevantes.all(id, ate), lead.encerrado_em);
    for (const e of respondidas) {
      // Agrupadas pelo dia da resposta humana.
      if (e.resposta < inicioDia || e.resposta > agora) continue;
      const minutos = horario.minutosUteis(e.inicio, e.resposta);
      todas.push(minutos);
      if (e.primeira) primeiras.push(minutos);
    }
    // Sem resposta: esperas em andamento agora, em conversas abertas.
    if (aberta && lead.status !== 'encerrado') {
      semResposta += 1;
      if (aberta.primeira) semRespostaPrimeira += 1;
    }
  }

  return {
    versao: 2,
    setor: 'vendas',
    gerado_em: isoBrasilia(agora),
    encerradas_hoje: encerradasHoje,
    primeira_resposta: { media_min: media(primeiras), amostras: primeiras.length, sem_resposta: semRespostaPrimeira },
    tempo_resposta: { media_min: media(todas), amostras: todas.length, sem_resposta: semResposta },
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

// Janela fixa por chave, em memória (reinicia junto com o servidor). O número
// de chaves é limitado: sem isso, muitos endereços diferentes fariam a
// tabela crescer sem fim.
function criarLimitador({ janelaMs, max }) {
  const contagens = new Map();
  return function permitir(chave, agoraMs) {
    for (const [k, v] of contagens) if (agoraMs - v.inicio >= janelaMs) contagens.delete(k);
    if (!contagens.has(chave) && contagens.size >= MAX_CHAVES_FALHAS) contagens.delete(contagens.keys().next().value);
    const atual = contagens.get(chave) || { inicio: agoraMs, n: 0 };
    atual.n += 1;
    contagens.set(chave, atual);
    return atual.n <= max ? { ok: true } : { ok: false, retryAfterS: Math.ceil((atual.inicio + janelaMs - agoraMs) / 1000) };
  };
}

// Situação da rota nesta instalação, para o log de inicialização (sem segredos).
function statusIndicadoresVendas(env = process.env) {
  if ((env.SETOR || '').trim().toLowerCase() !== 'vendas') return 'inativa (SETOR=vendas não está definido explicitamente)';
  if (!tokenConfigurado(env)) return 'inativa (INDICADORES_VENDAS_TOKEN ausente ou com menos de 32 caracteres)';
  return 'ativa';
}

function criarRotaIndicadoresVendas({ db, env = process.env, agora = () => new Date(), limites = LIMITES_PADRAO }) {
  const router = express.Router();
  const permitirAutorizada = criarLimitador(limites.autorizadas);
  const registrarFalha = criarLimitador(limites.falhas);

  function muitas(res, resultado, erro) {
    res.set('Retry-After', String(resultado.retryAfterS));
    return res.status(429).json({ erro });
  }

  router.get('/api/externo/indicadores-vendas', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

    // Setor explícito: SETOR ausente (padrão "vendas" do sistema) não ativa a rota.
    const setor = (env.SETOR || '').trim().toLowerCase();
    if (setor !== 'vendas') return res.status(404).json({ erro: 'nao_encontrado' });

    const esperado = tokenConfigurado(env);
    if (!esperado) return res.status(503).json({ erro: 'nao_configurado' });

    const m = (req.get('authorization') || '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!m || !tokenConfere(m[1], esperado)) {
      // req.ip: endereço da conexão (sem 'trust proxy', X-Forwarded-For não conta).
      const falha = registrarFalha(req.ip || 'desconhecido', Date.now());
      if (!falha.ok) return muitas(res, falha, 'muitas_tentativas');
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ erro: 'nao_autorizado' });
    }

    const cota = permitirAutorizada('integracao', Date.now());
    if (!cota.ok) return muitas(res, cota, 'muitas_requisicoes');

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

module.exports = { criarRotaIndicadoresVendas, calcularIndicadoresVendas, statusIndicadoresVendas, esperasDaConversa, inicioDoDiaBrasilia, isoBrasilia };
