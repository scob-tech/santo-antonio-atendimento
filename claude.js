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

module.exports = { processarNovaMensagem, analisarConversa, sugerirTarefa, analisarDiaria, analisarFinanceiroDiario, analisarPersonalizado, configurado };
