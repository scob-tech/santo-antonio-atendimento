// ai.js
// Por enquanto isso é um "stub" (simulação) da IA, pra gente testar o
// fluxo todo sem precisar de chave de API ainda. Quando você tiver uma
// API key da Anthropic, eu troco o miolo dessas funções pra chamar o
// modelo de verdade (mesma assinatura, o resto do app não muda).

function gerarMensagemBoasVindas(primeiraMensagem, nomeCliente, statusHorario) {
  const nome = nomeCliente || 'tudo bem';
  if (statusHorario && !statusHorario.aberto) {
    return `Olá, ${nome}! Recebemos sua mensagem — no momento estamos fora do horário de atendimento, mas já anotamos o que você precisa. Um vendedor vai falar com você assim que abrirmos, ${statusHorario.proxima_abertura_texto}. Pode ir passando mais detalhes enquanto isso 🙂`;
  }
  return `Olá, ${nome}! Recebemos sua mensagem e já já um de nossos vendedores vai te atender. Enquanto isso, pode ir passando mais detalhes do que você precisa 🙂`;
}

function sugerirRespostaVendedor(historicoMensagens) {
  // No futuro: manda o histórico pra IA e pede uma sugestão de resposta
  // baseada no que o cliente perguntou.
  return 'Sugestão de resposta ainda não implementada (fase 2).';
}

function identificarOportunidade(primeiraMensagem) {
  // Regra simples por enquanto: detecta palavras-chave de produtos.
  const texto = primeiraMensagem.toLowerCase();
  const produtos = ['cimento', 'areia', 'brita', 'bloco', 'tijolo', 'cal'];
  const encontrados = produtos.filter((p) => texto.includes(p));
  return encontrados;
}

module.exports = {
  gerarMensagemBoasVindas,
  sugerirRespostaVendedor,
  identificarOportunidade,
};
