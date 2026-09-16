// configuracoes-ui.js
// Apresentação da tela Configurações (Etapa 5). SÓ INTERFACE: reaproveita
// o que o app.js já busca e já faz — lista da equipe (/api/vendedores),
// cadastrarVendedor(), abrirEdicaoCadastro(), abrirModalSenha(),
// excluirVendedor(), salvarSenhaConfig(), alternarNotificacoes(),
// alternarTema(), baixarBackup(), sair().

const CARGOS_UI = {
  admin: { rotulo: 'Administrador', badge: 'ui-badge--brand' },
  supervisor: { rotulo: 'Supervisor', badge: 'ui-badge--orange' },
  vendedor: { rotulo: 'Atendente', badge: '' },
};
function cargoUi(role) {
  return CARGOS_UI[role] || CARGOS_UI.vendedor;
}

const estadoConfig = { usuarios: [], assinatura: '', detalheId: null, htmlDetalhe: '', htmlAcoes: '' };

// ---------------- Usuários ----------------
function statusUsuarioHtml(v) {
  const n = v.leads_ativos || 0;
  return n > 0
    ? `<span class="ui-badge ui-badge--green ui-badge--dot">${n} em atendimento</span>`
    : '<span class="ui-badge ui-badge--quiet">Sem atendimento</span>';
}

function renderizarUsuariosConfig(vendedores) {
  estadoConfig.usuarios = Array.isArray(vendedores) ? vendedores : [];
  const el = document.getElementById('vendedores');
  if (!el) return;
  const ehAdmin = usuarioAtual && usuarioAtual.role === 'admin';
  const assinatura = [ehAdmin, estadoConfig.detalheId, estadoConfig.usuarios.map((v) => `${v.id}~${v.nome}~${v.login}~${v.role}~${v.leads_ativos}`).join('|')].join('#');
  if (assinatura !== estadoConfig.assinatura) {
    estadoConfig.assinatura = assinatura;
    el.innerHTML = estadoConfig.usuarios.map((v) => {
      const cargo = cargoUi(v.role);
      const voce = usuarioAtual && v.id === usuarioAtual.id ? '<span class="ui-badge ui-badge--quiet dt-tag">Você</span>' : '';
      return `
        <div class="dt-row ${estadoConfig.detalheId === v.id ? 'is-selected' : ''}" role="row" data-id="${v.id}" tabindex="0"
          onclick="abrirDetalheUsuario(${v.id})" onkeydown="if(event.key==='Enter'){abrirDetalheUsuario(${v.id})}">
          <span class="cu-usuario" role="cell">
            <span class="dt-avatar" style="background:${corAvatar(v.id)};">${escapeHtml(iniciais(v.nome))}</span>
            <span class="dt-stack">
              <span class="dt-primary">${escapeHtml(v.nome)}${voce}</span>
              <span class="dt-secondary">${v.login ? `@${escapeHtml(v.login)}` : '—'}</span>
            </span>
          </span>
          <span class="cu-cargo" role="cell"><span class="ui-badge ${cargo.badge}">${cargo.rotulo}</span></span>
          <span class="cu-status" role="cell">${statusUsuarioHtml(v)}</span>
          <span class="cc-acoes" role="cell">${ehAdmin
            ? `<button type="button" class="ui-icon-btn ui-icon-btn--sm dt-menu-btn" aria-haspopup="menu" aria-label="Ações de ${escapeHtml(v.nome)}"
                onclick="event.stopPropagation(); abrirMenuUsuario(event, ${v.id})">${icone('ellipsis', 18)}</button>`
            : ''}</span>
        </div>`;
    }).join('') || '<div class="task-empty">Nenhum usuário cadastrado.</div>';
  }
  if (estadoConfig.detalheId) renderizarDetalheUsuario();
}

// Menu ⋯ — usa o mesmo menu flutuante da tela Clientes (#contato-menu).
function abrirMenuUsuario(evento, id) {
  const menu = document.getElementById('contato-menu');
  const v = estadoConfig.usuarios.find((x) => x.id === id);
  if (!menu || !v) return;
  const chave = `usuario-${id}`;
  if (!menu.hidden && menu.dataset.id === chave) { fecharMenuContato(); return; }
  const nomeEsc = escapeHtml(v.nome).replace(/'/g, "\\'");
  menu.dataset.id = chave;
  menu.innerHTML = `
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirDetalheUsuario(${id})">${icone('panel-right-open', 16)}Ver detalhes</button>
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirEdicaoCadastro(${id})">${icone('pencil', 16)}Editar cadastro</button>
    <button type="button" class="chat-menu-item" role="menuitem" onclick="fecharMenuContato(); abrirModalSenha(${id}, '${nomeEsc}')">${icone('key-round', 16)}Redefinir senha</button>
    <div class="chat-menu-sep"></div>
    <button type="button" class="chat-menu-item chat-menu-item--danger" role="menuitem" onclick="fecharMenuContato(); excluirVendedor(${id}, '${nomeEsc}')">${icone('trash-2', 16)}Excluir usuário</button>`;
  menu.hidden = false;
  const r = evento.currentTarget.getBoundingClientRect();
  const largura = menu.offsetWidth || 220;
  const altura = menu.offsetHeight || 180;
  const cabeEmbaixo = r.bottom + 6 + altura < window.innerHeight;
  menu.style.top = `${cabeEmbaixo ? r.bottom + 6 : r.top - altura - 6}px`;
  menu.style.left = `${Math.max(8, r.right - largura)}px`;
  document.querySelectorAll('.dt-menu-btn.is-open').forEach((b) => b.classList.remove('is-open'));
  evento.currentTarget.classList.add('is-open');
}

// ---------------- Drawer: detalhes do usuário ----------------
function abrirDrawer(id) {
  const drawer = document.getElementById(id);
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById(`${id}-overlay`).classList.add('is-open');
}
function fecharDrawer(id) {
  const drawer = document.getElementById(id);
  if (drawer) { drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true'); }
  const overlay = document.getElementById(`${id}-overlay`);
  if (overlay) overlay.classList.remove('is-open');
}

function abrirDetalheUsuario(id) {
  estadoConfig.detalheId = id;
  estadoConfig.assinatura = '';
  estadoConfig.htmlDetalhe = estadoConfig.htmlAcoes = '';
  renderizarUsuariosConfig(estadoConfig.usuarios);
  abrirDrawer('usuario-drawer');
}
function fecharDetalheUsuario() {
  estadoConfig.detalheId = null;
  fecharDrawer('usuario-drawer');
  document.querySelectorAll('#vendedores .dt-row.is-selected').forEach((r) => r.classList.remove('is-selected'));
}

function renderizarDetalheUsuario() {
  const v = estadoConfig.usuarios.find((x) => x.id === estadoConfig.detalheId);
  if (!v) { fecharDetalheUsuario(); return; } // excluído
  const cargo = cargoUi(v.role);
  const ehAdmin = usuarioAtual && usuarioAtual.role === 'admin';
  const setores = (v.setores || []).map((s) => NOMES_SETOR[s] || s).join(', ') || '—';
  const campo = (iconeNome, rotulo, valor) => `
    <div class="drawer-field">
      <span class="drawer-field-label">${icone(iconeNome, 15)}${rotulo}</span>
      <span class="drawer-field-value">${valor}</span>
    </div>`;
  const conteudo = `
    <div class="drawer-profile">
      <span class="dt-avatar dt-avatar--lg" style="background:${corAvatar(v.id)};">${escapeHtml(iniciais(v.nome))}</span>
      <div class="drawer-profile-text">
        <h2 class="drawer-title">${escapeHtml(v.nome)}</h2>
        <span class="drawer-subtitle">${v.login ? `@${escapeHtml(v.login)}` : ''}</span>
      </div>
    </div>
    <div class="drawer-badges"><span class="ui-badge ${cargo.badge}">${cargo.rotulo}</span>${statusUsuarioHtml(v)}</div>
    <div class="drawer-fields">
      ${campo('user-round', 'Login', v.login ? escapeHtml(v.login) : '—')}
      ${campo('shield', 'Nível de acesso', cargo.rotulo)}
      ${campo('message-square', 'Atendimentos ativos', String(v.leads_ativos || 0))}
      ${campo('inbox', 'Setor', escapeHtml(setores))}
    </div>`;
  if (estadoConfig.htmlDetalhe !== conteudo) {
    estadoConfig.htmlDetalhe = conteudo;
    document.getElementById('usuario-drawer-conteudo').innerHTML = conteudo;
  }
  const nomeEsc = escapeHtml(v.nome).replace(/'/g, "\\'");
  const acoes = ehAdmin ? `
    <button type="button" class="ui-btn ui-btn--danger drawer-foot-start" onclick="excluirVendedor(${v.id}, '${nomeEsc}')">${icone('trash-2', 16)}Excluir</button>
    <button type="button" class="ui-btn ui-btn--secondary" onclick="abrirModalSenha(${v.id}, '${nomeEsc}')">${icone('key-round', 16)}Redefinir senha</button>
    <button type="button" class="ui-btn ui-btn--primary" onclick="abrirEdicaoCadastro(${v.id})">${icone('pencil', 16)}Editar cadastro</button>` : '';
  if (estadoConfig.htmlAcoes !== acoes) {
    estadoConfig.htmlAcoes = acoes;
    document.getElementById('usuario-drawer-acoes').innerHTML = acoes;
  }
}

// ---------------- Drawer: cadastrar usuário ----------------
function abrirCadastroUsuario() {
  const msg = document.getElementById('cadastro-msg');
  if (msg) { msg.textContent = ''; msg.className = 'msg'; }
  // Com um setor só, o campo de setor não tem escolha a fazer — fica oculto
  // (a caixa do setor atual continua marcada e segue no cadastro).
  const campoSetores = document.getElementById('c-setores-campo');
  if (campoSetores) campoSetores.hidden = (setoresDisponiveis || []).length <= 1;
  abrirDrawer('cadastro-drawer');
  setTimeout(() => { const n = document.getElementById('c-nome'); if (n) n.focus(); }, 250);
}
function fecharCadastroUsuario() {
  fecharDrawer('cadastro-drawer');
}

// ---------------- Sessão atual ----------------
function renderizarSessaoConfig() {
  const el = document.getElementById('config-sessao');
  if (!el || !usuarioAtual) return;
  const cargo = cargoUi(usuarioAtual.role);
  el.innerHTML = `
    <span class="dt-avatar" style="background:var(--brand);">${escapeHtml(iniciais(usuarioAtual.nome))}</span>
    <span class="settings-row-text">
      <strong>${escapeHtml(usuarioAtual.nome)}</strong>
      <span>${cargo.rotulo}${usuarioAtual.login ? ` · @${escapeHtml(usuarioAtual.login)}` : ''} · conectado neste navegador</span>
    </span>
    <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" onclick="sair()">${icone('log-out', 16)}Sair</button>`;
}

// ---------------- Notificações (estado do switch) ----------------
const TEXTOS_NOTIFICACAO = {
  ativo: 'Ativadas neste aparelho. Você recebe aviso de novas conversas e mensagens.',
  inativo: 'Receba aviso de novas conversas e mensagens, mesmo com o sistema fechado.',
  ativando: 'Ativando…',
  bloqueado: 'Bloqueadas pelo navegador. Para reativar, libere as notificações deste site nas configurações do navegador.',
  indisponivel: 'Este navegador não suporta notificações. No iPhone, use "Adicionar à Tela de Início" pelo Safari.',
};
function definirEstadoNotificacao(estado, titulo) {
  document.querySelectorAll('.btn-notificacoes-el').forEach((btn) => {
    btn.setAttribute('aria-checked', estado === 'ativo' ? 'true' : 'false');
    btn.dataset.estado = estado;
    btn.disabled = estado === 'indisponivel';
    if (titulo) btn.title = titulo;
  });
  const desc = document.getElementById('notif-descricao');
  if (desc && TEXTOS_NOTIFICACAO[estado]) desc.textContent = TEXTOS_NOTIFICACAO[estado];
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (estadoConfig.detalheId) fecharDetalheUsuario();
  fecharCadastroUsuario();
});
