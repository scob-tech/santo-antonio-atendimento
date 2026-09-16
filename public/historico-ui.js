// historico-ui.js
// Apresentação da tela Histórico (Etapa 4). SÓ INTERFACE:
// - a lista usa os leads que carregarConversasAtivas()/carregarHistorico()
//   do app.js já buscam (encerradas dos últimos 2 dias; busca = qualquer data);
// - a conversa é o MESMO painel da Central de Atendimento (#modal-conversa),
//   movido para esta tela — reabrir, polling e mídia seguem a lógica de sempre;
// - "Exportar" gera um .txt com as mensagens já carregadas na tela.

let periodoHistorico = '24h';

const PERIODOS_HISTORICO = {
  '24h': 'Encerradas nas últimas 24h',
  hoje: 'Encerradas hoje',
  ontem: 'Encerradas ontem',
  '48h': 'Encerradas nas últimas 48h',
};

function dataUtc(valor) {
  if (!valor) return null;
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(valor) ? valor : `${String(valor).replace(' ', 'T')}Z`);
  return isNaN(d) ? null : d;
}

function passaNoPeriodoHistorico(data, periodo, agora = new Date()) {
  if (!data) return false;
  const horas = (agora - data) / 3600000;
  if (periodo === 'hoje') return data.toDateString() === agora.toDateString();
  if (periodo === 'ontem') {
    const ontem = new Date(agora); ontem.setDate(agora.getDate() - 1);
    return data.toDateString() === ontem.toDateString();
  }
  if (periodo === '48h') return horas <= 48;
  return horas <= 24;
}

function dataCurtaHistorico(d) {
  if (!d) return '';
  const agora = new Date();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const ontem = new Date(agora); ontem.setDate(agora.getDate() - 1);
  if (d.toDateString() === agora.toDateString()) return hora;
  if (d.toDateString() === ontem.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ---------------- Lista ----------------
function renderizarItemHistorico(l) {
  const nome = l.nome_cliente || l.telefone;
  const texto = l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem;
  const previa = String(texto || '').replace(/^\*(.+?):\*\n/, '$1: ');
  const encerrada = dataUtc(l.encerrado_em) || dataUtc(l.ultima_mensagem && l.ultima_mensagem.criado_em);
  const atendente = l.vendedor_nome
    ? `<span class="ui-badge" title="Atendente responsável">${icone('user', 12)}${escapeHtml(l.vendedor_nome)}</span>`
    : '<span class="ui-badge ui-badge--quiet">Sem atendente</span>';
  return `
    <li class="conv-item conv-item--historico" data-id="${l.id}" onclick="abrirConversa(${l.id})">
      <div class="conv-avatar" style="background:${corAvatar(l.id)};">${escapeHtml(iniciais(nome))}</div>
      <div class="conv-main">
        <div class="item-row"><span class="conv-name">${escapeHtml(nome)}</span><span class="conv-time" title="Encerrada em ${encerrada ? encerrada.toLocaleString('pt-BR') : '—'}">${dataCurtaHistorico(encerrada)}</span></div>
        <div class="item-row"><p class="conv-preview">${previewComIcone(previa)}</p></div>
        <div class="item-badges">${atendente}</div>
      </div>
    </li>`;
}

function definirCabecalhoListaHistorico(titulo, quantidade) {
  const t = document.getElementById('historico-secao-titulo');
  const c = document.getElementById('historico-count');
  if (t && t.textContent !== titulo) t.textContent = titulo;
  if (c && c.textContent !== String(quantidade)) c.textContent = quantidade;
}

let assinaturaListaHistorico = '';
// Recebe o retorno de /api/leads (em atendimento + encerradas recentes).
function renderizarListaHistorico(leads) {
  atualizarIndicadoresHistorico(leads);
  const el = document.getElementById('historico-lista');
  if (!el) return;
  const agora = new Date();
  const encerradas = (leads || [])
    .filter((l) => l.status === 'encerrado' && passaNoPeriodoHistorico(dataUtc(l.encerrado_em), periodoHistorico, agora))
    .sort((a, b) => dataUtc(b.encerrado_em) - dataUtc(a.encerrado_em));

  definirCabecalhoListaHistorico(PERIODOS_HISTORICO[periodoHistorico], encerradas.length);

  const assinatura = periodoHistorico + '#' + encerradas.map((l) => `${l.id}~${l.encerrado_em}~${l.vendedor_nome}~${((l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem) || '').slice(0, 30)}`).join('|');
  if (assinatura === assinaturaListaHistorico && (encerradas.length === 0 || el.querySelector('.conv-item'))) return;
  assinaturaListaHistorico = assinatura;

  const vazio = {
    '24h': 'Nenhuma conversa encerrada nas últimas 24h.',
    hoje: 'Nenhuma conversa encerrada hoje.',
    ontem: 'Nenhuma conversa encerrada ontem.',
    '48h': 'Nenhuma conversa encerrada nas últimas 48h.',
  }[periodoHistorico];
  el.innerHTML = encerradas.length
    ? encerradas.map(renderizarItemHistorico).join('')
    : `<li class="empty-state">${vazio} Use a busca para encontrar conversas mais antigas.</li>`;
}

// Resultado da busca (qualquer data) — chamado por carregarHistorico().
function renderizarBuscaHistorico(encerradas) {
  const el = document.getElementById('historico-lista');
  if (!el) return;
  assinaturaListaHistorico = '';
  definirCabecalhoListaHistorico('Resultados da busca', encerradas.length);
  el.innerHTML = encerradas.length
    ? encerradas.map(renderizarItemHistorico).join('')
    : '<li class="empty-state">Nenhuma conversa encerrada encontrada.</li>';
}

function aoBuscarHistorico(valor) {
  const buscando = (valor || '').trim().length >= 2;
  const periodos = document.getElementById('historico-periodos');
  if (periodos) periodos.classList.toggle('is-disabled', buscando);
}

function mudarPeriodoHistorico(periodo) {
  periodoHistorico = periodo;
  document.querySelectorAll('#historico-periodos .ui-segmented-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.periodo === periodo);
  });
  const busca = document.getElementById('busca-historico');
  if (busca && busca.value.trim().length >= 2) { busca.value = ''; aoBuscarHistorico(''); }
  assinaturaListaHistorico = '';
  renderizarListaHistorico(conversasRecentesCache);
}

// ---------------- Indicadores ----------------
function formatarDuracao(minutos) {
  if (!isFinite(minutos) || minutos < 0) return '—';
  if (minutos < 60) return `${Math.max(1, Math.round(minutos))} min`;
  const horas = minutos / 60;
  if (horas < 24) {
    const h = Math.floor(horas);
    const m = Math.round(minutos - h * 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const dias = horas / 24;
  return `${dias.toFixed(dias < 10 ? 1 : 0).replace('.', ',')} d`;
}

function atualizarIndicadoresHistorico(leads) {
  const agora = new Date();
  const encerradas = (leads || []).filter((l) => l.status === 'encerrado' && dataUtc(l.encerrado_em));
  const hoje = encerradas.filter((l) => passaNoPeriodoHistorico(dataUtc(l.encerrado_em), 'hoje', agora)).length;
  const duracoes = encerradas
    .filter((l) => passaNoPeriodoHistorico(dataUtc(l.encerrado_em), '48h', agora) && dataUtc(l.criado_em))
    .map((l) => (dataUtc(l.encerrado_em) - dataUtc(l.criado_em)) / 60000)
    .filter((m) => m >= 0);
  const media = duracoes.length ? duracoes.reduce((a, b) => a + b, 0) / duracoes.length : NaN;
  const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== String(v)) el.textContent = v; };
  set('historico-kpi-hoje', hoje);
  set('historico-kpi-tempo', duracoes.length ? formatarDuracao(media) : '—');
}

// ---------------- Painel de conversa compartilhado ----------------
// O painel é um só; ele mora na tela que está aberta (Histórico ou Atendimento).
function posicionarPainelConversa(view) {
  const painel = document.getElementById('modal-conversa');
  const slot = document.getElementById(view === 'historico' ? 'historico-chat-slot' : 'inicio-chat-slot');
  if (!painel || !slot || painel.parentElement === slot) return;
  slot.insertBefore(painel, slot.firstChild);
}

// "Reabrir" no cabeçalho acompanha exatamente a regra que o app.js já aplica
// ao botão de reabrir do rodapé (encerrada + quem pode agir).
function sincronizarReabrirHistorico() {
  const caixa = document.getElementById('conversa-acao-reabrir');
  const painel = document.getElementById('modal-conversa');
  if (!caixa || !painel) return;
  painel.classList.toggle('pode-reabrir', caixa.style.display !== 'none');
}

// ---------------- Exportar ----------------
function exportarConversaAtual() {
  const lead = leadConversaAtual;
  if (!lead || !Array.isArray(lead.mensagens)) return;
  const nomeCliente = lead.nome_cliente || lead.telefone;
  const atendente = typeof nomeVendedor === 'function' ? nomeVendedor(lead.vendedor_id) : '';
  const fmt = (v) => { const d = dataUtc(v); return d ? d.toLocaleString('pt-BR') : ''; };
  const status = { novo: 'Novo', em_atendimento: 'Em atendimento', encerrado: 'Encerrada' }[lead.status] || lead.status;

  const linhas = [
    `Conversa — ${nomeCliente}`,
    `Telefone: ${lead.telefone}`,
    atendente ? `Atendente: ${atendente}` : null,
    `Status: ${status}`,
    lead.criado_em ? `Início: ${fmt(lead.criado_em)}` : null,
    lead.encerrado_em ? `Encerrada em: ${fmt(lead.encerrado_em)}` : null,
    `Exportada em: ${new Date().toLocaleString('pt-BR')}`,
    '',
    '----------------------------------------',
    '',
  ].filter((l) => l !== null);

  let diaAtual = '';
  lead.mensagens.forEach((m) => {
    const d = dataUtc(m.criado_em);
    const dia = d ? d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    if (dia && dia !== diaAtual) {
      if (diaAtual) linhas.push('');
      linhas.push(`— ${dia} —`);
      diaAtual = dia;
    }
    let texto = String(m.texto || '');
    let autor = m.remetente === 'cliente' ? nomeCliente : m.remetente === 'ia' ? 'IA' : 'Equipe';
    const prefixo = texto.match(/^\*(.+?):\*\n/);
    if (prefixo && m.remetente !== 'cliente') { autor = prefixo[1]; texto = texto.slice(prefixo[0].length); }
    if (m.apagada) texto = '(mensagem apagada)';
    if (m.midia_tipo && m.midia_tipo !== 'contato' && !/^\[/.test(texto)) texto = `[${m.midia_tipo}${m.midia_nome ? `: ${m.midia_nome}` : ''}] ${texto}`;
    const hora = d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    linhas.push(`[${hora}] ${autor}: ${texto}${m.editada && !m.apagada ? ' (editada)' : ''}`);
  });

  const blob = new Blob([linhas.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = String(nomeCliente).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cliente';
  a.href = url;
  a.download = `conversa-${base}-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

(function observarReabrir() {
  const caixa = document.getElementById('conversa-acao-reabrir');
  if (caixa) new MutationObserver(sincronizarReabrirHistorico).observe(caixa, { attributes: true, attributeFilter: ['style'] });
  const lista = document.getElementById('historico-lista');
  if (lista) new MutationObserver(() => marcarItemSelecionado()).observe(lista, { childList: true });
})();
