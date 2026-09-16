// clientes-ui.js
// Apresentação da tela Clientes (Etapa 3). SÓ INTERFACE: recebe os contatos
// que o carregarContatos() do app.js buscou em /api/contatos e cruza, pelo
// telefone, com as conversas que a tela já mantém em memória (leadsCache =
// fila de novos; conversasRecentesCache = em atendimento + encerradas
// recentes). Nenhuma chamada nova à API.
// Ações usadas: abrirConversaPorTelefone(), abrirEditarContato() e
// abrirNovoLeadManual() — as mesmas de antes.

const LIMITE_LISTA_CONTATOS = 200; // o GET /api/contatos sem busca devolve no máximo 200

const estadoClientes = {
  base: [],        // última lista SEM busca (base dos indicadores)
  lista: [],       // última lista exibida (com ou sem busca)
  termo: '',
  assinatura: '',
  detalheId: null,
  htmlDetalhe: '',
  htmlAcoes: '',
  respsAssinatura: '',
};

// ---------------- Telefone ----------------
function digitosTelefone(tel) {
  return String(tel || '').replace(/\D/g, '');
}
// Chave de comparação: DDD + últimos 8 dígitos (ignora o 55 e o nono dígito).
function chaveTelefone(tel) {
  let d = digitosTelefone(tel);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return d;
  return d.slice(0, 2) + d.slice(-8);
}
function formatarTelefone(tel) {
  let d = digitosTelefone(tel);
  let prefixo = '';
  if (d.length >= 12 && d.startsWith('55')) { prefixo = '+55 '; d = d.slice(2); }
  if (d.length === 11) return `${prefixo}(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${prefixo}(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel || '—';
}

// ---------------- Cruzamento contato x conversa ----------------
const PRIORIDADE_STATUS = { em_atendimento: 3, novo: 2, encerrado: 1 };
function mapaConversasPorTelefone() {
  const mapa = new Map();
  const todas = [...(conversasRecentesCache || []), ...(leadsCache || [])];
  todas.forEach((l) => {
    if (!l || !l.telefone) return;
    const chave = chaveTelefone(l.telefone);
    const atual = mapa.get(chave);
    const pesoNovo = PRIORIDADE_STATUS[l.status] || 0;
    const pesoAtual = atual ? PRIORIDADE_STATUS[atual.status] || 0 : -1;
    const maisRecente = atual && new Date(ultimaAtividade(l)) > new Date(ultimaAtividade(atual));
    if (!atual || pesoNovo > pesoAtual || (pesoNovo === pesoAtual && maisRecente)) mapa.set(chave, l);
  });
  return mapa;
}
function ultimaAtividade(l) {
  return `${(l.ultima_mensagem && l.ultima_mensagem.criado_em) || l.criado_em || ''}Z`;
}
function situacaoContato(conversa) {
  if (!conversa) return 'sem_atendimento';
  return conversa.status;
}
const SITUACAO_CONTATO_UI = {
  em_atendimento: { rotulo: 'Em atendimento', badge: 'ui-badge--brand ui-badge--dot' },
  novo: { rotulo: 'Aguardando', badge: 'ui-badge--orange ui-badge--dot' },
  encerrado: { rotulo: 'Encerrada', badge: 'ui-badge--dot' },
  sem_atendimento: { rotulo: 'Sem atendimento', badge: 'ui-badge--quiet' },
};

function inicioDaSemana() {
  const d = new Date();
  const dia = (d.getDay() + 6) % 7; // segunda = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dia);
  return d;
}
function dataContato(valor) {
  if (!valor) return null;
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(valor) ? valor : `${String(valor).replace(' ', 'T')}Z`);
  return isNaN(d) ? null : d;
}
function quandoCurto(d) {
  if (!d) return '';
  const agora = new Date();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const ontem = new Date(agora); ontem.setDate(agora.getDate() - 1);
  if (d.toDateString() === agora.toDateString()) return `Hoje, ${hora}`;
  if (d.toDateString() === ontem.toDateString()) return `Ontem, ${hora}`;
  const opcoes = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== agora.getFullYear()) opcoes.year = 'numeric';
  return `${d.toLocaleDateString('pt-BR', opcoes).replace('.', '')}, ${hora}`;
}
function nomeVendedor(id) {
  if (!id) return '';
  if (usuarioAtual && id === usuarioAtual.id) return 'Você';
  const v = (vendedoresCache || []).find((x) => x.id === id);
  return v ? v.nome : '';
}

// ---------------- Indicadores ----------------
function atualizarIndicadoresClientes(mapa) {
  const base = estadoClientes.base;
  const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== String(v)) el.textContent = v; };
  const chegouNoLimite = base.length >= LIMITE_LISTA_CONTATOS;
  set('clientes-kpi-total', chegouNoLimite ? `${LIMITE_LISTA_CONTATOS}+` : base.length);
  const situacoes = base.map((c) => situacaoContato(mapa.get(chaveTelefone(c.telefone))));
  set('clientes-kpi-ativas', situacoes.filter((s) => s === 'em_atendimento').length);
  set('clientes-kpi-sem', situacoes.filter((s) => s !== 'em_atendimento' && s !== 'novo').length);
  const segunda = inicioDaSemana();
  set('clientes-kpi-novos', base.filter((c) => { const d = dataContato(c.criado_em); return d && d >= segunda; }).length);
}

// ---------------- Filtros ----------------
function popularFiltroResponsaveis() {
  const sel = document.getElementById('clientes-filtro-resp');
  if (!sel) return;
  const vendedores = vendedoresCache || [];
  const assinatura = vendedores.map((v) => `${v.id}~${v.nome}`).join('|');
  if (assinatura === estadoClientes.respsAssinatura) return;
  estadoClientes.respsAssinatura = assinatura;
  const valor = sel.value;
  sel.innerHTML = `<option value="">Todos os responsáveis</option><option value="__sem">Sem responsável</option>`
    + vendedores.map((v) => `<option value="${v.id}">${escapeHtml(nomeVendedor(v.id) || v.nome)}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === valor) ? valor : '';
}

function filtrarClientesPorStatus(status) {
  const sel = document.getElementById('clientes-filtro-status');
  if (sel) sel.value = status;
  aplicarFiltrosClientes();
}

function aplicarFiltrosClientes() {
  estadoClientes.assinatura = '';
  desenharTabelaClientes();
}

// ---------------- Tabela ----------------
function renderizarClientes(contatos, termoBusca) {
  estadoClientes.lista = Array.isArray(contatos) ? contatos : [];
  estadoClientes.termo = termoBusca || '';
  if (!termoBusca) estadoClientes.base = estadoClientes.lista;
  estadoClientes.assinatura = '';
  desenharTabelaClientes();
}

// Chamado a cada atualização das conversas (polling já existente), só quando
// a tela Clientes está aberta — status/responsável/última conversa mudam.
function atualizarClientesComConversas() {
  if (!estadoClientes.lista.length && !estadoClientes.base.length) return;
  desenharTabelaClientes();
}

function linhaContatoHtml(c, conversa) {
  const s = situacaoContato(conversa);
  const ui = SITUACAO_CONTATO_UI[s] || SITUACAO_CONTATO_UI.sem_atendimento;
  const telFmt = formatarTelefone(c.telefone);
  const resp = conversa ? nomeVendedor(conversa.vendedor_id) : '';
  let ultimaHtml = '<span class="dt-muted">Nenhuma conversa recente</span>';
  if (conversa) {
    const texto = conversa.ultima_mensagem ? conversa.ultima_mensagem.texto : conversa.primeira_mensagem;
    const quando = dataContato(conversa.ultima_mensagem ? conversa.ultima_mensagem.criado_em : conversa.criado_em);
    const previa = String(texto || '').replace(/^\*(.+?):\*\n/, '$1: ');
    ultimaHtml = `<span class="dt-stack"><span class="dt-preview">${previewComIcone(previa)}</span><span class="dt-secondary">${quandoCurto(quando)}</span></span>`;
  }
  const selecionado = estadoClientes.detalheId === c.id ? 'is-selected' : '';
  return `
    <div class="dt-row ${selecionado}" role="row" data-id="${c.id}" tabindex="0"
      onclick="abrirDetalheContato(${c.id})" onkeydown="if(event.key==='Enter'){abrirDetalheContato(${c.id})}">
      <span class="cc-cliente" role="cell">
        <span class="dt-avatar" style="background:${corAvatar(c.id)};">${escapeHtml(iniciais(c.nome))}</span>
        <span class="dt-stack">
          <span class="dt-primary">${escapeHtml(c.nome)}</span>
          <span class="dt-secondary">${escapeHtml(telFmt)}</span>
        </span>
      </span>
      <span class="cc-telefone" role="cell"><span class="cell-text dt-num">${escapeHtml(telFmt)}</span></span>
      <span class="cc-ultima" role="cell">${ultimaHtml}</span>
      <span class="cc-resp" role="cell">${resp
        ? `<span class="mini-avatar" style="background:${corAvatar(conversa.vendedor_id || 0)};">${escapeHtml(iniciais(resp))}</span><span class="cell-text">${escapeHtml(resp)}</span>`
        : '<span class="dt-muted">—</span>'}</span>
      <span class="cc-status" role="cell"><span class="ui-badge ${ui.badge}">${ui.rotulo}</span></span>
      <span class="cc-acoes" role="cell">
        <button type="button" class="ui-icon-btn ui-icon-btn--sm dt-menu-btn" aria-haspopup="menu" aria-label="Ações de ${escapeHtml(c.nome)}"
          onclick="event.stopPropagation(); abrirMenuContato(event, ${c.id})">${icone('ellipsis', 18)}</button>
      </span>
    </div>`;
}

function desenharTabelaClientes() {
  const el = document.getElementById('contatos-lista');
  if (!el) return;
  popularFiltroResponsaveis();
  const mapa = mapaConversasPorTelefone();
  atualizarIndicadoresClientes(mapa);

  const filtroResp = (document.getElementById('clientes-filtro-resp') || {}).value || '';
  const filtroStatus = (document.getElementById('clientes-filtro-status') || {}).value || 'todos';
  const segunda = inicioDaSemana();

  const linhas = estadoClientes.lista.map((c) => ({ c, conversa: mapa.get(chaveTelefone(c.telefone)) || null }))
    .filter(({ c, conversa }) => {
      const s = situacaoContato(conversa);
      if (filtroStatus === 'novos_semana') { const d = dataContato(c.criado_em); if (!d || d < segunda) return false; }
      else if (filtroStatus === 'sem_atendimento') { if (s === 'em_atendimento' || s === 'novo') return false; }
      else if (filtroStatus !== 'todos' && s !== filtroStatus) return false;
      if (filtroResp === '__sem') return !(conversa && conversa.vendedor_id);
      if (filtroResp) return Boolean(conversa && String(conversa.vendedor_id) === filtroResp);
      return true;
    });

  const assinatura = [filtroResp, filtroStatus, estadoClientes.termo, estadoClientes.detalheId, estadoClientes.respsAssinatura,
    linhas.map(({ c, conversa }) => `${c.id}~${c.nome}~${c.telefone}~${conversa ? `${conversa.id}~${conversa.status}~${conversa.vendedor_id}~${ultimaAtividade(conversa)}` : ''}`).join('|')].join('#');

  if (assinatura !== estadoClientes.assinatura) {
    estadoClientes.assinatura = assinatura;
    if (!linhas.length) {
      const buscando = Boolean(estadoClientes.termo) || filtroResp || filtroStatus !== 'todos';
      el.innerHTML = buscando
        ? `<div class="task-empty">${icone('search', 22)}<strong>Nenhum cliente encontrado</strong><span>Ajuste a busca ou os filtros.</span></div>`
        : `<div class="task-empty">${icone('users', 22)}<strong>Nenhum contato salvo ainda</strong><span>Use "Salvar contato" numa conversa ou o botão Novo contato.</span></div>`;
    } else {
      el.innerHTML = linhas.map(({ c, conversa }) => linhaContatoHtml(c, conversa)).join('');
    }

    const rodape = document.getElementById('clientes-rodape');
    if (rodape) {
      const total = estadoClientes.lista.length;
      let texto = linhas.length === total ? `${total} contato${total === 1 ? '' : 's'}` : `Mostrando ${linhas.length} de ${total} contatos`;
      if (!estadoClientes.termo && total >= LIMITE_LISTA_CONTATOS) {
        texto += ` · a lista traz os primeiros ${LIMITE_LISTA_CONTATOS} em ordem alfabética — use a busca para encontrar os demais`;
      }
      rodape.textContent = texto;
    }
  }

  if (estadoClientes.detalheId) renderizarDetalheContato(mapa);
}

// ---------------- Menu de ações (⋯) ----------------
function abrirMenuContato(evento, id) {
  const menu = document.getElementById('contato-menu');
  const c = estadoClientes.lista.find((x) => x.id === id);
  if (!menu || !c) return;
  if (!menu.hidden && menu.dataset.id === String(id)) { fecharMenuContato(); return; }
  const nomeEsc = escapeHtml(c.nome).replace(/'/g, "\\'");
  menu.dataset.id = String(id);
  menu.innerHTML = `
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirDetalheContato(${id})">${icone('panel-right-open', 16)}Ver detalhes</button>
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirConversaPorTelefone('${c.telefone}', '${nomeEsc}')">${icone('message-square', 16)}Abrir conversa</button>
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirEditarContato(${id}, '${nomeEsc}', '${c.telefone}')">${icone('pencil', 16)}Editar contato</button>`;
  menu.hidden = false;
  const r = evento.currentTarget.getBoundingClientRect();
  const largura = menu.offsetWidth || 220;
  const altura = menu.offsetHeight || 130;
  const cabeEmbaixo = r.bottom + 6 + altura < window.innerHeight;
  menu.style.top = `${cabeEmbaixo ? r.bottom + 6 : r.top - altura - 6}px`;
  menu.style.left = `${Math.max(8, r.right - largura)}px`;
  document.querySelectorAll('.dt-menu-btn.is-open').forEach((b) => b.classList.remove('is-open'));
  evento.currentTarget.classList.add('is-open');
}
function fecharMenuContato() {
  const menu = document.getElementById('contato-menu');
  if (menu && !menu.hidden) { menu.hidden = true; menu.dataset.id = ''; }
  document.querySelectorAll('.dt-menu-btn.is-open').forEach((b) => b.classList.remove('is-open'));
}
document.addEventListener('click', (e) => { if (!e.target.closest('#contato-menu') && !e.target.closest('.dt-menu-btn')) fecharMenuContato(); });
window.addEventListener('scroll', fecharMenuContato, true);
window.addEventListener('resize', fecharMenuContato);

// ---------------- Painel lateral ----------------
function abrirDetalheContato(id) {
  estadoClientes.detalheId = id;
  estadoClientes.assinatura = '';
  estadoClientes.htmlDetalhe = estadoClientes.htmlAcoes = '';
  desenharTabelaClientes();
  const drawer = document.getElementById('contato-drawer');
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('contato-drawer-overlay').classList.add('is-open');
}
function fecharDetalheContato() {
  estadoClientes.detalheId = null;
  const drawer = document.getElementById('contato-drawer');
  if (drawer) { drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true'); }
  const overlay = document.getElementById('contato-drawer-overlay');
  if (overlay) overlay.classList.remove('is-open');
  document.querySelectorAll('#contatos-lista .dt-row.is-selected').forEach((r) => r.classList.remove('is-selected'));
}

function renderizarDetalheContato(mapa) {
  const c = estadoClientes.lista.find((x) => x.id === estadoClientes.detalheId)
    || estadoClientes.base.find((x) => x.id === estadoClientes.detalheId);
  if (!c) return;
  const conversa = (mapa || mapaConversasPorTelefone()).get(chaveTelefone(c.telefone)) || null;
  const s = situacaoContato(conversa);
  const ui = SITUACAO_CONTATO_UI[s] || SITUACAO_CONTATO_UI.sem_atendimento;
  const telFmt = formatarTelefone(c.telefone);
  const resp = conversa ? nomeVendedor(conversa.vendedor_id) : '';
  const cadastradoPor = nomeVendedor(c.criado_por);
  const campo = (iconeNome, rotulo, valor) => `
    <div class="drawer-field">
      <span class="drawer-field-label">${icone(iconeNome, 15)}${rotulo}</span>
      <span class="drawer-field-value">${valor}</span>
    </div>`;

  let ultimaHtml = '<div class="drawer-empty">Nenhuma conversa recente com este cliente.</div>';
  if (conversa) {
    const msg = conversa.ultima_mensagem;
    const texto = msg ? msg.texto : conversa.primeira_mensagem;
    const previa = String(texto || '').replace(/^\*(.+?):\*\n/, '$1: ');
    const autor = msg ? (msg.remetente === 'cliente' ? c.nome : msg.remetente === 'ia' ? 'IA' : 'Equipe') : c.nome;
    const quando = dataContato(msg ? msg.criado_em : conversa.criado_em);
    ultimaHtml = `
      <div class="drawer-quote">
        <div class="drawer-quote-head"><span>${escapeHtml(autor)}</span><span>${quandoCurto(quando)}</span></div>
        <div class="drawer-quote-text">${previewComIcone(previa)}</div>
      </div>`;
  }

  const conteudo = `
    <div class="drawer-profile">
      <span class="dt-avatar dt-avatar--lg" style="background:${corAvatar(c.id)};">${escapeHtml(iniciais(c.nome))}</span>
      <div class="drawer-profile-text">
        <h2 class="drawer-title">${escapeHtml(c.nome)}</h2>
        <span class="drawer-subtitle">${escapeHtml(telFmt)}</span>
      </div>
    </div>
    <div class="drawer-badges"><span class="ui-badge ${ui.badge}">${ui.rotulo}</span></div>
    <div class="drawer-fields">
      ${campo('phone', 'Telefone', escapeHtml(telFmt))}
      ${campo('users', 'Responsável', resp ? escapeHtml(resp) : '<span class="dt-muted">Sem responsável</span>')}
      ${c.criado_em ? campo('calendar-days', 'Cadastrado em', quandoCurto(dataContato(c.criado_em))) : ''}
      ${cadastradoPor ? campo('user-round', 'Cadastrado por', escapeHtml(cadastradoPor)) : ''}
    </div>
    <div class="drawer-section">
      <h3 class="drawer-section-title">Última conversa</h3>
      ${ultimaHtml}
    </div>`;
  if (estadoClientes.htmlDetalhe !== conteudo) {
    estadoClientes.htmlDetalhe = conteudo;
    document.getElementById('contato-drawer-conteudo').innerHTML = conteudo;
  }

  const nomeEsc = escapeHtml(c.nome).replace(/'/g, "\\'");
  const acoes = `
    <button type="button" class="ui-btn ui-btn--secondary" onclick="abrirEditarContato(${c.id}, '${nomeEsc}', '${c.telefone}')">${icone('pencil', 16)}Editar contato</button>
    <button type="button" class="ui-btn ui-btn--primary" onclick="abrirConversaDoContato('${c.telefone}', '${nomeEsc}')">${icone('message-square', 16)}Abrir conversa</button>`;
  if (estadoClientes.htmlAcoes !== acoes) {
    estadoClientes.htmlAcoes = acoes;
    document.getElementById('contato-drawer-acoes').innerHTML = acoes;
  }
}

function abrirConversaDoContato(telefone, nome) {
  fecharDetalheContato();
  abrirConversaPorTelefone(telefone, nome);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  fecharMenuContato();
  if (estadoClientes.detalheId) fecharDetalheContato();
});
