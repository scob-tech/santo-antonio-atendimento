// atalhos-vendas.js
// Atalhos do composer que só aparecem no setor Vendas: um clique manda os
// dados de pagamento (PIX/conta), e o botão de localização abre a lista de
// lojas e galpões pra mandar o endereço do escolhido. O envio usa a mesma
// rota do campo de texto (POST /api/leads/:id/mensagens).
//
// Os dados NÃO ficam no código: o admin cadastra em Configurações
// ("Pagamento e endereços"), e o servidor guarda (GET /api/atalhos-vendas).
// O composer busca de novo a cada clique, pra sempre mandar o dado atual.

const TIPOS_CHAVE_PIX = ['CNPJ', 'CPF', 'E-mail', 'Telefone', 'Chave aleatória'];

async function buscarAtalhosVendas() {
  const res = await fetch(`${API}/api/atalhos-vendas`);
  if (!res.ok) throw new Error('falha ao carregar');
  return res.json();
}

function textoDadosPagamento(p) {
  return [
    `*${p.favorecido}*`,
    `PIX${p.tipo_chave ? ` (${p.tipo_chave})` : ''}: ${p.chave_pix}`,
    p.banco ? `Banco: ${p.banco}` : '',
    p.agencia ? `Agência: ${p.agencia}` : '',
    p.conta ? `Conta: ${p.conta}` : '',
  ].filter(Boolean).join('\n');
}

// Link de busca do Google Maps curto e legível (sem acento, + no espaço).
function linkMapa(endereco) {
  const q = endereco.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s,.-]/g, ' ').trim().replace(/\s+/g, '+');
  return `https://maps.google.com/?q=${q}`;
}

function textoEnderecoLoja(loja) {
  return `📍 *${loja.nome}*\n${loja.endereco}\n${linkMapa(loja.endereco)}`;
}

// Mostra os botões só no setor Vendas (chamado pelo app.js quando o setor
// muda) e fecha o painel de lojas se ele estiver aberto.
function atualizarAtalhosVendas() {
  const ehVendas = typeof setorAtivo !== 'undefined' && setorAtivo === 'vendas';
  ['btn-pix', 'btn-endereco'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = ehVendas ? '' : 'none';
  });
  if (!ehVendas) fecharPainelLojas();
}

// Envia um texto pronto na conversa aberta, com a mesma trava do envio
// normal pra não duplicar em clique repetido.
async function enviarTextoPronto(texto) {
  if (!leadConversaAtual || enviandoMensagem) return;
  enviandoMensagem = true;
  const btnEnviar = document.querySelector('.conversa-modal-reply button[type="submit"]');
  if (btnEnviar) btnEnviar.disabled = true;
  try {
    const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.erro || 'Erro ao enviar mensagem'); return; }
    const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
    leadConversaAtual = atualizado;
    marcarVistoConversaAberta();
    renderizarConversa(atualizado);
    carregarLeads();
  } finally {
    enviandoMensagem = false;
    if (btnEnviar) btnEnviar.disabled = false;
  }
}

async function enviarDadosPix() {
  fecharPainelLojas();
  if (!leadConversaAtual || enviandoMensagem) return;
  let dados;
  try { dados = await buscarAtalhosVendas(); } catch { alert('Não consegui carregar os dados de pagamento. Tente de novo.'); return; }
  if (!dados.pagamento) { alert('Os dados de pagamento ainda não foram cadastrados. O administrador cadastra em Configurações → Pagamento e endereços.'); return; }
  enviarTextoPronto(textoDadosPagamento(dados.pagamento));
}

// ---------------- Painel de lojas (endereço) ----------------
let lojasDoPainel = [];

async function alternarPainelLojas() {
  const p = document.getElementById('lojas-painel');
  if (p.style.display === 'block') { fecharPainelLojas(); return; }
  const e = document.getElementById('emoji-painel'); if (e) e.style.display = 'none';
  const f = document.getElementById('figurinhas-painel'); if (f) f.style.display = 'none';
  p.innerHTML = '<div class="lojas-painel-vazio">Carregando...</div>';
  p.style.display = 'block';
  document.getElementById('btn-endereco').setAttribute('aria-expanded', 'true');

  try { lojasDoPainel = (await buscarAtalhosVendas()).lojas || []; } catch { lojasDoPainel = null; }
  if (p.style.display !== 'block') return; // fechou enquanto carregava
  if (lojasDoPainel === null) { p.innerHTML = '<div class="lojas-painel-vazio">Não consegui carregar os endereços. Tente de novo.</div>'; return; }
  if (lojasDoPainel.length === 0) {
    p.innerHTML = '<div class="lojas-painel-vazio">Nenhum endereço cadastrado ainda. O administrador cadastra em Configurações → Pagamento e endereços.</div>';
    return;
  }
  p.innerHTML = `<div class="lojas-painel-titulo">Enviar endereço</div>` + lojasDoPainel.map((l, i) => `
    <button type="button" class="lojas-painel-item" onclick="enviarEnderecoLoja(${i})">
      ${icone('map-pin', 16)}
      <span><strong>${escapeHtml(l.nome)}${l.tipo === 'galpao' ? ' <span class="ui-badge ui-badge--quiet">Galpão</span>' : ''}</strong><small>${escapeHtml(l.endereco)}</small></span>
    </button>`).join('');
  const primeiro = p.querySelector('.lojas-painel-item');
  if (primeiro) primeiro.focus();
}

function fecharPainelLojas() {
  const p = document.getElementById('lojas-painel');
  if (p) p.style.display = 'none';
  const btn = document.getElementById('btn-endereco');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function enviarEnderecoLoja(indice) {
  const loja = lojasDoPainel && lojasDoPainel[indice];
  if (!loja) return;
  fecharPainelLojas();
  enviarTextoPronto(textoEnderecoLoja(loja));
}

// Fecha o painel ao clicar fora dele ou apertar Esc.
document.addEventListener('click', (ev) => {
  const p = document.getElementById('lojas-painel');
  if (!p || p.style.display !== 'block') return;
  if (p.contains(ev.target) || ev.target.closest('#btn-endereco')) return;
  fecharPainelLojas();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const p = document.getElementById('lojas-painel');
  if (!p || p.style.display !== 'block') return;
  fecharPainelLojas();
  const btn = document.getElementById('btn-endereco');
  if (btn) btn.focus();
});

// ---------------- Configurações (só admin, setor Vendas) ----------------
const estadoConfigAtalhos = { lojas: [], editandoLoja: null };

function dataHoraCurta(utc) {
  if (!utc) return '';
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function textoAtualizacao(item) {
  if (!item || !item.atualizado_em) return '';
  return `Atualizado${item.atualizado_por ? ` por ${item.atualizado_por}` : ''} em ${dataHoraCurta(item.atualizado_em)}`;
}

// Chamado pelo app.js ao montar a tela de Configurações pro admin em Vendas.
async function renderizarConfigAtalhos() {
  const card = document.getElementById('config-atalhos');
  if (!card) return;
  const pode = usuarioAtual && usuarioAtual.role === 'admin' && setorAtivo === 'vendas';
  card.style.display = pode ? 'block' : 'none';
  if (!pode) return;
  const sel = document.getElementById('pag-tipo_chave');
  if (sel && !sel.options.length) sel.innerHTML = TIPOS_CHAVE_PIX.map((t) => `<option value="${t}">${t}</option>`).join('');
  let dados;
  try { dados = await buscarAtalhosVendas(); } catch { return; }
  const p = dados.pagamento || {};
  ['favorecido', 'tipo_chave', 'chave_pix', 'banco', 'agencia', 'conta'].forEach((campo) => {
    const el = document.getElementById(`pag-${campo}`);
    if (el) el.value = p[campo] || (campo === 'tipo_chave' ? 'CNPJ' : '');
  });
  document.getElementById('pag-atualizacao').textContent = textoAtualizacao(dados.pagamento);
  atualizarPreviewPagamento();
  estadoConfigAtalhos.lojas = dados.lojas || [];
  renderizarListaLojasConfig();
}

function lerFormPagamento() {
  const dados = {};
  ['favorecido', 'tipo_chave', 'chave_pix', 'banco', 'agencia', 'conta'].forEach((campo) => {
    dados[campo] = document.getElementById(`pag-${campo}`).value.trim();
  });
  return dados;
}

function atualizarPreviewPagamento() {
  const dados = lerFormPagamento();
  const el = document.getElementById('pag-preview');
  el.textContent = dados.favorecido && dados.chave_pix ? textoDadosPagamento(dados) : 'Preencha o favorecido e a chave PIX para ver a mensagem.';
}

async function salvarDadosPagamento() {
  const msg = document.getElementById('pag-msg');
  msg.className = 'msg';
  msg.textContent = '';
  const res = await fetch(`${API}/api/config/pagamento`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lerFormPagamento()),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { msg.className = 'msg erro'; msg.textContent = d.erro || 'Erro ao salvar.'; return; }
  msg.className = 'msg ok';
  msg.textContent = 'Dados de pagamento salvos.';
  renderizarConfigAtalhos();
}

function renderizarListaLojasConfig() {
  const el = document.getElementById('lojas-config-lista');
  const lojas = estadoConfigAtalhos.lojas;
  el.innerHTML = lojas.length === 0
    ? '<div class="task-empty">Nenhuma loja ou galpão cadastrado.</div>'
    : lojas.map((l) => `
      <div class="settings-row">
        <span class="settings-row-icon">${icone('map-pin', 18)}</span>
        <div class="settings-row-text">
          <strong>${escapeHtml(l.nome)}${l.tipo === 'galpao' ? ' <span class="ui-badge ui-badge--quiet">Galpão</span>' : ''}</strong>
          <span>${escapeHtml(l.endereco)}</span>
          <span class="lojas-config-meta">${escapeHtml(textoAtualizacao(l))}</span>
        </div>
        <button type="button" class="ui-icon-btn ui-icon-btn--sm" onclick="abrirFormLoja(${l.id})" aria-label="Editar ${escapeHtml(l.nome)}" title="Editar">${icone('pencil', 16)}</button>
        <button type="button" class="ui-icon-btn ui-icon-btn--sm" onclick="excluirLoja(${l.id})" aria-label="Remover ${escapeHtml(l.nome)}" title="Remover">${icone('trash-2', 16)}</button>
      </div>`).join('');
}

function abrirFormLoja(id) {
  const loja = id ? estadoConfigAtalhos.lojas.find((l) => l.id === id) : null;
  estadoConfigAtalhos.editandoLoja = loja ? loja.id : null;
  document.getElementById('loja-form-titulo').textContent = loja ? `Editar ${loja.nome}` : 'Nova loja ou galpão';
  document.getElementById('loja-nome').value = loja ? loja.nome : '';
  document.getElementById('loja-tipo').value = loja ? loja.tipo : 'loja';
  document.getElementById('loja-endereco').value = loja ? loja.endereco : '';
  document.getElementById('loja-msg').textContent = '';
  document.getElementById('loja-form').hidden = false;
  document.getElementById('btn-nova-loja').hidden = true;
  document.getElementById('loja-nome').focus();
}

function fecharFormLoja() {
  estadoConfigAtalhos.editandoLoja = null;
  document.getElementById('loja-form').hidden = true;
  document.getElementById('btn-nova-loja').hidden = false;
}

async function salvarLoja() {
  const msg = document.getElementById('loja-msg');
  msg.className = 'msg';
  msg.textContent = '';
  const id = estadoConfigAtalhos.editandoLoja;
  const corpo = {
    nome: document.getElementById('loja-nome').value.trim(),
    tipo: document.getElementById('loja-tipo').value,
    endereco: document.getElementById('loja-endereco').value.trim(),
  };
  const res = await fetch(`${API}/api/lojas${id ? `/${id}` : ''}`, {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { msg.className = 'msg erro'; msg.textContent = d.erro || 'Erro ao salvar.'; return; }
  fecharFormLoja();
  renderizarConfigAtalhos();
}

async function excluirLoja(id) {
  const loja = estadoConfigAtalhos.lojas.find((l) => l.id === id);
  if (!loja || !confirm(`Remover "${loja.nome}" da lista de endereços?`)) return;
  const res = await fetch(`${API}/api/lojas/${id}`, { method: 'DELETE' });
  if (!res.ok) { alert('Não consegui remover. Tente de novo.'); return; }
  if (estadoConfigAtalhos.editandoLoja === id) fecharFormLoja();
  renderizarConfigAtalhos();
}

atualizarAtalhosVendas();
