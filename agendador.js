// agendador.js
// Roda a análise de fim de dia sozinha, 1x por dia, às 21h (horário de
// Brasília — o Brasil não tem mais horário de verão desde 2019, então
// UTC-3 é fixo o ano todo). Rodar às 21h em vez de 18h dá tempo de
// abranger o expediente inteiro da loja antes de analisar o dia.
//
// Em vez de sugerir tarefa a cada mensagem (o que gastaria token o dia
// inteiro), a IA só é chamada uma vez por conversa em aberto, no fim do
// dia, pra identificar gargalos e oportunidades de venda complementar —
// e já cria a tarefa na agenda sozinha (o vendedor só confere/conclui).
//
// Além de fazer o trabalho, essa função também VOLTA um relatório
// detalhado (não só contagem) — item por item do que foi decidido e
// quais tarefas foram criadas — pra alimentar a tela de resultado da
// análise manual e a seção da IA no relatório do dia.
//
// Limitação: o "já rodou hoje" fica em memória — se o servidor reiniciar
// (redeploy) depois das 21h no mesmo dia, pode rodar de novo e duplicar
// alguma tarefa. Baixo impacto (o vendedor só vê a tarefa 2x), mas fica
// registrado.

const db = require('./db');
const claudeIA = require('./claude');

let ultimaExecucaoData = null;

// Monta as conversas com atividade HOJE de um setor, já com o nome do
// atendente responsável em cada lead (lead.vendedor_nome), respeitando um
// orçamento de caracteres pra não estourar token num setor com muito volume.
// Usado pela curadoria de qualidade diária (relatório por vendedor).
function montarConversasDoDia(setorId) {
  const LIMITE_CONVERSAS = 60;
  const LIMITE_MENSAGENS = 40;
  const MAX_CHARS_MSG = 400;
  const ORCAMENTO_CHARS = 45000;

  const leads = db.prepare(`
    SELECT leads.*, MAX(mensagens.criado_em) AS ultima_msg
    FROM leads
    JOIN mensagens ON mensagens.lead_id = leads.id
    WHERE leads.setor_id = ? AND date(mensagens.criado_em) = date('now')
    GROUP BY leads.id
    ORDER BY ultima_msg DESC
    LIMIT ?
  `).all(setorId, LIMITE_CONVERSAS);
  if (leads.length === 0) return [];

  const vendMap = {};
  db.prepare('SELECT id, nome FROM vendedores').all().forEach((v) => { vendMap[v.id] = v.nome; });

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
    lead.vendedor_nome = lead.vendedor_id ? (vendMap[lead.vendedor_id] || null) : null;
    const tamanho = mensagens.reduce((s, m) => s + ((m.texto || '').length) + 24, 0) + 60;
    conversas.push({ lead, mensagens });
    acumulado += tamanho;
  }
  return conversas;
}

function agoraBRT() {
  const agora = new Date();
  const brt = new Date(agora.getTime() - 3 * 60 * 60 * 1000); // UTC-3
  return { hora: brt.getUTCHours(), dataISO: brt.toISOString().slice(0, 10) };
}

function amanha8hISO() {
  const { dataISO } = agoraBRT();
  const amanha = new Date(new Date(dataISO + 'T08:00:00-03:00').getTime() + 24 * 60 * 60 * 1000);
  return amanha.toISOString();
}

async function rodarAnaliseDiaria() {
  if (!claudeIA.configurado) {
    console.log('>> Análise diária pulada: IA não configurada (ANTHROPIC_API_KEY ausente).');
    return { rodou: false, motivo: 'ia_nao_configurada' };
  }

  const quando = amanha8hISO();
  const encerradosClassificados = [];
  const tarefasCriadas = [];
  const leadsEsquecidos = [];
  let relatorioFinanceiroGerado = false;

  const setorFinanceiro = db.getSetorPorSlug('financeiro');

  // 0) Conversas ENCERRADAS ainda sem resultado definido: a IA lê e decide
  // sozinha se converteu/perdeu, valor e motivo — sem confirmação humana
  // (decisão explícita do Silvio, com o trade-off já discutido: agiliza o
  // encerramento no dia a dia, mas confia no julgamento da IA pro dado
  // financeiro do relatório).
  // "Convertido/perdido" é conceito de VENDA — não se aplica ao Financeiro
  // (cobrança/negociação), por isso ele fica de fora daqui.
  const encerradosPendentes = db.prepare(`
    SELECT * FROM leads WHERE status = 'encerrado' AND resultado IS NULL
    AND (setor_id != ? OR setor_id IS NULL)
  `).all(setorFinanceiro ? setorFinanceiro.id : -1);
  for (const lead of encerradosPendentes) {
    const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    if (mensagens.length === 0) continue;

    const analise = await claudeIA.analisarConversa(mensagens);
    if (!analise || !analise.resultado_sugerido) continue;

    const resumo = analise.resumo || null;

    if (analise.resultado_sugerido === 'convertido') {
      db.prepare(`UPDATE leads SET resultado = 'convertido', valor_venda = ?, resumo_ia = ?, convertido_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`)
        .run(analise.valor_sugerido || 0, resumo, lead.id);
      encerradosClassificados.push({
        lead_id: lead.id, nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        resultado: 'convertido', valor_venda: analise.valor_sugerido || 0, motivo_perda: null, resumo,
      });
      if (lead.vendedor_id) {
        const daqui3dias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const titulo = `🤖 Pós-venda — confirmar se ${lead.nome_cliente || lead.telefone} recebeu tudo certo`;
        const info = db.prepare(`
          INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
          VALUES (?, ?, ?, ?, 'pos_venda', strftime('%Y-%m-%d %H:%M:%f','now'))
        `).run(lead.id, lead.vendedor_id, titulo, daqui3dias);
        tarefasCriadas.push({
          lembrete_id: info.lastInsertRowid, lead_id: lead.id,
          nome_cliente: lead.nome_cliente, telefone: lead.telefone,
          titulo, tipo: 'pos_venda', categoria: 'pos_venda',
        });
      }
    } else if (analise.resultado_sugerido === 'perdido') {
      const motivo = analise.motivo_perda_sugerido || 'não identificado pela IA';
      db.prepare(`UPDATE leads SET resultado = 'perdido', motivo_perda = ?, resumo_ia = ? WHERE id = ?`)
        .run(motivo, resumo, lead.id);
      encerradosClassificados.push({
        lead_id: lead.id, nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        resultado: 'perdido', valor_venda: null, motivo_perda: motivo, resumo,
      });
    } else {
      // "indefinido" — marca assim mesmo, pra não ficar reanalisando pra sempre
      db.prepare(`UPDATE leads SET resultado = 'indefinido', resumo_ia = ? WHERE id = ?`).run(resumo, lead.id);
      encerradosClassificados.push({
        lead_id: lead.id, nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        resultado: 'indefinido', valor_venda: null, motivo_perda: null, resumo,
      });
    }
  }

  // 0.5) Vendas que o vendedor já confirmou na hora (encerrar → "Fechou o
  // pedido") mas sem informar valor — a IA lê a conversa só pra estimar
  // o valor, sem mexer no resultado (isso já foi decidido pelo humano).
  const vendasSemValor = db.prepare(`
    SELECT * FROM leads WHERE resultado = 'convertido' AND valor_venda IS NULL
    AND (setor_id != ? OR setor_id IS NULL)
  `).all(setorFinanceiro ? setorFinanceiro.id : -1);
  for (const lead of vendasSemValor) {
    const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    if (mensagens.length === 0) continue;

    const analise = await claudeIA.analisarConversa(mensagens);
    if (!analise) continue;

    db.prepare(`UPDATE leads SET valor_venda = ?, resumo_ia = COALESCE(resumo_ia, ?) WHERE id = ?`)
      .run(analise.valor_sugerido || 0, analise.resumo || null, lead.id);
  }

  // 1) Conversas em aberto: IA procura gargalo + oportunidade de complementar
  // (Financeiro fica de fora — ganha a análise própria no bloco 1.5, logo abaixo)
  const leadsAbertos = db.prepare(`
    SELECT * FROM leads WHERE status = 'em_atendimento' AND (setor_id != ? OR setor_id IS NULL)
  `).all(setorFinanceiro ? setorFinanceiro.id : -1);

  for (const lead of leadsAbertos) {
    const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    if (mensagens.length === 0 || !lead.vendedor_id) continue;

    const analise = await claudeIA.analisarDiaria(mensagens);
    if (!analise) continue;

    if (analise.gargalo && analise.gargalo.existe && analise.gargalo.titulo) {
      const titulo = `🤖 ${analise.gargalo.titulo}`;
      const info = db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
      `).run(lead.id, lead.vendedor_id, titulo, quando, analise.gargalo.tipo || 'outro');
      tarefasCriadas.push({
        lembrete_id: info.lastInsertRowid, lead_id: lead.id,
        nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        titulo, tipo: analise.gargalo.tipo || 'outro', categoria: 'gargalo',
      });
    }

    if (analise.oportunidade && analise.oportunidade.existe && analise.oportunidade.titulo) {
      const titulo = `🤖 ${analise.oportunidade.titulo}`;
      const info = db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
        VALUES (?, ?, ?, ?, 'oportunidade', strftime('%Y-%m-%d %H:%M:%f','now'))
      `).run(lead.id, lead.vendedor_id, titulo, quando);
      tarefasCriadas.push({
        lembrete_id: info.lastInsertRowid, lead_id: lead.id,
        nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        titulo, tipo: 'oportunidade', categoria: 'oportunidade',
      });
    }
  }

  // 1.5) CURADORIA DE QUALIDADE (diária) — roda pro setor DESTE sistema
  // (Vendas ou Financeiro, conforme a variável SETOR). Varre TODAS as
  // conversas com atividade hoje e gera o relatório de desempenho por
  // vendedor (texto humano + bloco de métricas em JSON). Guarda em
  // analises_personalizadas com metricas_json — é isso que o dashboard
  // externo lê como "análise mais recente", atualizando sozinho todo dia.
  // No Financeiro, também atualiza o relatório diário (relatorios_financeiro),
  // que é o que esse setor já exibia na tela.
  let curadoriaQualidadeGerada = false;
  const SETOR_ATIVO = (process.env.SETOR || 'vendas').toLowerCase();
  const setorAtivo = db.getSetorPorSlug(SETOR_ATIVO);
  if (setorAtivo) {
    const hojeISO = agoraBRT().dataISO;
    const conversas = montarConversasDoDia(setorAtivo.id);
    if (conversas.length > 0) {
      const q = await claudeIA.analisarQualidade(conversas, { setor: SETOR_ATIVO });
      if (q && q.conteudo && !q.erro) {
        const metricasJson = q.metricas ? JSON.stringify(q.metricas) : null;
        db.prepare(`
          INSERT INTO analises_personalizadas (setor_id, instrucao, conteudo, metricas_json, criado_por, gerado_em)
          VALUES (?, 'Análise diária automática', ?, ?, NULL, strftime('%Y-%m-%d %H:%M:%f','now'))
        `).run(setorAtivo.id, q.conteudo, metricasJson);

        if (SETOR_ATIVO === 'financeiro') {
          db.prepare(`
            INSERT INTO relatorios_financeiro (setor_id, data, conteudo, metricas_json, gerado_em)
            VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
            ON CONFLICT(setor_id, data) DO UPDATE SET conteudo = excluded.conteudo, metricas_json = excluded.metricas_json, gerado_em = excluded.gerado_em
          `).run(setorAtivo.id, hojeISO, q.conteudo, metricasJson);
          relatorioFinanceiroGerado = true;
        }
        curadoriaQualidadeGerada = true;
      }
    }
  }

  // 2) Leads 'novo' que ninguém puxou o dia inteiro — vira alerta pro admin
  // (checagem simples, sem IA: se ninguém pegou, não tem conversa pra analisar)
  const admin = db.prepare(`SELECT id FROM vendedores WHERE role = 'admin' LIMIT 1`).get();
  if (admin) {
    const esquecidos = db.prepare(`
      SELECT * FROM leads WHERE status = 'novo' AND datetime(criado_em) <= datetime('now', '-6 hours')
    `).all();
    for (const lead of esquecidos) {
      const jaExiste = db.prepare(`
        SELECT id FROM lembretes WHERE lead_id = ? AND titulo LIKE '🤖 Ninguém puxou%'
      `).get(lead.id);
      if (jaExiste) continue;
      const titulo = `🤖 Ninguém puxou o lead de ${lead.nome_cliente || lead.telefone} ainda — verificar fila`;
      const info = db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo, criado_em)
        VALUES (?, ?, ?, ?, 'outro', strftime('%Y-%m-%d %H:%M:%f','now'))
      `).run(lead.id, admin.id, titulo, quando);
      const item = {
        lembrete_id: info.lastInsertRowid, lead_id: lead.id,
        nome_cliente: lead.nome_cliente, telefone: lead.telefone,
        titulo, tipo: 'outro', categoria: 'esquecido',
      };
      tarefasCriadas.push(item);
      leadsEsquecidos.push(item);
    }
  }

  console.log(`>> Análise diária concluída: ${leadsAbertos.length} conversas em aberto revisadas, ${encerradosClassificados.length} encerrada(s) classificada(s), ${tarefasCriadas.length} tarefa(s) criada(s)${curadoriaQualidadeGerada ? ', curadoria de qualidade gerada' : ''}.`);
  return {
    rodou: true,
    conversas_revisadas: leadsAbertos.length,
    encerrados_analisados: encerradosClassificados.length,
    tarefas_criadas_total: tarefasCriadas.length,
    encerrados_classificados: encerradosClassificados,
    tarefas_criadas: tarefasCriadas,
    leads_esquecidos: leadsEsquecidos,
    relatorio_financeiro_gerado: relatorioFinanceiroGerado,
    curadoria_qualidade_gerada: curadoriaQualidadeGerada,
  };
}

// Verifica a cada 5 minutos se já são 21h (BRT) e ainda não rodou hoje.
function iniciarAgendador() {
  setInterval(async () => {
    const { hora, dataISO } = agoraBRT();
    if (hora === 21 && ultimaExecucaoData !== dataISO) {
      ultimaExecucaoData = dataISO;
      console.log('>> Rodando análise diária automática (21h)...');
      await rodarAnaliseDiaria();
    }
  }, 5 * 60 * 1000);
  console.log('>> Agendador da análise diária ativo (roda sozinho às 21h, horário de Brasília).');
}

module.exports = { iniciarAgendador, rodarAnaliseDiaria };
