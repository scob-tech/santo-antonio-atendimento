// claude.js
// Camada de IA de verdade, usando a API da Anthropic. Três responsabilidades:
//   1. Gerar a boas-vindas automática + resumo de interesse (na hora que o
//      lead chega, substitui o stub de palavra-chave do ai.js)
//   2. Analisar uma conversa inteira e SUGERIR se fechou, valor e resumo
//      pro relatório — o vendedor sempre confirma antes de contar de verdade
//   3. Sugerir uma tarefa de follow-up pra agenda, olhando a conversa
//
// Configuração via variável de ambiente ANTHROPIC_API_KEY. Sem ela, todas
// as funções retornam null e quem chamou usa o stub antigo (ai.js) como
// fallback — o sistema nunca trava por falta de IA configurada.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';

const configurado = Boolean(ANTHROPIC_API_KEY);

if (!configurado) {
  console.log('>> IA real não configurada (ANTHROPIC_API_KEY ausente) — usando respostas padrão simples (ai.js).');
}

async function chamarClaude(system, mensagemUsuario, maxTokens = 400) {
  if (!configurado) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: mensagemUsuario }],
      }),
    });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Erro na API da Anthropic (status ${res.status}): ${erro}`);
      return null;
    }
    const data = await res.json();
    const bloco = (data.content || []).find((b) => b.type === 'text');
    return bloco ? bloco.text : null;
  } catch (err) {
    console.error('>> Erro de rede chamando a Anthropic:', err.message);
    return null;
  }
}

// Igual ao chamarClaude, mas em vez de engolir a falha e devolver null,
// devolve { texto, erro } com o MOTIVO real — pra funções sob demanda
// (ex: análise sob medida) conseguirem mostrar pra pessoa por que não
// rodou, em vez de um "não consegui agora" genérico que não ajuda a
// entender se foi tamanho, cota, rede, etc.
async function chamarClaudeComMotivo(system, mensagemUsuario, maxTokens = 400) {
  if (!configurado) return { texto: null, erro: 'IA não configurada (falta ANTHROPIC_API_KEY no servidor).' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: mensagemUsuario }],
      }),
    });
    if (!res.ok) {
      const cru = await res.text().catch(() => '');
      console.error(`>> Erro na API da Anthropic (status ${res.status}): ${cru}`);
      let detalhe = cru;
      try { const j = JSON.parse(cru); detalhe = (j.error && j.error.message) ? j.error.message : cru; } catch {}
      return { texto: null, erro: `A IA recusou o pedido (HTTP ${res.status}): ${String(detalhe).slice(0, 300)}` };
    }
    const data = await res.json();
    const blocos = Array.isArray(data.content) ? data.content : [];
    // Junta TODOS os blocos de texto (não só o primeiro) — mais robusto caso
    // a resposta venha em partes ou com um bloco de "raciocínio" antes.
    const texto = blocos.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('').trim();
    if (texto) return { texto, erro: null };
    // Veio 200 mas sem texto: registra o motivo real (geralmente o modelo
    // gastou o orçamento raciocinando e parou por 'max_tokens' antes de
    // escrever). Devolve a flag semTexto pra quem chamou poder tentar de novo.
    const tipos = blocos.map((b) => b.type).join(', ') || 'nenhum';
    const motivo = data.stop_reason || 'desconhecido';
    console.error(`>> IA 200 sem texto. stop_reason=${motivo} blocos=[${tipos}] usage=${JSON.stringify(data.usage || {})}`);
    return { texto: null, erro: `A IA parou antes de escrever o relatório (motivo: ${motivo}). Tenta de novo, ou deixa a pergunta um pouco mais objetiva.`, semTexto: true };
  } catch (err) {
    console.error('>> Erro de rede chamando a Anthropic:', err.message);
    return { texto: null, erro: `Erro de rede ao falar com a IA: ${err.message}` };
  }
}

function extrairJSON(texto) {
  if (!texto) return null;
  try {
    const limpo = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(limpo);
  } catch {
    return null;
  }
}

function formatarTranscricao(mensagens) {
  return mensagens
    .map((m) => `${m.remetente === 'cliente' ? 'Cliente' : m.remetente === 'vendedor' ? 'Vendedor' : 'IA'}: ${m.texto}`)
    .join('\n');
}

// Gera boas-vindas + resumo de interesse quando um lead novo chega.
// Retorna { boas_vindas, interesse } ou null se IA não configurada/falhou.
async function processarNovaMensagem(texto, nomeCliente, statusHorario) {
  const contextoHorario = statusHorario && !statusHorario.aberto
    ? ` A loja está FECHADA agora (fora do horário de funcionamento) — a próxima abertura é ${statusHorario.proxima_abertura_texto}. Avise disso de forma natural na mensagem, deixando claro que o pedido já foi anotado e que um vendedor vai atender assim que a loja abrir.`
    : '';

  const system = `Você escreve mensagens automáticas de boas-vindas para o WhatsApp do Depósito Santo Antônio, uma loja de material de construção em São Paulo. Seu tom é caloroso, humano e prestativo — nunca robótico, nunca genérico demais.${contextoHorario} Responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"boas_vindas": "mensagem curta em português, no máximo 3 frases, mostrando que leu o que o cliente escreveu e avisando quando será atendido", "interesse": "resumo bem curto (3-6 palavras) do que o cliente quer, ex: 'cimento e areia' ou 'orçamento de tijolo'"}`;

  const userMsg = `Mensagem do cliente${nomeCliente ? ` (${nomeCliente})` : ''}: "${texto}"`;
  const resposta = await chamarClaude(system, userMsg, 300);
  return extrairJSON(resposta);
}

// Lê a conversa inteira e sugere resultado/valor/resumo pro relatório.
// NUNCA grava nada sozinha — é só sugestão pro vendedor confirmar.
async function analisarConversa(mensagens) {
  const system = `Você analisa conversas de vendas de uma loja de material de construção pra ajudar a preencher o relatório do dia. Leia a conversa e responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"resultado_sugerido": "convertido" | "perdido" | "indefinido", "valor_sugerido": numero_ou_null, "motivo_perda_sugerido": "texto_curto_ou_null", "resumo": "1 frase curta resumindo o que aconteceu na conversa", "confianca": "alta" | "media" | "baixa"}
Use "indefinido" se não estiver claro pela conversa se a venda fechou ou não. Só preencha valor_sugerido se um valor em reais foi claramente mencionado como o valor fechado. motivo_perda_sugerido só se resultado_sugerido for "perdido".`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 400);
  return extrairJSON(resposta);
}

// Sugere uma tarefa de follow-up pra agenda do dia seguinte, olhando a conversa.
async function sugerirTarefa(mensagens) {
  const system = `Você ajuda um vendedor de loja de material de construção a organizar a agenda do dia seguinte. Leia a conversa e diga se falta alguma ação de follow-up óbvia e específica. Responda SOMENTE em JSON válido, sem markdown:
{"sugerir": true_ou_false, "titulo": "o que fazer, curto e direto, ou null", "tipo": "orcamento_ou_catalogo_ou_frete_ou_pos_venda_ou_ligacao_ou_objecao_ou_outro_ou_null"}
Só sugira (sugerir:true) se houver uma ação clara pendente (ex: prometeu mandar orçamento e ainda não mandou, cliente pediu pra ligar depois, ficou de calcular frete). Se a conversa já foi resolvida ou não há nada pendente óbvio, responda sugerir:false.`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 250);
  return extrairJSON(resposta);
}

// Análise de FIM DE DIA (rodada 1x/dia, não a cada mensagem) — olha uma
// conversa ainda em aberto e procura duas coisas pra alimentar a agenda
// do dia seguinte: gargalo (pendência sem resolução) e oportunidade de
// venda complementar (produto relacionado que ainda não foi oferecido).
async function analisarDiaria(mensagens) {
  const system = `Você revisa, no fim do dia, uma conversa de vendas ainda em aberto numa loja de material de construção, procurando duas coisas específicas:
1. GARGALO: o vendedor deixou o cliente sem resposta em algum ponto, ou ficou uma pendência clara sem resolução (ex: prometeu orçamento e não mandou, cliente perguntou algo e não foi respondido).
2. OPORTUNIDADE: dado o que o cliente está comprando ou perguntando, existe um produto complementar óbvio que vale oferecer (ex: quem compra cimento pode precisar de areia/brita; quem faz laje pode precisar de manta impermeabilizante; etc) e isso ainda não foi oferecido na conversa.
Responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"gargalo": {"existe": true_ou_false, "titulo": "ação curta pro vendedor fazer amanhã, ou null", "tipo": "ligacao_ou_orcamento_ou_catalogo_ou_frete_ou_objecao_ou_outro_ou_null"}, "oportunidade": {"existe": true_ou_false, "titulo": "sugestão curta do que oferecer, ou null"}}
Seja conservador: só marque existe:true quando for bem claro pela conversa, pra não gerar tarefa desnecessária.`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 350);
  return extrairJSON(resposta);
}

// Formata mensagens COM horário — a análise do Financeiro precisa saber
// quanto tempo passou entre "cliente pediu" e "equipe respondeu", então
// aqui (diferente de formatarTranscricao) o horário de cada mensagem vai
// junto, pro Claude conseguir calcular esse intervalo sozinho.
function formatarTranscricaoComHorario(mensagens) {
  return mensagens
    .map((m) => {
      const hora = new Date(m.criado_em + (m.criado_em.includes('Z') ? '' : 'Z'))
        .toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const quem = m.remetente === 'cliente' ? 'Cliente' : m.remetente === 'vendedor' ? 'Financeiro' : 'IA';
      return `[${hora}] ${quem}: ${m.texto}`;
    })
    .join('\n');
}

// Varredura diária do FINANCEIRO — bem diferente da análise do Vendas:
// em vez de olhar 1 conversa por vez e gerar tarefa individual, olha
// TODAS as conversas do dia de uma vez e escreve 1 relatório só, pro
// admin ler, apontando gargalo de negociação/cobrança (demora pra
// mandar PIX, acordo travado, ponto fraco na comunicação). Não grava
// nada na conversa nem cria tarefa — só texto de relatório mesmo.
async function analisarFinanceiroDiario(conversas) {
  if (!configurado || conversas.length === 0) return null;

  const system = `Você é um analista de operações do setor Financeiro de uma loja de material de construção (Depósito Santo Antônio). Vai receber TODAS as conversas de WhatsApp do Financeiro de um dia — cobrança, negociação de pagamento, envio de boleto/PIX, emissão de nota fiscal.

Sua tarefa é escrever um relatório de gargalos operacionais, olhando especificamente:
1. TEMPO DE RESPOSTA PRO PIX/PAGAMENTO: toda vez que um cliente pediu chave PIX, boleto ou dados de pagamento, calcule quanto tempo a equipe demorou pra responder (os horários de cada mensagem estão marcados entre colchetes). Aponte os casos mais demorados, citando o nome do cliente e o tempo.
2. NEGOCIAÇÕES/ACORDOS TRAVADOS: cobranças ou negociações que ficaram paradas, sem fechamento, ou que o cliente ficou esperando retorno.
3. PONTOS FRACOS DE NEGOCIAÇÃO: qualquer padrão que pareça atrapalhar o fechamento (resposta confusa, falta de firmeza na cobrança, informação incompleta).

Escreva em português, texto simples corrido (SEM markdown, SEM asteriscos, SEM #), organizado em 3 blocos com esses títulos exatos em maiúsculo seguidos de dois-pontos: "TEMPO DE RESPOSTA:", "NEGOCIAÇÕES TRAVADAS:" e "PONTOS FRACOS:". Dentro de cada bloco, liste os casos encontrados citando o nome do cliente, um por linha começando com "- ". Se não achar nada relevante num bloco, escreva "Nada digno de nota hoje." nele. Seja direto, específico e cite tempos/nomes reais — não invente conversa que não está no material.`;

  const userMsg = conversas
    .map(({ lead, mensagens }) => `=== Conversa com ${lead.nome_cliente || lead.telefone} ===\n${formatarTranscricaoComHorario(mensagens)}`)
    .join('\n\n');

  return chamarClaude(system, userMsg, 1200);
}

// Análise SOB MEDIDA (sob demanda) — pedido da gestão. Em vez de rodar a
// análise fixa, a gestora escreve uma instrução livre (ex: "por que os
// clientes não estão fechando essa semana", "quanto de desconto os
// vendedores estão dando nos pedidos") e a IA lê TODAS as conversas
// fornecidas (ativas e encerradas) respondendo especificamente àquilo.
// Só leitura — não decide resultado, não cria tarefa, não grava nada.
// Texto corrido, sem markdown, pra caber bem na tela e ser copiável.
async function analisarPersonalizado(conversas, instrucao) {
  if (!configurado) return { erro: 'IA não configurada (falta ANTHROPIC_API_KEY no servidor).' };
  if (!conversas || conversas.length === 0) return { erro: 'nenhuma conversa com mensagens pra analisar nesse setor.' };
  if (!instrucao || !String(instrucao).trim()) return { erro: 'escreva o que você quer que a IA analise.' };

  const system = `Você é um analista de atendimento do Depósito Santo Antônio, uma loja de material de construção. Vai receber uma INSTRUÇÃO da gestão e, em seguida, TODAS as conversas de WhatsApp de um setor (ativas e encerradas), com o horário de cada mensagem entre colchetes.

Sua tarefa é responder EXATAMENTE à instrução da gestão, baseando-se SOMENTE no que está escrito nas conversas. Seja específico e concreto: cite nomes de clientes, valores, descontos, tempos de resposta e trechos reais sempre que ajudarem a sustentar o que você afirma. Nunca invente conversa, número ou fato que não esteja no material. Se a instrução pedir algo que as conversas não permitem responder, diga isso com honestidade em vez de inventar.

Escreva em português, texto corrido e organizado, SEM markdown (sem #, sem asteriscos de negrito, sem tabela). Pode usar títulos curtos em MAIÚSCULO seguidos de dois-pontos, e listar casos começando a linha com "- ". Comece com um resumo direto de 1 a 2 frases respondendo à pergunta e, depois, detalhe com os casos e evidências que você encontrou.

Priorize os casos MAIS relevantes e agrupe por tema, em vez de listar exaustivamente toda conversa — vale mais um relatório completo e bem concluído do que uma lista longa cortada no meio. SEMPRE termine o raciocínio: não deixe frase nem tópico pela metade, e feche com uma conclusão curta.`;

  const transcricao = (mensagens) => mensagens
    .map((m) => {
      const bruto = m.criado_em || '';
      const hora = new Date(bruto + (bruto.includes('Z') ? '' : 'Z'))
        .toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const quem = m.remetente === 'cliente' ? 'Cliente' : m.remetente === 'ia' ? 'IA' : 'Equipe';
      const texto = m.apagada ? '[mensagem apagada]' : m.texto;
      return `[${hora}] ${quem}: ${texto}`;
    })
    .join('\n');

  const userMsg = `INSTRUÇÃO DA GESTÃO:\n${String(instrucao).trim()}\n\n===== CONVERSAS DO SETOR (${conversas.length}) =====\n\n` +
    conversas
      .map(({ lead, mensagens }) => {
        const situacao = lead.status === 'encerrado' ? 'encerrada' : 'ativa';
        return `=== Conversa com ${lead.nome_cliente || lead.telefone} (${situacao}) ===\n${transcricao(mensagens)}`;
      })
      .join('\n\n');

  // 8000 tokens de folga: espaço pro modelo "pensar" no pedido pesado E
  // ainda escrever o relatório completo (o "sem texto" acontecia quando os
  // 4000 acabavam antes de sair o texto). Duas redes de segurança:
  //  - se vier VAZIO (gastou o orçamento pensando), tenta de novo — cobre a
  //    variação de um pedido pro outro (às vezes passa, às vezes não).
  //  - se o modelo RECUSAR 8000 (cap de saída menor), cai pro 4000 que já
  //    sabemos que passa, em vez de falhar.
  let r = await chamarClaudeComMotivo(system, userMsg, 8000);
  if (r.semTexto) {
    r = await chamarClaudeComMotivo(system, userMsg, 8000);
  } else if (!r.texto && /max_tokens/i.test(r.erro || '')) {
    r = await chamarClaudeComMotivo(system, userMsg, 4000);
  }
  if (!r.texto) return { erro: r.erro || 'a IA não conseguiu gerar a análise agora — tenta de novo em instantes.' };
  return { conteudo: r.texto };
}

// ---------------------------------------------------------------
// CURADORIA DE QUALIDADE DE ATENDIMENTO (por vendedor)
// ---------------------------------------------------------------
// Prompt fixo de análise de qualidade: mede tempo de resposta, tempo até
// orçamento/proposta e encaminhamento comercial (link de pagamento / PIX),
// e devolve DUAS partes: (1) texto pra leitura humana e (2) um bloco JSON
// estruturado entre marcadores, que a gente extrai e guarda pra alimentar o
// dashboard externo sem precisar garimpar texto.
//
// O bloco JSON é IDÊNTICO nos dois setores (mesmas chaves) — só muda o
// vocabulário da parte de leitura humana: no Financeiro "orçamento" vira
// "proposta/negociação de cobrança" e "motivos" viram "objeções de cobrança".

const BLOCO_JSON_QUALIDADE = `PARTE 2 — Bloco de dados entre os marcadores exatos abaixo, em JSON válido:
<<<METRICAS_JSON>>>
{
  "periodo": {"de":"YYYY-MM-DD","ate":"YYYY-MM-DD"},
  "resumo": {
    "conversas_analisadas": 0,
    "tempo_resposta_medio_min": 0,
    "tempo_ate_orcamento_medio_min": 0,
    "pct_enviou_link_pagamento": 0,
    "pct_enviou_pix": 0
  },
  "por_vendedor": [
    {"vendedor":"Nome","conversas":0,"tempo_resposta_medio_min":0,
     "tempo_ate_orcamento_medio_min":0,"enviou_link_pct":0,"enviou_pix_pct":0,
     "atendimentos_com_atraso":0}
  ],
  "rankings": {
    "resposta_mais_lenta":  [{"vendedor":"Nome","tempo_min":0}],
    "orcamento_mais_lento": [{"vendedor":"Nome","tempo_min":0}],
    "menos_envia_link":     [{"vendedor":"Nome","pct":0}],
    "menos_envia_pix":      [{"vendedor":"Nome","pct":0}]
  },
  "motivos": [ {"motivo":"texto curto","qtd":0} ],
  "alertas": [ {"vendedor":"Nome","situacao":"cliente aguardando orçamento há X"} ]
}
<<<FIM_METRICAS>>>`;

const PROMPT_QUALIDADE_VENDAS = `Você é um analista de qualidade de atendimento. Analise as conversas de WhatsApp do período e produza um relatório de DESEMPENHO POR VENDEDOR, focado em tempo e no encaminhamento comercial.
Regras:
- Use os horários das mensagens. "Tempo de resposta" = intervalo entre a mensagem do CLIENTE e a próxima resposta do VENDEDOR.
- "Tempo até orçamento" = do interesse do cliente até o vendedor enviar o orçamento/proposta.
- Detecte no texto/anexos se o vendedor enviou ORÇAMENTO, LINK DE PAGAMENTO e PIX (chave ou QR), e quando.
- Limites (SLA): resposta ideal até 5 min; orçamento ideal até 20 min. Acima disso conte como "atraso".
- Cada conversa traz o "Atendente responsável" no cabeçalho — atribua as métricas por vendedor usando esse nome. Nunca invente um nome que não esteja no material.
- Se algo não puder ser calculado, escreva "indisponível". NUNCA invente.
Entregue DUAS partes:
PARTE 1 — Relatório em texto (leitura humana): resumo, quem vai bem, quem está travando (respondendo devagar, demorando no orçamento, não mandando link/pix) e recomendações.
${BLOCO_JSON_QUALIDADE}`;

const PROMPT_QUALIDADE_FINANCEIRO = `Você é um analista de qualidade de atendimento do setor Financeiro (cobrança e negociação de pagamentos). Analise as conversas de WhatsApp do período e produza um relatório de DESEMPENHO POR ATENDENTE, focado em tempo e no encaminhamento da negociação de cobrança.
Regras:
- Use os horários das mensagens. "Tempo de resposta" = intervalo entre a mensagem do CLIENTE e a próxima resposta do ATENDENTE.
- "Tempo até proposta" = do momento em que a cobrança/negociação começa até o atendente enviar a proposta/negociação de cobrança (boleto, acordo, condições).
- Detecte no texto/anexos se o atendente enviou PROPOSTA/COBRANÇA, LINK DE PAGAMENTO e PIX (chave ou QR), e quando.
- Limites (SLA): resposta ideal até 5 min; proposta de cobrança ideal até 20 min. Acima disso conte como "atraso".
- Cada conversa traz o "Atendente responsável" no cabeçalho — atribua as métricas por atendente usando esse nome. Nunca invente um nome que não esteja no material.
- Em "motivos", liste as OBJEÇÕES DE COBRANÇA mais comuns (por que o cliente não fecha o acordo/pagamento).
- Se algo não puder ser calculado, escreva "indisponível". NUNCA invente.
Entregue DUAS partes:
PARTE 1 — Relatório em texto (leitura humana): resumo, quem vai bem, quem está travando (respondendo devagar, demorando na proposta de cobrança, não mandando link/pix) e recomendações.
${BLOCO_JSON_QUALIDADE}`;

// Separa o texto humano (PARTE 1) do bloco de métricas (PARTE 2). Devolve o
// conteudo já SEM os marcadores (pra não vazar na tela) e as métricas já
// parseadas (ou null se o modelo não produziu / veio inválido).
function extrairMetricas(texto) {
  if (!texto) return { conteudo: '', metricas: null };
  const re = /<<<METRICAS_JSON>>>([\s\S]*?)<<<FIM_METRICAS>>>/;
  const m = texto.match(re);
  let metricas = null;
  if (m) {
    try { metricas = JSON.parse(m[1].replace(/```json|```/g, '').trim()); } catch { metricas = null; }
  }
  // Remove o bloco inteiro (fechado). Se por acaso veio só o marcador de
  // abertura sem o de fechamento, corta dali pra frente também.
  let conteudo = texto.replace(re, '').replace(/<<<METRICAS_JSON>>>[\s\S]*$/, '');
  conteudo = conteudo.replace(/PARTE\s*2\s*—.*$/is, '').trim();
  return { conteudo: conteudo.trim(), metricas };
}

// Descobre o intervalo de datas (YYYY-MM-DD) coberto pelas conversas, pra
// preencher "periodo" no material e ajudar o modelo a datar o relatório.
function calcularPeriodoConversas(conversas) {
  let min = null, max = null;
  for (const { mensagens } of conversas) {
    for (const msg of mensagens) {
      const bruto = msg.criado_em || '';
      if (!bruto) continue;
      const dia = bruto.slice(0, 10);
      if (!min || dia < min) min = dia;
      if (!max || dia > max) max = dia;
    }
  }
  const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { de: min || hoje, ate: max || hoje };
}

function transcricaoQualidade(mensagens) {
  return mensagens
    .map((m) => {
      const bruto = m.criado_em || '';
      const hora = new Date(bruto + (bruto.includes('Z') ? '' : 'Z'))
        .toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const quem = m.remetente === 'cliente' ? 'Cliente' : m.remetente === 'ia' ? 'IA' : 'Atendente';
      let texto = m.apagada ? '[mensagem apagada]' : (m.texto || '');
      // Anexos ajudam a detectar orçamento/boleto/link — sinaliza o tipo.
      if (m.midia_tipo) texto = (texto ? texto + ' ' : '') + `[anexo: ${m.midia_tipo}${m.midia_nome ? ' ' + m.midia_nome : ''}]`;
      return `[${hora}] ${quem}: ${texto}`;
    })
    .join('\n');
}

// Gera a curadoria de qualidade (por vendedor). conversas: [{lead, mensagens}],
// onde lead.vendedor_nome traz o nome do atendente responsável (resolvido por
// quem chama). opts: { setor, instrucao?, periodo? }.
// Retorna { conteudo, metricas, periodo } ou { erro }.
async function analisarQualidade(conversas, opts = {}) {
  const setor = (opts.setor || 'vendas').toLowerCase();
  if (!configurado) return { erro: 'IA não configurada (falta ANTHROPIC_API_KEY no servidor).' };
  if (!conversas || conversas.length === 0) return { erro: 'nenhuma conversa com mensagens pra analisar nesse setor.' };

  const system = setor === 'financeiro' ? PROMPT_QUALIDADE_FINANCEIRO : PROMPT_QUALIDADE_VENDAS;
  const periodo = opts.periodo || calcularPeriodoConversas(conversas);
  const foco = opts.instrucao && String(opts.instrucao).trim()
    ? `\n\nFOCO ADICIONAL PEDIDO PELA GESTÃO (dê ênfase a isto na PARTE 1, mas SEM deixar de preencher a PARTE 2 completa): ${String(opts.instrucao).trim()}`
    : '';

  const userMsg = `Período analisado: de ${periodo.de} até ${periodo.ate}.${foco}\n\n===== CONVERSAS DO SETOR (${conversas.length}) =====\n\n` +
    conversas
      .map(({ lead, mensagens }) => {
        const dono = lead.vendedor_nome || 'sem atendente definido';
        const situacao = lead.status === 'encerrado' ? 'encerrada' : 'ativa';
        return `=== Conversa com ${lead.nome_cliente || lead.telefone} (${situacao}; Atendente responsável: ${dono}) ===\n${transcricaoQualidade(mensagens)}`;
      })
      .join('\n\n');

  // Precisa de espaço pra escrever o texto E o JSON — orçamento generoso, com
  // as mesmas redes de segurança da análise sob medida (retry / cai pra 4000).
  let r = await chamarClaudeComMotivo(system, userMsg, 6000);
  if (r.semTexto) {
    r = await chamarClaudeComMotivo(system, userMsg, 6000);
  } else if (!r.texto && /max_tokens/i.test(r.erro || '')) {
    r = await chamarClaudeComMotivo(system, userMsg, 4000);
  }
  if (!r.texto) return { erro: r.erro || 'a IA não conseguiu gerar a análise agora — tenta de novo em instantes.' };

  const { conteudo, metricas } = extrairMetricas(r.texto);
  return { conteudo: conteudo || r.texto, metricas, periodo };
}

module.exports = { processarNovaMensagem, analisarConversa, sugerirTarefa, analisarDiaria, analisarFinanceiroDiario, analisarPersonalizado, analisarQualidade, configurado };
