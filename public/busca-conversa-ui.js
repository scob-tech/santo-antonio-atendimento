// busca-conversa-ui.js
// ---------------------------------------------------------------------------
// Pesquisa DENTRO da conversa aberta, igual ao WhatsApp Desktop: lupa no
// cabeçalho abre uma barra, a busca roda enquanto digita, destaca em amarelo
// e as setas navegam entre as ocorrências (com scroll automático).
//
// Tudo no navegador, em cima das mensagens que já estão na tela — nenhuma
// rota nova. Só procura no TEXTO dos balões (cliente, equipe e IA); imagens,
// áudios, vídeos, documentos e citações ficam de fora. Ignora maiúsculas e
// acentos ("orcamento" acha "Orçamento").
// ---------------------------------------------------------------------------

const buscaConversa = {
  aberta: false,
  leadId: null,
  termo: '',
  ocorrencias: [], // <mark> na ordem da conversa (mais antiga -> mais recente)
  atual: -1,
  timer: null,
};

function buscaConversaAtiva() {
  return buscaConversa.aberta && buscaConversa.termo.trim().length > 0;
}

function abrirBuscaConversa() {
  const barra = document.getElementById('conversa-busca');
  if (!barra) return;
  buscaConversa.aberta = true;
  buscaConversa.leadId = leadConversaAtual ? leadConversaAtual.id : null;
  barra.hidden = false;
  document.getElementById('btn-busca-conversa').classList.add('is-active');
  const campo = document.getElementById('conversa-busca-campo');
  campo.focus();
  campo.select();
  if (campo.value.trim()) aplicarBuscaConversa({ manterPosicao: true });
  else atualizarContadorBusca();
}

function fecharBuscaConversa() {
  const barra = document.getElementById('conversa-busca');
  if (!barra) return;
  const estavaBuscando = buscaConversaAtiva();
  clearTimeout(buscaConversa.timer);
  buscaConversa.aberta = false;
  buscaConversa.termo = '';
  buscaConversa.leadId = null;
  barra.hidden = true;
  document.getElementById('conversa-busca-campo').value = '';
  document.getElementById('btn-busca-conversa').classList.remove('is-active');
  limparDestaquesBusca();
  // Volta pro fim da conversa, onde a pessoa estava antes de pesquisar.
  const msgsEl = document.getElementById('conversa-mensagens');
  if (estavaBuscando && msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

function alternarBuscaConversa() {
  if (buscaConversa.aberta) fecharBuscaConversa();
  else abrirBuscaConversa();
}

// Digitação: busca em tempo real, com um respiro curto pra não refazer a
// cada tecla em conversas longas.
function aoDigitarBuscaConversa() {
  clearTimeout(buscaConversa.timer);
  buscaConversa.timer = setTimeout(() => aplicarBuscaConversa({ manterPosicao: false }), 120);
}

function teclaBuscaConversa(e) {
  if (e.key === 'Escape') { e.preventDefault(); fecharBuscaConversa(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(buscaConversa.timer);
    if (buscaConversa.termo !== e.target.value) aplicarBuscaConversa({ manterPosicao: false });
    // Enter sobe pra ocorrência mais antiga (igual ao WhatsApp); Shift+Enter desce.
    else navegarBuscaConversa(e.shiftKey ? 1 : -1);
  }
}

// Minúsculas e sem acento, guardando de qual posição do texto original veio
// cada caractere — pra marcar o trecho certo mesmo com acentos no meio.
function normalizarComMapa(texto) {
  let normal = '';
  const mapa = [];
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let j = 0; j < c.length; j++) { normal += c[j]; mapa.push(i); }
  }
  return { normal, mapa };
}

function limparDestaquesBusca() {
  const msgsEl = document.getElementById('conversa-mensagens');
  if (!msgsEl) return;
  const pais = new Set();
  msgsEl.querySelectorAll('mark.busca-hit').forEach((mark) => {
    pais.add(mark.parentNode);
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  pais.forEach((p) => p && p.normalize());
  buscaConversa.ocorrencias = [];
  buscaConversa.atual = -1;
}

// Só o texto dos balões: sem citação, sem mídia, sem mensagem apagada.
function textosPesquisaveis(msgsEl) {
  const nos = [];
  msgsEl.querySelectorAll('.balao:not(.balao--midia):not(.balao-apagada) .balao-texto').forEach((el) => {
    const andador = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let no;
    while ((no = andador.nextNode())) if (no.nodeValue.trim()) nos.push(no);
  });
  return nos;
}

function aplicarBuscaConversa({ manterPosicao }) {
  const msgsEl = document.getElementById('conversa-mensagens');
  const campo = document.getElementById('conversa-busca-campo');
  if (!msgsEl || !campo) return;
  const indiceAnterior = buscaConversa.atual;
  limparDestaquesBusca();
  buscaConversa.termo = campo.value;
  const alvo = normalizarComMapa(campo.value.trim()).normal;
  if (!alvo) { atualizarContadorBusca(); return; }

  textosPesquisaveis(msgsEl).forEach((no) => {
    const texto = no.nodeValue;
    const { normal, mapa } = normalizarComMapa(texto);
    const trechos = [];
    let pos = normal.indexOf(alvo);
    while (pos !== -1) {
      const ini = mapa[pos];
      const fim = mapa[pos + alvo.length - 1] + 1;
      trechos.push([ini, fim]);
      pos = normal.indexOf(alvo, pos + alvo.length);
    }
    if (!trechos.length) return;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    trechos.forEach(([ini, fim]) => {
      if (ini > cursor) frag.appendChild(document.createTextNode(texto.slice(cursor, ini)));
      const mark = document.createElement('mark');
      mark.className = 'busca-hit';
      mark.textContent = texto.slice(ini, fim);
      frag.appendChild(mark);
      buscaConversa.ocorrencias.push(mark);
      cursor = fim;
    });
    if (cursor < texto.length) frag.appendChild(document.createTextNode(texto.slice(cursor)));
    no.replaceWith(frag);
  });

  const total = buscaConversa.ocorrencias.length;
  if (!total) { atualizarContadorBusca(); return; }
  // Busca nova começa na ocorrência mais recente (lá embaixo), como no
  // WhatsApp. Num redesenho (chegou mensagem) fica onde a pessoa estava.
  const inicio = manterPosicao && indiceAnterior >= 0 ? Math.min(indiceAnterior, total - 1) : total - 1;
  selecionarOcorrenciaBusca(inicio, { rolar: !manterPosicao || indiceAnterior < 0 });
}

function selecionarOcorrenciaBusca(indice, { rolar = true } = {}) {
  const lista = buscaConversa.ocorrencias;
  if (!lista.length) return;
  const anterior = lista[buscaConversa.atual];
  if (anterior) anterior.classList.remove('is-atual');
  buscaConversa.atual = (indice + lista.length) % lista.length;
  const mark = lista[buscaConversa.atual];
  mark.classList.add('is-atual');
  atualizarContadorBusca();
  if (rolar) rolarAteOcorrencia(mark);
}

// Centraliza a ocorrência só dentro da área de mensagens (sem mexer no
// scroll da página inteira, que no celular fazia o cabeçalho sumir).
function rolarAteOcorrencia(mark) {
  const msgsEl = document.getElementById('conversa-mensagens');
  if (!msgsEl || !mark) return;
  const caixa = msgsEl.getBoundingClientRect();
  const alvo = mark.getBoundingClientRect();
  const destino = msgsEl.scrollTop + (alvo.top - caixa.top) - (msgsEl.clientHeight / 2) + (alvo.height / 2);
  msgsEl.scrollTo({ top: Math.max(0, destino), behavior: 'smooth' });
}

// direcao: -1 = mais antiga (seta pra cima), +1 = mais recente (seta pra baixo)
function navegarBuscaConversa(direcao) {
  if (!buscaConversa.ocorrencias.length) return;
  selecionarOcorrenciaBusca(buscaConversa.atual + direcao);
}

function atualizarContadorBusca() {
  const cont = document.getElementById('conversa-busca-contador');
  const total = buscaConversa.ocorrencias.length;
  const temTermo = buscaConversa.termo.trim().length > 0;
  if (cont) {
    cont.textContent = !temTermo ? ''
      : !total ? 'Nenhum resultado'
        : `${buscaConversa.atual + 1} de ${total} ${total === 1 ? 'resultado' : 'resultados'}`;
    cont.classList.toggle('is-vazio', temTermo && !total);
  }
  ['conversa-busca-anterior', 'conversa-busca-proximo'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = total === 0;
  });
}

// Chamado pelo renderizarConversa (app.js) depois de redesenhar as
// mensagens: trocou de conversa -> fecha a busca; mesma conversa (chegou
// mensagem nova) -> refaz os destaques sem perder a posição.
function reaplicarBuscaConversa() {
  if (!buscaConversa.aberta) return;
  if (!leadConversaAtual || leadConversaAtual.id !== buscaConversa.leadId) { fecharBuscaConversa(); return; }
  if (buscaConversaAtiva()) aplicarBuscaConversa({ manterPosicao: true });
}
