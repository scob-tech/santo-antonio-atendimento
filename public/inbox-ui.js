// inbox-ui.js
// Comportamento SÓ DE INTERFACE da Central de Atendimento (Tela Inicial).
// Nada aqui chama API, muda regra ou mexe no polling: só lê o que o app.js
// já carregou (leadsCache, conversasAtivasCache, leadConversaAtual) e ajusta
// o que aparece na tela — indicadores, item selecionado, menus e filtros.
// Carregado ANTES do app.js; as funções só são chamadas depois que tudo subiu.

// ---------------- Indicadores compactos (KPIs) ----------------
function definirTextoSeMudou(id, valor) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(valor)) el.textContent = valor;
}

function atualizarIndicadoresInicio() {
  // Durante uma busca, conversasAtivasCache guarda o RESULTADO da busca —
  // não é o retrato da fila, então os números ficam como estavam.
  const busca = document.getElementById('busca-conversas');
  const buscando = busca && busca.value.trim().length >= 2;

  // A tela Clientes cruza os contatos com essas mesmas conversas.
  if (document.body.dataset.view === 'clientes') atualizarClientesComConversas();

  const leads = Array.isArray(leadsCache) ? leadsCache : [];
  definirTextoSeMudou('kpi-novos', leads.length);
  const contLeads = document.getElementById('leads-count');
  if (contLeads) contLeads.classList.toggle('ui-badge--red', leads.length > 0);

  if (buscando) return;
  const ativas = Array.isArray(conversasAtivasCache) ? conversasAtivasCache : [];
  definirTextoSeMudou('kpi-andamento', ativas.length);
  definirTextoSeMudou('kpi-nao-lidas', ativas.reduce((soma, l) => soma + (l.nao_lidas || 0), 0));
  definirTextoSeMudou('kpi-aguardando', ativas.filter((l) => precisaResposta(l)).length);
}

function atualizarKpiTarefas(quantidade) {
  definirTextoSeMudou('kpi-tarefas', quantidade);
}

function irParaSecaoInbox(secao) {
  if (document.body.dataset.view !== 'inicio') mudarView('inicio');
  const scroll = document.getElementById('inbox-list-scroll');
  const alvo = document.getElementById(secao === 'leads' ? 'inbox-secao-leads' : 'inbox-secao-conversas');
  if (scroll && alvo) scroll.scrollTo({ top: alvo.offsetTop - scroll.offsetTop, behavior: 'smooth' });
}

// ---------------- Prévia da última mensagem na fila ----------------
// "[Áudio]", "[Imagem]"... viram ícone + rótulo limpo (só na exibição).
const PREVIA_MIDIA = {
  'Áudio': ['mic', 'Áudio'], 'Imagem': ['camera', 'Foto'], 'Vídeo': ['camera', 'Vídeo'],
  'Documento': ['file-text', 'Documento'], 'Sticker': ['sticker', 'Figurinha'], 'Contato': ['user', 'Contato'],
};
function previewComIcone(texto) {
  const bruto = String(texto || '');
  const m = bruto.match(/^\[(Áudio|Imagem|Vídeo|Documento|Sticker|Contato)\]\s*(.*)$/s);
  if (!m) return escapeHtml(bruto);
  const [nomeIcone, rotulo] = PREVIA_MIDIA[m[1]];
  const resto = m[2] ? ` ${escapeHtml(m[2])}` : '';
  return `<span class="previa-midia">${icone(nomeIcone, 13)}${rotulo}</span>${resto}`;
}

// ---------------- Conversa aberta x item da lista ----------------
function marcarItemSelecionado() {
  const painel = document.getElementById('modal-conversa');
  const aberto = painel && painel.classList.contains('aberto');
  const idAtual = aberto && leadConversaAtual ? String(leadConversaAtual.id) : null;
  document.querySelectorAll('#leads [data-id], #conversas-ativas [data-id], #historico-lista [data-id]').forEach((li) => {
    li.classList.toggle('is-selected', li.dataset.id === idAtual);
  });
}

// Chamado pelo abrirModal/fecharModal quando o alvo é a conversa.
function aoMudarConversaAberta() {
  const painel = document.getElementById('modal-conversa');
  const aberto = painel && painel.classList.contains('aberto');
  document.body.classList.toggle('chat-aberto', !!aberto);
  // A conversa mora na Central de Atendimento (ou no Histórico, que tem o
  // mesmo painel): se for aberta de outra tela (Agenda, Clientes), leva até lá.
  const view = document.body.dataset.view;
  if (aberto && view !== 'inicio' && view !== 'historico') mudarView('inicio');
  fecharMenuConversa();
  marcarItemSelecionado();
}

// ---------------- Filtro local de leads (mesma caixa de busca) ----------------
let termoFiltroLeads = '';
function filtrarLeadsNaLista(termo) {
  termoFiltroLeads = (termo || '').trim().toLowerCase();
  aplicarFiltroLeads();
}
function aplicarFiltroLeads() {
  const termo = termoFiltroLeads;
  const digitos = termo.replace(/\D/g, '');
  const lista = Array.isArray(leadsCache) ? leadsCache : [];
  document.querySelectorAll('#leads .lead-item').forEach((li) => {
    if (termo.length < 2) { li.style.display = ''; return; }
    const l = lista.find((x) => String(x.id) === li.dataset.id);
    if (!l) { li.style.display = ''; return; }
    const nome = (l.nome_cliente || '').toLowerCase();
    const tel = String(l.telefone || '');
    const bate = nome.includes(termo) || (digitos.length >= 2 && tel.includes(digitos));
    li.style.display = bate ? '' : 'none';
  });
}

// ---------------- Menu "mais ações" da conversa ----------------
function alternarMenuConversa(evento) {
  if (evento) evento.stopPropagation();
  const menu = document.getElementById('chat-menu');
  if (menu) menu.classList.toggle('is-open');
}
function fecharMenuConversa() {
  const menu = document.getElementById('chat-menu');
  if (menu) menu.classList.remove('is-open');
}

// Os itens do menu seguem exatamente a visibilidade que o app.js já decide:
// "Não lida" e "Sugerir tarefa" acompanham os botões de ação do cabeçalho
// (só quem pode agir, conversa não encerrada); "Excluir lead" acompanha o
// próprio botão (só admin).
function sincronizarMenuConversa() {
  const acoes = document.getElementById('conversa-header-acoes');
  const excluir = document.getElementById('btn-excluir-lead');
  const menu = document.getElementById('chat-menu');
  if (!acoes || !menu) return;
  const podeAgir = acoes.style.display !== 'none';
  const podeExcluir = excluir && excluir.style.display !== 'none';
  menu.querySelectorAll('[data-acao-dono]').forEach((b) => { b.style.display = podeAgir ? '' : 'none'; });
  const sep = document.getElementById('chat-menu-sep');
  if (sep) sep.style.display = podeAgir && podeExcluir ? '' : 'none';
  menu.style.display = podeAgir || podeExcluir ? '' : 'none';
}

// "Criar tarefa" dentro da conversa: abre o mesmo modal da Agenda, já com
// este lead escolhido (quando ele está entre os leads permitidos).
function abrirTarefaDaConversa() {
  if (!leadConversaAtual) return;
  abrirNovaTarefa();
  const sel = document.getElementById('tarefa-lead');
  const id = String(leadConversaAtual.id);
  if (sel && [...sel.options].some((o) => o.value === id)) sel.value = id;
}

// ---------------- Análise sob medida (popover) ----------------
function alternarAnaliseSobMedida(evento) {
  if (evento) evento.stopPropagation();
  const el = document.getElementById('painel-analise-custom');
  if (!el) return;
  el.classList.toggle('is-open');
  if (el.classList.contains('is-open')) {
    const campo = document.getElementById('analise-custom-prompt');
    if (campo) setTimeout(() => campo.focus(), 30);
  }
}

// ---------------- Fechar popovers ao clicar fora / Esc ----------------
document.addEventListener('click', (e) => {
  if (!e.target.closest('#chat-menu')) fecharMenuConversa();
  const analise = document.getElementById('painel-analise-custom');
  if (analise && !e.target.closest('#painel-analise-custom')) analise.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  fecharMenuConversa();
  const analise = document.getElementById('painel-analise-custom');
  if (analise) analise.classList.remove('is-open');
});

// ---------------- Observadores (só visuais) ----------------
// As listas são repintadas pelo app.js quando algo muda; depois de cada
// repintura, reaplica o item selecionado e o filtro de leads.
(function observarInbox() {
  const aoMudarLista = () => { marcarItemSelecionado(); aplicarFiltroLeads(); };
  ['leads', 'conversas-ativas'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) new MutationObserver(aoMudarLista).observe(el, { childList: true });
  });
  const acoes = document.getElementById('conversa-header-acoes');
  const excluir = document.getElementById('btn-excluir-lead');
  const obsMenu = new MutationObserver(sincronizarMenuConversa);
  if (acoes) obsMenu.observe(acoes, { attributes: true, attributeFilter: ['style'] });
  if (excluir) obsMenu.observe(excluir, { attributes: true, attributeFilter: ['style'] });
  sincronizarMenuConversa();
})();
