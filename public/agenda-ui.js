// agenda-ui.js
// Apresentação da Agenda (Etapa 2). SÓ INTERFACE: recebe a lista que o
// carregarLembretes() do app.js já buscou em /api/lembretes e decide como
// mostrar — indicadores, filtro, busca, agrupamento e painel de detalhes.
// As ações continuam sendo as funções de sempre do app.js:
// concluirLembrete(), abrirConversa() e abrirNovaTarefa().

const estadoAgenda = {
  lista: [],      // última resposta do servidor (pendentes + concluídas nas últimas 24h)
  busca: '',
  assinatura: '',
  detalheId: null,
};

// ---------------- Classificação (derivada de feito/quando) ----------------
function dataDoLembrete(l) {
  return new Date(l.quando);
}
function mesmoDia(a, b) {
  return a.toDateString() === b.toDateString();
}
function situacaoTarefa(l, agora = new Date()) {
  if (l.feito) return 'concluida';
  const quando = dataDoLembrete(l);
  if (quando < agora) return 'atrasada';
  if (mesmoDia(quando, agora)) return 'hoje';
  return 'agendada';
}
const SITUACAO_UI = {
  atrasada: { rotulo: 'Atrasada', badge: 'ui-badge--red' },
  hoje: { rotulo: 'Hoje', badge: 'ui-badge--orange' },
  agendada: { rotulo: 'Agendada', badge: '' },
  concluida: { rotulo: 'Concluída', badge: 'ui-badge--green' },
};

function ehTarefaDaIA(l) {
  return Boolean(l.titulo && l.titulo.startsWith('🤖'));
}
function tituloTarefa(l) {
  return (l.titulo || '').replace(/^🤖\s*/, '');
}
function nomeResponsavel(l) {
  if (!l.vendedor_id) return '—';
  if (usuarioAtual && l.vendedor_id === usuarioAtual.id) return 'Você';
  const v = (vendedoresCache || []).find((x) => x.id === l.vendedor_id);
  return v ? v.nome : '—';
}

function prazoCurto(l) {
  const d = dataDoLembrete(l);
  if (isNaN(d)) return '—';
  const agora = new Date();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const amanha = new Date(agora); amanha.setDate(agora.getDate() + 1);
  const ontem = new Date(agora); ontem.setDate(agora.getDate() - 1);
  if (mesmoDia(d, agora)) return `Hoje, ${hora}`;
  if (mesmoDia(d, amanha)) return `Amanhã, ${hora}`;
  if (mesmoDia(d, ontem)) return `Ontem, ${hora}`;
  const opcoes = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== agora.getFullYear()) opcoes.year = 'numeric';
  return `${d.toLocaleDateString('pt-BR', opcoes).replace('.', '')}, ${hora}`;
}
function dataPorExtenso(valor, somaZ) {
  if (!valor) return '—';
  const d = new Date(somaZ && !/Z|[+-]\d\d:?\d\d$/.test(valor) ? `${valor.replace(' ', 'T')}Z` : valor);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------- Filtro de status e busca ----------------
function passaNoFiltro(l, filtro, agora) {
  const s = situacaoTarefa(l, agora);
  if (filtro === 'pendentes') return !l.feito;
  if (filtro === 'hoje') return s === 'hoje';
  if (filtro === 'atrasadas') return s === 'atrasada';
  if (filtro === 'concluidas') return !!l.feito;
  return true; // todas
}
function passaNaBusca(l, termo) {
  if (termo.length < 2) return true;
  const digitos = termo.replace(/\D/g, '');
  const texto = `${tituloTarefa(l)} ${l.nome_cliente || ''} ${nomeResponsavel(l)}`.toLowerCase();
  return texto.includes(termo) || (digitos.length >= 2 && String(l.telefone || '').includes(digitos));
}

function filtrarAgenda(termo) {
  estadoAgenda.busca = (termo || '').trim().toLowerCase();
  estadoAgenda.assinatura = '';
  renderizarAgenda(estadoAgenda.lista);
}

// ---------------- Indicadores ----------------
function atualizarIndicadoresAgenda(lista) {
  const agora = new Date();
  const pendentes = lista.filter((l) => !l.feito);
  const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== String(v)) el.textContent = v; };
  set('agenda-kpi-pendentes', pendentes.length);
  set('agenda-kpi-hoje', pendentes.filter((l) => situacaoTarefa(l, agora) === 'hoje').length);
  set('agenda-kpi-atrasadas', pendentes.filter((l) => dataDoLembrete(l) < agora).length);
  set('agenda-kpi-concluidas', lista.filter((l) => l.feito).length);
}

// ---------------- Lista ----------------
const GRUPOS_AGENDA = [
  { chave: 'atrasada', titulo: 'Atrasadas' },
  { chave: 'hoje', titulo: 'Hoje' },
  { chave: 'agendada', titulo: 'Próximas' },
  { chave: 'concluida', titulo: 'Concluídas nas últimas 24h' },
];

function linhaTarefaHtml(l, agora) {
  const s = situacaoTarefa(l, agora);
  const ui = SITUACAO_UI[s];
  const nomeCliente = l.nome_cliente || l.telefone || '—';
  const daIA = ehTarefaDaIA(l);
  const categoria = daIA ? categoriaLembrete(l).label : '';
  const tipo = LABELS_TIPO[l.tipo] || '';
  const selecionada = estadoAgenda.detalheId === l.id ? 'is-selected' : '';
  return `
    <div class="task-row is-${s} ${selecionada}" role="row" data-id="${l.id}" tabindex="0"
      onclick="abrirDetalheTarefa(${l.id})" onkeydown="if(event.key==='Enter'){abrirDetalheTarefa(${l.id})}">
      <span class="tc-check" role="cell">
        <button type="button" class="task-checkbox ${l.feito ? 'is-checked' : ''}" ${l.feito ? 'disabled' : ''}
          onclick="event.stopPropagation(); ${l.feito ? '' : `concluirLembrete(${l.id})`}"
          title="${l.feito ? 'Concluída' : 'Marcar como concluída'}" aria-label="${l.feito ? 'Concluída' : 'Marcar como concluída'}">${icone('check', 12)}</button>
      </span>
      <span class="tc-titulo" role="cell">
        <span class="task-title">${escapeHtml(tituloTarefa(l))}</span>
        ${tipo ? `<span class="task-tipo">${escapeHtml(tipo)}</span>` : ''}
      </span>
      <span class="tc-cliente" role="cell">
        <span class="mini-avatar" style="background:${corAvatar(l.lead_id)};">${escapeHtml(iniciais(nomeCliente))}</span>
        <span class="cell-text">${escapeHtml(nomeCliente)}</span>
      </span>
      <span class="tc-resp" role="cell"><span class="cell-text">${escapeHtml(nomeResponsavel(l))}</span></span>
      <span class="tc-prazo" role="cell">${icone('calendar-clock', 14)}<span class="cell-text">${prazoCurto(l)}</span></span>
      <span class="tc-origem" role="cell">
        ${daIA
          ? `<span class="ui-badge ui-badge--brand" title="Criada pela IA · ${escapeHtml(categoria)}">${icone('sparkles', 12)}IA<span class="badge-sub">· ${escapeHtml(categoria)}</span></span>`
          : `<span class="ui-badge" title="Criada manualmente">${icone('user', 12)}Manual</span>`}
      </span>
      <span class="tc-status" role="cell">
        <span class="ui-badge ui-badge--dot ${ui.badge}">${ui.rotulo}</span>
        <button type="button" class="ui-icon-btn ui-icon-btn--sm task-row-acao" title="Abrir conversa" aria-label="Abrir conversa"
          onclick="event.stopPropagation(); abrirConversa(${l.lead_id})">${icone('message-square', 16)}</button>
      </span>
    </div>`;
}

function vazioAgendaHtml(filtro, buscando) {
  if (buscando) {
    return `<div class="task-empty">${icone('search', 22)}<strong>Nada encontrado</strong><span>Nenhuma tarefa corresponde à busca.</span></div>`;
  }
  const textos = {
    pendentes: ['Tudo em dia', 'Nenhuma tarefa pendente.'],
    hoje: ['Dia livre', 'Nenhuma tarefa para hoje.'],
    atrasadas: ['Nada atrasado', 'Nenhuma tarefa passou do prazo.'],
    concluidas: ['Nada concluído ainda', 'Nenhuma tarefa concluída nas últimas 24h.'],
    todas: ['Sem tarefas', 'Nenhuma tarefa ainda.'],
  };
  const [titulo, texto] = textos[filtro] || textos.todas;
  return `<div class="task-empty">${icone('list-todo', 22)}<strong>${titulo}</strong><span>${texto}</span></div>`;
}

function renderizarAgenda(lista) {
  estadoAgenda.lista = Array.isArray(lista) ? lista : [];
  atualizarIndicadoresAgenda(estadoAgenda.lista);

  const el = document.getElementById('lembretes');
  if (!el) return;
  const agora = new Date();
  const filtro = abaAgendaAtual;
  const termo = estadoAgenda.busca;
  const visiveis = estadoAgenda.lista.filter((l) => passaNoFiltro(l, filtro, agora) && passaNaBusca(l, termo));

  // Só repinta quando algo muda de verdade (ou vira o minuto — "Hoje" e
  // "Atrasada" dependem da hora). Evita piscar a lista no refresh de 3s.
  const assinatura = [filtro, termo, Math.floor(Date.now() / 60000), estadoAgenda.detalheId,
    (vendedoresCache || []).length,
    visiveis.map((l) => `${l.id}~${l.feito}~${l.quando}~${l.titulo}~${l.vendedor_id}`).join('|')].join('#');
  if (assinatura !== estadoAgenda.assinatura) {
    estadoAgenda.assinatura = assinatura;
    if (visiveis.length === 0) {
      el.innerHTML = vazioAgendaHtml(filtro, termo.length >= 2);
    } else {
      // Pendentes: próximas primeiro por prazo; concluídas: mais recentes primeiro.
      const ordenadas = [...visiveis].sort((a, b) => (a.feito && b.feito)
        ? dataDoLembrete(b) - dataDoLembrete(a)
        : dataDoLembrete(a) - dataDoLembrete(b));
      el.innerHTML = GRUPOS_AGENDA.map((g) => {
        const itens = ordenadas.filter((l) => situacaoTarefa(l, agora) === g.chave);
        if (!itens.length) return '';
        return `<div class="task-group" role="rowgroup">
          <div class="task-group-head is-${g.chave}"><span>${g.titulo}</span><span class="ui-count">${itens.length}</span></div>
          ${itens.map((l) => linhaTarefaHtml(l, agora)).join('')}
        </div>`;
      }).join('');
    }
  }

  if (estadoAgenda.detalheId) renderizarDetalheTarefa();
}

// ---------------- Painel de detalhes ----------------
function abrirDetalheTarefa(id) {
  estadoAgenda.detalheId = id;
  estadoAgenda.assinatura = '';
  estadoAgenda.htmlDetalhe = estadoAgenda.htmlAcoes = '';
  renderizarAgenda(estadoAgenda.lista);
  const drawer = document.getElementById('tarefa-drawer');
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('tarefa-drawer-overlay').classList.add('is-open');
}

function fecharDetalheTarefa() {
  estadoAgenda.detalheId = null;
  const drawer = document.getElementById('tarefa-drawer');
  if (drawer) { drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true'); }
  const overlay = document.getElementById('tarefa-drawer-overlay');
  if (overlay) overlay.classList.remove('is-open');
  document.querySelectorAll('#lembretes .task-row.is-selected').forEach((r) => r.classList.remove('is-selected'));
}

let ultimaTarefaDetalhe = null;
function renderizarDetalheTarefa() {
  const encontrada = estadoAgenda.lista.find((l) => l.id === estadoAgenda.detalheId);
  // Concluída há mais de 24h some da API — mantém o último retrato na tela.
  const l = encontrada || (ultimaTarefaDetalhe && ultimaTarefaDetalhe.id === estadoAgenda.detalheId ? ultimaTarefaDetalhe : null);
  if (!l) return;
  ultimaTarefaDetalhe = l;

  const s = situacaoTarefa(l);
  const ui = SITUACAO_UI[s];
  const daIA = ehTarefaDaIA(l);
  const nomeCliente = l.nome_cliente || l.telefone || '—';
  const campo = (iconeNome, rotulo, valor) => `
    <div class="drawer-field">
      <span class="drawer-field-label">${icone(iconeNome, 15)}${rotulo}</span>
      <span class="drawer-field-value">${valor}</span>
    </div>`;

  const conteudo = `
    <h2 class="drawer-title">${escapeHtml(tituloTarefa(l))}</h2>
    <div class="drawer-badges">
      <span class="ui-badge ui-badge--dot ${ui.badge}">${ui.rotulo}</span>
      ${daIA
        ? `<span class="ui-badge ui-badge--brand">${icone('sparkles', 12)}IA · ${escapeHtml(categoriaLembrete(l).label)}</span>`
        : `<span class="ui-badge">${icone('user', 12)}Manual</span>`}
    </div>
    <div class="drawer-fields">
      ${campo('user', 'Cliente', `<span class="mini-avatar" style="background:${corAvatar(l.lead_id)};">${escapeHtml(iniciais(nomeCliente))}</span>${escapeHtml(nomeCliente)}`)}
      ${campo('phone', 'Telefone', escapeHtml(l.telefone || '—'))}
      ${campo('users', 'Responsável', escapeHtml(nomeResponsavel(l)))}
      ${campo('calendar-clock', 'Prazo', `<span class="${s === 'atrasada' ? 'txt-red' : ''}">${dataPorExtenso(l.quando, false)}</span>`)}
      ${campo('tag', 'Tipo', escapeHtml(LABELS_TIPO[l.tipo] || '—'))}
      ${l.criado_em ? campo('clock', 'Criada em', dataPorExtenso(l.criado_em, true)) : ''}
      ${l.feito && l.concluido_em ? campo('calendar-check', 'Concluída em', dataPorExtenso(l.concluido_em, true)) : ''}
    </div>`;
  // Compara com o último HTML gerado (o navegador reescreve o SVG ao serializar).
  if (estadoAgenda.htmlDetalhe !== conteudo) {
    estadoAgenda.htmlDetalhe = conteudo;
    document.getElementById('tarefa-drawer-conteudo').innerHTML = conteudo;
  }

  const acoes = `
    <button type="button" class="ui-btn ui-btn--secondary" onclick="abrirConversaDaTarefa(${l.lead_id})">${icone('message-square', 16)}Abrir conversa</button>
    ${l.feito
      ? `<span class="drawer-done">${icone('circle-check-big', 16)}Tarefa concluída</span>`
      : `<button type="button" class="ui-btn ui-btn--primary" onclick="concluirLembrete(${l.id})">${icone('check', 16)}Marcar como concluída</button>`}`;
  if (estadoAgenda.htmlAcoes !== acoes) {
    estadoAgenda.htmlAcoes = acoes;
    document.getElementById('tarefa-drawer-acoes').innerHTML = acoes;
  }
}

function abrirConversaDaTarefa(leadId) {
  fecharDetalheTarefa();
  abrirConversa(leadId);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && estadoAgenda.detalheId) fecharDetalheTarefa();
});
